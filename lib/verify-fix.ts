import { readFileSync } from 'node:fs';
import { parse as parseYaml } from 'yaml';
import type { Severity } from './types.js';
import type { ChatRunner } from './run-agent.js';

/**
 * Verificador de correção por código: antes de FECHAR uma thread, confirma — lendo o
 * código no head — que o problema sumiu de fato. Diferente da heurística isOutdated
 * (proxy: "o dev mexeu na linha"), aqui um LLM lê o arquivo e PROVA a correção citando
 * a linha. Fail-closed: na dúvida PRESERVA (oposto do refuter, que na dúvida descarta).
 * P0 NUNCA fecha por aqui — vira reply ao CODEOWNER (decisão Pablo 2026-06-03).
 */

/** Dossiê do finding original, reconstruído do corpo do 1º comentário da thread. */
export interface VerifyDossie {
  severity: Severity;
  title: string;
  rationale: string;
  suggestion: string;
}

/** Veredito do verificador: espelha o shape do refuter, com fail-closed INVERTIDO. */
export interface CorrectionVerdict {
  fixed: boolean;
  score: number;
  correctionLine: number;
  evidence: string;
}

/** Decisão sobre uma thread candidata: fechar, responder (P0) ou manter aberta. */
export type VerifyDecision =
  | { action: 'resolve' }
  | { action: 'reply'; correctionLine: number }
  | { action: 'preserve' };

/** Uma thread candidata a fechamento por correção (já filtrada pelo reconcile). */
export interface ZombieThread {
  threadId: string;
  path: string;
  rootBody: string;
}

const HEAD = /\*\*(P[012])\*\* — (.+)/;
const SUGESTAO = '**Sugestao:**';

/**
 * Reconstrói o dossiê do corpo do inline (montado por buildInlineBody, post.ts). Sem o
 * cabeçalho `**Pn** — titulo` (comentário de humano / formato antigo) retorna null:
 * severidade ilegível = não-fechável (fail-closed #8). É a única fonte do finding original
 * — o array de Findings não está disponível para uma thread cujo finding sumiu do run.
 */
export function parseInlineBody(body: string): VerifyDossie | null {
  const head = HEAD.exec(body);
  if (!head || head[1] === undefined || head[2] === undefined) return null;
  const severity = head[1] as Severity;
  const title = head[2].trim();
  const afterHead = body.slice(head.index + head[0].length);
  const sugIdx = afterHead.indexOf(SUGESTAO);
  if (sugIdx === -1) return { severity, title, rationale: stripMarker(afterHead).trim(), suggestion: '' };
  const rationale = afterHead.slice(0, sugIdx).trim();
  const suggestion = stripMarker(afterHead.slice(sugIdx + SUGESTAO.length)).trim();
  return { severity, title, rationale, suggestion };
}

/** Remove o marker invisível e o que vier depois dele. */
function stripMarker(s: string): string {
  const i = s.indexOf('<!--');
  return i === -1 ? s : s.slice(0, i);
}

/**
 * Espelha parseRefuteVerdict (gatekeeper.ts:153-166: indexOf('{')/lastIndexOf('}')/try)
 * MAS com o conservador INVERTIDO. No refuter, ilegível => refuted:true (descarta o
 * finding). AQUI, ilegível => fixed:FALSE (MANTÉM a thread). Copiar o default errado
 * fecharia threads — até P0 — por uma falha de parse. NUNCA mude isto sem o teste.
 */
export function parseCorrectionVerdict(raw: string): CorrectionVerdict {
  const fail: CorrectionVerdict = { fixed: false, score: 0, correctionLine: -1, evidence: '' };
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return fail;
  try {
    const o = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>;
    return {
      fixed: o.fixed === true,
      score: typeof o.score === 'number' ? o.score : 0,
      correctionLine: typeof o.correctionLine === 'number' ? o.correctionLine : -1,
      evidence: typeof o.evidence === 'string' ? o.evidence : '',
    };
  } catch {
    return fail;
  }
}

/**
 * A citação prova a correção: correctionLine deve ser um inteiro >=1 dentro do arquivo do
 * head E a linha NÃO pode estar vazia. Espelha isCiteValid (cite-the-line.ts:48) — sem
 * citação válida nenhuma thread fecha, matando alucinação de prova do modelo.
 */
export function validateCitation(correctionLine: number, fileContent: string): boolean {
  if (!Number.isInteger(correctionLine) || correctionLine < 1) return false;
  const lines = fileContent.split('\n');
  if (correctionLine > lines.length) return false;
  return (lines[correctionLine - 1] ?? '').trim() !== '';
}

/**
 * Regra de combinação: fecha SÓ com fixed + citação válida + confiança >= threshold.
 * P0 nunca resolve (vira reply). Qualquer falha => preserve (fail-closed). severity null
 * (dossiê ilegível) => preserve.
 */
export function decideVerify(
  severity: Severity | null,
  verdict: CorrectionVerdict,
  fileContent: string,
  closeThreshold: number,
): VerifyDecision {
  if (severity === null) return { action: 'preserve' };
  if (!verdict.fixed) return { action: 'preserve' };
  if (!validateCitation(verdict.correctionLine, fileContent)) return { action: 'preserve' };
  if (verdict.score / 10 < closeThreshold) return { action: 'preserve' };
  if (severity === 'P0') return { action: 'reply', correctionLine: verdict.correctionLine };
  return { action: 'resolve' };
}

export const VERIFY_SYSTEM =
  'Voce verifica se um problema de code review JA FOI CORRIGIDO no codigo atual. ' +
  'Recebe o problema original (severidade, titulo, justificativa) e o ARQUIVO INTEIRO ' +
  'do estado atual, com numeros de linha. Decida se a CONDICAO do problema esta AUSENTE ' +
  'agora. REGRAS: renomear variavel, adicionar log/comentario, reformatar ou MOVER codigo ' +
  'NAO e correcao. Varra o arquivo TODO pelo padrao da justificativa antes de declarar ' +
  'corrigido — o codigo pode ter se deslocado. Se corrigido, cite o NUMERO da linha que ' +
  'IMPLEMENTA a correcao e transcreva-a em "evidence". Ausencia de contexto NAO e prova: ' +
  'na duvida, fixed=false. Responda APENAS JSON: ' +
  '{"fixed":<bool>,"score":<0-10>,"correctionLine":<int|-1>,"evidence":"<linha citada>"}';

/** Numera as linhas (1-based) para o LLM citar e nós validarmos contra o mesmo arquivo. */
function numberLines(content: string): string {
  return content.split('\n').map((l, i) => `${i + 1}: ${l}`).join('\n');
}

export function buildVerifyUserPrompt(dossie: VerifyDossie, fileContent: string): string {
  return [
    `Severidade: ${dossie.severity}`,
    `Titulo: ${dossie.title}`,
    `Justificativa original: ${dossie.rationale}`,
    '',
    'Arquivo atual (head), numerado:',
    numberLines(fileContent),
  ].join('\n');
}

/** Lê verify.{close_threshold,max_threads_per_run} de defaults.yml (espelha readAdversarialThreshold). */
export function readVerifyConfig(configPath: string): { closeThreshold: number; maxThreads: number } {
  const parsed = parseYaml(readFileSync(configPath, 'utf8')) as
    | { verify?: { close_threshold?: number; max_threads_per_run?: number } }
    | null;
  const ct = parsed?.verify?.close_threshold;
  const mt = parsed?.verify?.max_threads_per_run;
  return {
    closeThreshold: typeof ct === 'number' ? ct : 0.9,
    maxThreads: typeof mt === 'number' ? mt : 10,
  };
}

// P0 por ULTIMO: P0 nao fecha mesmo (so reply), entao se o cap cortar, prioriza verificar
// P2/P1 que PODEM fechar. Empate mantem a ordem de entrada.
const SEV_ORDER: Record<Severity, number> = { P2: 0, P1: 1, P0: 2 };

interface VerifyZombieParams {
  candidates: ZombieThread[];
  fileProvider: (path: string) => Promise<string>;
  run: ChatRunner;
  model: string;
  closeThreshold: number;
  maxThreads: number;
}

/**
 * Orquestrador (DIP: fileProvider e run injetados). Confirma cada candidata zumbi e
 * devolve o subconjunto a fechar (toResolveExtra) + os P0 a responder (p0ToReply).
 *
 * 3 cortes de custo: (1) candidates ja restritos ao delta pelo reconcile; (2) cap por
 * severidade (P2->P1->P0), excedente preservado; (3) 1 LLM/thread via allSettled — uma
 * rejeicao (timeout/rede) => preserve, jamais derruba o batch nem fecha as cegas.
 */
export async function verifyZombieThreads(
  p: VerifyZombieParams,
): Promise<{ toResolveExtra: string[]; p0ToReply: Array<{ threadId: string; correctionLine: number }> }> {
  const parsed = p.candidates
    .map((c) => ({ c, dossie: parseInlineBody(c.rootBody) }))
    .filter((x): x is { c: ZombieThread; dossie: VerifyDossie } => x.dossie !== null)
    .sort((a, b) => SEV_ORDER[a.dossie.severity] - SEV_ORDER[b.dossie.severity])
    .slice(0, p.maxThreads);

  const settled = await Promise.allSettled(
    parsed.map(async ({ c, dossie }) => {
      const fileContent = await p.fileProvider(c.path);
      const raw = await p.run(p.model, VERIFY_SYSTEM, buildVerifyUserPrompt(dossie, fileContent));
      const decision = decideVerify(dossie.severity, parseCorrectionVerdict(raw), fileContent, p.closeThreshold);
      return { threadId: c.threadId, decision };
    }),
  );

  const toResolveExtra: string[] = [];
  const p0ToReply: Array<{ threadId: string; correctionLine: number }> = [];
  for (const s of settled) {
    if (s.status !== 'fulfilled') continue; // rejeicao de infra => preserve (fail-closed)
    const { threadId, decision } = s.value;
    if (decision.action === 'resolve') toResolveExtra.push(threadId);
    else if (decision.action === 'reply') p0ToReply.push({ threadId, correctionLine: decision.correctionLine });
  }
  return { toResolveExtra, p0ToReply };
}
