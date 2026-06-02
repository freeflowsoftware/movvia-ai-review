import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult, Finding, AgentSpec, Severity } from './types.js';

const execFileP = promisify(execFile);
const SEVERITIES: Severity[] = ['P0', 'P1', 'P2'];

/** Recorta o objeto `{...}` mais externo de um trecho, ou null se nao houver chaves. */
function sliceBraces(candidate: string): string | null {
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

/** Verdadeiro se o trecho parseia para um objeto com `findings[]` — o formato que esperamos. */
function parsesToFindings(candidate: string | null): boolean {
  if (candidate === null) return false;
  try {
    const obj = JSON.parse(candidate) as { findings?: unknown };
    return Array.isArray(obj.findings);
  } catch {
    return false;
  }
}

/** Cercas de codigo do raw, com a linguagem declarada (ex: "json", "ts" ou ""). */
function codeFences(raw: string): { lang: string; body: string }[] {
  const re = /```(\w*)\n([\s\S]*?)```/g;
  const fences: { lang: string; body: string }[] = [];
  for (const m of raw.matchAll(re)) fences.push({ lang: m[1] ?? '', body: m[2] ?? '' });
  return fences;
}

function extractJson(raw: string): string | null {
  const fences = codeFences(raw);
  // 1) Preferimos a cerca explicitamente marcada como ```json — o modelo nos disse onde esta.
  const jsonFence = fences.find((f) => f.lang === 'json');
  if (jsonFence) return sliceBraces(jsonFence.body);
  // 2) Sem rotulo json: o modelo pode mostrar o codigo ofensor num ```ts ANTES do bloco de
  // achados. Iteramos TODAS as cercas e pegamos a primeira que parseia para { findings[] },
  // evitando casar a cerca errada (bug P1: a primeira cerca podia ser ```ts).
  for (const fence of fences) {
    const sliced = sliceBraces(fence.body);
    if (parsesToFindings(sliced)) return sliced;
  }
  // 3) Fallback: nenhuma cerca util, caimos no texto cru e pegamos o primeiro {..}.
  // Sob noUncheckedIndexedAccess (tsconfig), grupos de match sao string | undefined.
  // Mesma convencao de cite-the-line.ts.
  return sliceBraces(raw);
}

function isValidFinding(x: unknown): x is Finding {
  if (typeof x !== 'object' || x === null) return false;
  const f = x as Record<string, unknown>;
  return (
    typeof f.file === 'string' &&
    typeof f.startLine === 'number' &&
    typeof f.endLine === 'number' &&
    SEVERITIES.includes(f.severity as Severity) &&
    typeof f.category === 'string' &&
    typeof f.title === 'string' &&
    typeof f.cite === 'string'
  );
}

/** Tolera snake_case emitido por alguns modelos, normalizando para o camelCase canonico. */
function normalizeKeys(x: unknown): unknown {
  if (typeof x !== 'object' || x === null) return x;
  const o = x as Record<string, unknown>;
  if ('start_line' in o && !('startLine' in o)) o.startLine = o.start_line;
  if ('end_line' in o && !('endLine' in o)) o.endLine = o.end_line;
  return o;
}

export function parseFindings(raw: string, agent: string): Finding[] {
  const json = extractJson(raw);
  if (!json) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(json); } catch { return []; }
  const arr = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(arr)) return [];
  return arr
    .map(normalizeKeys)
    .filter(isValidFinding)
    .map((f) => ({
      ...f,
      agent,
      rationale: f.rationale ?? '',
      suggestion: f.suggestion ?? '',
    }));
}

/** Borda externa (DIP): invoca o opencode. Testes injetam um fake. */
export type OpencodeRunner = (model: string, prompt: string) => Promise<string>;

export const realOpencodeRunner: OpencodeRunner = async (model, prompt) => {
  // O `input` do execFileSync NAO existe no execFile async: a opcao e ignorada e o
  // filho fica bloqueado esperando stdin que nunca chega (verificado no Node v22.17.0).
  // promisify(execFile) expoe o ChildProcess em `.child`; escrevemos o prompt no stdin
  // do filho manualmente. Prompt e grande (regras + lang-packs + diff), entao stdin > argv.
  //
  // FIX P0: herdamos process.env explicitamente. O opencode resolve a credencial do
  // provider via interpolacao {env:LLM_API_KEY}/{env:LLM_BASE_URL} no opencode.json
  // (provider OpenAI-compatible). Sem o env herdado, o filho nao ve LLM_API_KEY e a
  // chamada ao LLM falha por falta de credencial — exatamente o bug que esta corrige.
  const running = execFileP('opencode', ['run', '-m', model], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
    env: process.env,
  });
  const stdin = running.child.stdin;
  if (!stdin) throw new Error('opencode nao expos stdin; esperado um stream gravavel');
  stdin.write(prompt);
  stdin.end();
  const { stdout } = await running;
  return stdout;
};

export async function runAgent(
  spec: AgentSpec,
  prompt: string,
  model: string,
  runner: OpencodeRunner,
): Promise<AgentResult> {
  const raw = await runner(model, prompt);
  return { agent: spec.name, findings: parseFindings(raw, spec.name) };
}
