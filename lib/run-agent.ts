import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentResult, Finding, AgentSpec, Severity } from './types.js';

const execFileP = promisify(execFile);
const SEVERITIES: Severity[] = ['P0', 'P1', 'P2'];

function extractJson(raw: string): string | null {
  const fenced = /```(?:json)?\n([\s\S]*?)```/.exec(raw);
  // Sob noUncheckedIndexedAccess (tsconfig), o grupo 1 do match e string | undefined;
  // caimos no texto cru quando nao ha cerca. Mesma convencao de cite-the-line.ts.
  const candidate = fenced?.[1] ?? raw;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
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
  const running = execFileP('opencode', ['run', '-m', model], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
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
