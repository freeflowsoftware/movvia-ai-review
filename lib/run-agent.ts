import type { AgentResult, Finding, AgentSpec, Severity } from './types.js';

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

/**
 * Borda externa (DIP): faz a chat-completion direta. Testes injetam um fake.
 * Trocamos o "opencode run" (agente completo que diluia a persona da dimensao) por uma
 * chamada chat-completion direta com a persona como SYSTEM — cada agente foca na sua
 * dimensao. system e user vem separados (buildSystemPrompt/buildUserPrompt).
 */
export type ChatRunner = (model: string, system: string, user: string) => Promise<string>;

/**
 * O endpoint OpenRouter quer o id PURO do modelo (ex: 'google/gemini-2.5-flash-lite').
 * O prefixo 'llm/' so existia para o provider customizado do opencode.json; na chat
 * direta ele quebra o roteamento, entao removemos quando vier (compat com configs antigas).
 */
function stripOpencodeProviderPrefix(model: string): string {
  return model.startsWith('llm/') ? model.slice('llm/'.length) : model;
}

interface ChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
}

// Default folgado: agentes lentos legitimos nao devem ser abortados; o timeout existe so
// para nao prender o job ate o teto de 6h do GitHub Actions quando o endpoint pendura.
const DEFAULT_LLM_TIMEOUT_MS = 60_000;
// Teto dos timers do Node (TIMEOUT_MAX = 2^31-1). AbortSignal.timeout estoura RangeError
// acima disso; clampamos para que um LLM_TIMEOUT_MS absurdo vire timeout longo, nao crash.
const MAX_LLM_TIMEOUT_MS = 2_147_483_647;

export function llmTimeoutMs(): number {
  const raw = Number(process.env.LLM_TIMEOUT_MS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_LLM_TIMEOUT_MS;
  return Math.min(raw, MAX_LLM_TIMEOUT_MS);
}

/**
 * PED-2729: erro tipado da borda LLM. `transient` marca se vale a pena tentar de novo
 * (timeout, 429, 5xx, erro de rede) — status 4xx de negocio (400 model invalido, etc.)
 * fica `transient: false` para nao desperdicar retries em erro que nunca vai se resolver
 * sozinho. `status` e opcional pois timeouts/erros de rede nao tem HTTP status.
 */
export class LlmError extends Error {
  readonly status?: number;
  readonly transient: boolean;
  constructor(message: string, opts: { status?: number; transient: boolean }) {
    super(message);
    this.name = 'LlmError';
    this.status = opts.status;
    this.transient = opts.transient;
  }
}

export const realChatRunner: ChatRunner = async (model, system, user) => {
  // fetch nativo do Node 22; nao dependemos mais do binario opencode no PATH.
  const timeoutMs = llmTimeoutMs();
  let res: Response;
  try {
    res = await fetch(`${process.env.LLM_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.LLM_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: stripOpencodeProviderPrefix(model),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        // Temperatura baixa: review e tarefa de extracao deterministica, nao criativa.
        temperature: 0.1,
      }),
      // AbortSignal.timeout nativo do Node 22; aborta o fetch pendurado.
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // TimeoutError/AbortError do AbortSignal.timeout viram mensagem legivel.
    // PED-2729: timeout e sempre transitorio (o endpoint so pendurou desta vez).
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new LlmError(`chat-completion timeout apos ${timeoutMs}ms`, { transient: true });
    }
    // Erro de rede (ECONNRESET etc.) nao vira LlmError: mantido intacto para o classificador
    // isTransientLlmError tratar via fallback (nao-Error => nao-transiente; Error => transiente).
    throw err;
  }
  if (!res.ok) {
    const body = await res.text();
    // PED-2729: 429 (rate limit), 408 (request timeout), 425 (too early) e 5xx (erro do
    // provedor) sao transitorios; demais 4xx de negocio (400 model invalido, 401/403 auth)
    // nao sao — retry nao resolve credencial errada.
    const transient = res.status === 429 || res.status === 408 || res.status === 425 || res.status >= 500;
    throw new LlmError(`chat-completion falhou: HTTP ${res.status} — ${body}`, { status: res.status, transient });
  }
  const data = (await res.json()) as ChatCompletionResponse;
  return data.choices?.[0]?.message?.content ?? '';
};

/** Verdadeiro se `err` indica falha transitoria da LLM, digna de retry. */
export function isTransientLlmError(err: unknown): boolean {
  if (err instanceof LlmError) return err.transient;
  if (!(err instanceof Error)) return false;
  // Erro de configuracao (modelo inexistente/invalido) nunca se resolve com retry.
  if (/invalid model|model .*not found|unknown model/i.test(err.message)) return false;
  return true;
}

/**
 * Converte env var para inteiro valido, com clamp — mesma convencao de llmTimeoutMs.
 * PED-2729: undefined/vazio/whitespace cai no default ANTES do Number() — sem essa guarda,
 * Number("") === 0 faria AGENT_MAX_ATTEMPTS="" virar 0 e ser clampado para o piso (1),
 * desligando o retry na pratica em vez de usar o default.
 */
function clampInt(raw: string | undefined, def: number, lo: number, hi: number): number {
  if (raw === undefined || raw.trim() === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

export function retryConfigFromEnv(): { maxAttempts: number; baseMs: number } {
  return {
    maxAttempts: clampInt(process.env.AGENT_MAX_ATTEMPTS, 3, 1, 5),
    baseMs: clampInt(process.env.AGENT_RETRY_BASE_MS, 500, 0, 30_000),
  };
}

/** Abstrai `setTimeout`-based sleep para os testes injetarem um fake sem esperar de verdade. */
export type Sleeper = (ms: number) => Promise<void>;
const realSleep: Sleeper = (ms) => new Promise((r) => setTimeout(r, ms));

export interface RetryOptions {
  maxAttempts: number;
  baseMs: number;
  sleep: Sleeper;
  isTransient: (err: unknown) => boolean;
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void;
  /** Injetavel para testes deterministicos; default `Math.random`. */
  random?: () => number;
}

/**
 * PED-2729: envolve um ChatRunner com retry de backoff exponencial para erro transitorio.
 * Wrapper (nao mudanca de assinatura) para nao quebrar runAgent/gatekeeper/judge/verify/
 * walkthrough, que continuam recebendo um ChatRunner comum — a logica de retry fica
 * transparente para quem chama.
 *
 * Equal jitter no delay: os agentes rodam em matrix paralela compartilhando a mesma API
 * key/rate-limit, entao num 429 todos calculariam o mesmo delay exponencial e re-tentariam
 * em sincronia (thundering herd). Equal jitter mantem metade do delay fixo (garante backoff
 * minimo) e sorteia a outra metade, desincronizando os agentes. `random` e injetavel para os
 * testes permanecerem deterministicos.
 */
export function withRetry(inner: ChatRunner, opts: Partial<RetryOptions> = {}): ChatRunner {
  const cfg = retryConfigFromEnv();
  const maxAttempts = opts.maxAttempts ?? cfg.maxAttempts;
  const baseMs = opts.baseMs ?? cfg.baseMs;
  const sleep = opts.sleep ?? realSleep;
  const isTransient = opts.isTransient ?? isTransientLlmError;
  const random = opts.random ?? Math.random;
  return async (model, system, user) => {
    for (let attempt = 1; ; attempt++) {
      try {
        return await inner(model, system, user);
      } catch (err) {
        if (!isTransient(err) || attempt >= maxAttempts) throw err;
        const cap = baseMs * 2 ** (attempt - 1);
        const delayMs = Math.round(cap / 2 + random() * (cap / 2));
        opts.onRetry?.({ attempt, delayMs, err });
        await sleep(delayMs);
      }
    }
  };
}

export async function runAgent(
  spec: AgentSpec,
  system: string,
  user: string,
  model: string,
  runner: ChatRunner,
): Promise<AgentResult> {
  const raw = await runner(model, system, user);
  return { agent: spec.name, findings: parseFindings(raw, spec.name) };
}

/**
 * runAgent tolerante a falha: em erro (timeout após retry, parse, rede) degrada para findings
 * vazio + `degraded:true` em vez de LANÇAR. Antes, um único reviewer que dava timeout derrubava
 * a matrix leg e, por needs:, os jobs gatekeeper/post — o PR ficava SEM veredicto e o dev
 * disparava reruns que geravam findings novos/contraditórios (não-determinância relatada).
 * Agora a leg sempre sai 0; o veredicto é sempre publicado e a dimensão degradada é reportada.
 */
export async function runAgentSafe(
  spec: AgentSpec,
  system: string,
  user: string,
  model: string,
  runner: ChatRunner,
): Promise<AgentResult> {
  try {
    return await runAgent(spec, system, user, model, runner);
  } catch (err) {
    process.stderr.write(`[runAgentSafe] agente ${spec.name} degradou: ${String(err)}\n`);
    return { agent: spec.name, findings: [], degraded: true };
  }
}
