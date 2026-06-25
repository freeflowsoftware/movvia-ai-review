import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { WalkthroughResult, WalkthroughChange, WalkthroughEffort } from './types.js';
import type { ChatRunner } from './run-agent.js';

export const WALKTHROUGH_MARKER = '<!-- movvia-ai-review:walkthrough -->';

/** Lê walkthrough.model de defaults.yml (espelha readVerifyConfig). undefined quando ausente. */
export function readWalkthroughModel(configPath: string): string | undefined {
  let parsed: { walkthrough?: { model?: string } } | null;
  try {
    parsed = parseYaml(readFileSync(configPath, 'utf8')) as
      | { walkthrough?: { model?: string } }
      | null;
  } catch {
    // Config ausente, ilegível ou YAML inválido: sem override — o CLI cai no DEFAULT_MODEL.
    // Sem este catch, um defaults.yml faltante derrubava a CLI inteira com ENOENT.
    return undefined;
  }
  const model = parsed?.walkthrough?.model;
  return typeof model === 'string' && model.length > 0 ? model : undefined;
}

const EFFORT_LABELS: Record<number, { label: string; minutes: number }> = {
  1: { label: 'Trivial', minutes: 5 },
  2: { label: 'Simple', minutes: 10 },
  3: { label: 'Medium', minutes: 20 },
  4: { label: 'Complex', minutes: 45 },
  5: { label: 'Very Complex', minutes: 90 },
};

const SYSTEM_PROMPT = `Você é um assistente de code review da Movvia.
Sua tarefa: analisar o diff de um Pull Request e gerar um walkthrough estruturado.

Retorne EXCLUSIVAMENTE um objeto JSON válido (sem markdown externo, sem explicação adicional):

{
  "walkthrough": "<1-3 frases descrevendo o que o PR faz e por quê>",
  "changes": [
    {
      "layer": "<nome da camada ou responsabilidade lógica>",
      "files": ["<arquivo1>", "<arquivo2>"],
      "summary": "<descrição objetiva do que mudou nesta camada>"
    }
  ],
  "diagrams": ["<string Mermaid sequenceDiagram, sem os \`\`\` fences>"],
  "effort": {
    "score": <1-5>,
    "label": "<Trivial|Simple|Medium|Complex|Very Complex>",
    "minutes": <estimativa realista em minutos>
  }
}

Regras:
- walkthrough: síntese objetiva, 1-3 frases, explique o QUÊ e o PORQUÊ.
- changes: agrupe por RESPONSABILIDADE LÓGICA (ex: "Templates de notificação", "Serviço de pagamento"), nunca por arquivo isolado. Cada grupo deve ter 1-5 arquivos.
- diagrams: inclua SOMENTE quando há fluxo de chamadas relevante (método A chama B, que chama C). Use sequenceDiagram. Array vazio se não houver.
- effort.score: 1=Trivial (typo/config), 2=Simple (<50 linhas, 1 responsabilidade), 3=Medium (múltiplas responsabilidades), 4=Complex (fluxo crítico, muitas camadas), 5=Very Complex (arquitetura, risco alto).
- effort.label: exatamente um de "Trivial", "Simple", "Medium", "Complex", "Very Complex".
- effort.minutes: 5, 10, 20, 45 ou 90 para scores 1–5 respectivamente.`;

// Cap por chars (proxy barato de tokens) para o diff. PR gigante estouraria o context
// window do Flash-Lite -> JSON truncado -> fallback inutil. ~120k chars ≈ ~30k tokens,
// folgado para Flash-Lite. Configuravel por env LLM_MAX_DIFF_CHARS.
const DEFAULT_MAX_DIFF_CHARS = 120_000;

function maxDiffChars(): number {
  const raw = Number(process.env.LLM_MAX_DIFF_CHARS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_DIFF_CHARS;
}

function truncateDiff(diff: string): string {
  const cap = maxDiffChars();
  if (diff.length <= cap) return diff;
  return `${diff.slice(0, cap)}\n... [diff truncado: ${cap} de ${diff.length} chars] ...`;
}

export function buildWalkthroughPrompts(
  diff: string,
  contextPack?: string,
  prTitle?: string,
): { system: string; user: string } {
  const parts: string[] = [];
  if (prTitle) parts.push(`## Título do PR\n${prTitle}`);
  if (contextPack) parts.push(`## Contexto do codebase\n${contextPack}`);
  parts.push(`## Diff do PR\n\`\`\`diff\n${truncateDiff(diff)}\n\`\`\``);
  return { system: SYSTEM_PROMPT, user: parts.join('\n\n') };
}

function extractJsonFromRaw(raw: string): string | null {
  // Prefere fence ```json explícita
  const jsonFenceMatch = /```json\n([\s\S]*?)```/.exec(raw);
  if (jsonFenceMatch?.[1]) {
    const sliced = sliceBraces(jsonFenceMatch[1]);
    if (sliced) return sliced;
  }
  // Fallback: primeira cerca com chaves válidas
  const fenceMatches = [...raw.matchAll(/```\w*\n([\s\S]*?)```/g)];
  for (const m of fenceMatches) {
    const sliced = sliceBraces(m[1] ?? '');
    if (sliced) return sliced;
  }
  return sliceBraces(raw);
}

function sliceBraces(s: string): string | null {
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function isValidWalkthroughResult(x: unknown): x is WalkthroughResult {
  if (typeof x !== 'object' || x === null) return false;
  const o = x as Record<string, unknown>;
  // score aceita number OU string: LLMs frequentemente retornam "score": "3";
  // normalizeEffort coage com Number(...), entao nao rejeitamos a string aqui.
  const score = (o.effort as Record<string, unknown> | undefined)?.score;
  return (
    typeof o.walkthrough === 'string' &&
    Array.isArray(o.changes) &&
    Array.isArray(o.diagrams) &&
    typeof o.effort === 'object' &&
    o.effort !== null &&
    (typeof score === 'number' || typeof score === 'string')
  );
}

// score e a fonte da verdade: label e minutes sao sempre derivados de EFFORT_LABELS,
// nunca aceitos do LLM — evita que label/minutes inconsistentes do modelo poluam o comentario.
function normalizeEffort(effort: Record<string, unknown>): WalkthroughEffort {
  const score = Math.min(5, Math.max(1, Math.round(Number(effort.score) || 2)));
  const { label, minutes } = EFFORT_LABELS[score] ?? { label: 'Simple', minutes: 10 };
  return { score, label, minutes };
}

function normalizeChanges(raw: unknown): WalkthroughChange[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c): c is Record<string, unknown> => typeof c === 'object' && c !== null)
    .filter((c) => typeof c.layer === 'string' && typeof c.summary === 'string')
    .map((c) => ({
      layer: String(c.layer),
      files: Array.isArray(c.files) ? c.files.map(String) : [],
      summary: String(c.summary),
    }));
}

// Tipos de diagrama Mermaid suportados. Validacao leve: o primeiro token nao-vazio do
// diagrama precisa comecar com um destes — descarta prosa que o LLM as vezes coloca no
// lugar do diagrama, evitando renderizar um bloco de erro vermelho no GitHub.
const MERMAID_TYPES =
  /^(sequenceDiagram|graph|flowchart|classDiagram|stateDiagram(-v2)?|erDiagram|gantt|pie|journey|gitGraph|mindmap|timeline)\b/;

function isLikelyMermaid(d: string): boolean {
  const firstToken = d.trim().split(/\s|\n/)[0] ?? '';
  return MERMAID_TYPES.test(firstToken);
}

export function parseWalkthroughResult(raw: string): WalkthroughResult | null {
  const json = extractJsonFromRaw(raw);
  if (!json) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return null; }
  if (!isValidWalkthroughResult(parsed)) return null;
  return {
    walkthrough: parsed.walkthrough,
    changes: normalizeChanges(parsed.changes),
    diagrams: (parsed.diagrams as unknown[])
      .filter((d): d is string => typeof d === 'string')
      .filter(isLikelyMermaid),
    effort: normalizeEffort(parsed.effort as Record<string, unknown>),
  };
}

function formatChangesTable(changes: WalkthroughChange[]): string {
  if (changes.length === 0) return '';
  const rows = changes.map((c) => {
    const layerCell = [`**${c.layer}**`, ...c.files.map((f) => `\`${f}\``)].join('<br>');
    return `| ${layerCell} | ${c.summary} |`;
  });
  return ['| Camada / Arquivo(s) | Resumo |', '|---|---|', ...rows].join('\n');
}

function formatDiagrams(diagrams: string[]): string {
  if (diagrams.length === 0) return '';
  const blocks = diagrams.map((d) => `\`\`\`mermaid\n${d.trim()}\n\`\`\``);
  return `## Diagrama(s) de sequência\n\n${blocks.join('\n\n')}`;
}

function effortEmoji(score: number): string {
  const emojis: Record<number, string> = { 1: '🍕', 2: '🍕', 3: '🍕🍕', 4: '🍕🍕🍕', 5: '🍕🍕🍕🍕' };
  return emojis[score] ?? '🍕';
}

export function formatWalkthroughComment(result: WalkthroughResult): string {
  const sections: string[] = [];

  sections.push(`## Walkthrough\n\n${result.walkthrough}`);

  const table = formatChangesTable(result.changes);
  if (table) sections.push(`## Mudanças\n\n${table}`);

  const diagrams = formatDiagrams(result.diagrams);
  if (diagrams) sections.push(diagrams);

  const { score, label, minutes } = result.effort;
  sections.push(`## Esforço estimado de review\n\n${effortEmoji(score)} ${score} (${label}) | ⏱ ~${minutes} minutos`);

  return `${sections.join('\n\n')}\n\n${WALKTHROUGH_MARKER}`;
}

// Fallback conservador: usado tanto quando o LLM retorna JSON inválido quanto quando
// a chamada falha (rede/HTTP/timeout). Best-effort: sempre postar ALGO no PR.
const WALKTHROUGH_FALLBACK: WalkthroughResult = {
  walkthrough: 'Não foi possível gerar o walkthrough automaticamente.',
  changes: [],
  diagrams: [],
  effort: { score: 2, label: 'Simple', minutes: 10 },
};

export async function generateWalkthrough(
  diff: string,
  model: string,
  runner: ChatRunner,
  contextPack?: string,
  prTitle?: string,
): Promise<WalkthroughResult> {
  const { system, user } = buildWalkthroughPrompts(diff, contextPack, prTitle);
  let raw: string;
  try {
    raw = await runner(model, system, user);
  } catch (err) {
    // realChatRunner faz throw em 5xx/429/timeout; sem este catch o processo morria
    // ANTES de postar qualquer comentário. Cai no fallback para o PR ter sinal.
    console.error(`walkthrough: chamada ao LLM falhou — ${(err as Error).message}`);
    return WALKTHROUGH_FALLBACK;
  }
  const result = parseWalkthroughResult(raw);
  if (!result) return WALKTHROUGH_FALLBACK;
  return result;
}
