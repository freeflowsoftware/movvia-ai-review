// tests/run-agent.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { parseFindings, runAgent, runAgentSafe, retryOnTimeout, isTimeoutError, llmTimeoutMs, realChatRunner, type ChatRunner } from '../lib/run-agent.js';
import type { AgentSpec } from '../lib/types.js';

const SPEC: AgentSpec = {
  name: 'seguranca', dimension: 'security', model: '', paths: ['**/*'],
  severityHints: {}, persona: 'persona', file: 'agents/seguranca.md',
};

describe('parseFindings', () => {
  it('parseia JSON cru', () => {
    const raw = '{"agent":"seguranca","findings":[{"file":"a.ts","startLine":1,"endLine":2,"severity":"P0","category":"x","title":"t","rationale":"r","suggestion":"s","cite":"a.ts:1-2"}]}';
    const out = parseFindings(raw, 'seguranca');
    expect(out).toHaveLength(1);
    // `!` justificado pelo toHaveLength acima; noUncheckedIndexedAccess exige o guard.
    expect(out[0]!.severity).toBe('P0');
  });
  it('tolera cercas de codigo ```json e texto ao redor', () => {
    const raw = 'segue:\n```json\n{"agent":"seguranca","findings":[]}\n```\nfim';
    expect(parseFindings(raw, 'seguranca')).toEqual([]);
  });
  it('retorna [] em saida nao-JSON (sem quebrar o job)', () => {
    expect(parseFindings('desculpe, nao consegui', 'seguranca')).toEqual([]);
  });
  it('descarta finding com severity invalida', () => {
    const raw = '{"findings":[{"file":"a.ts","startLine":1,"endLine":1,"severity":"P9","category":"x","title":"t","rationale":"r","suggestion":"s","cite":"a.ts:1"}]}';
    expect(parseFindings(raw, 'seguranca')).toEqual([]);
  });
  it('normaliza snake_case (start_line/end_line) do modelo para camelCase', () => {
    const raw = '{"findings":[{"file":"a.ts","start_line":4,"end_line":5,"severity":"P1","category":"x","title":"t","rationale":"r","suggestion":"s","cite":"a.ts:4-5"}]}';
    const out = parseFindings(raw, 'seguranca');
    expect(out).toHaveLength(1);
    expect(out[0]!.startLine).toBe(4);
    expect(out[0]!.endLine).toBe(5);
  });
  // Regressao: o modelo as vezes mostra o codigo ofensor num bloco ```ts ANTES do ```json.
  // A cerca ```ts nao parseia para findings[]; precisamos escolher a cerca json, nao a primeira.
  it('ignora bloco ```ts e usa o ```json seguinte com findings', () => {
    const raw =
      'O trecho problematico:\n' +
      '```ts\nconst x: any = foo();\n```\n' +
      'Achados:\n' +
      '```json\n{"findings":[{"file":"a.ts","startLine":1,"endLine":1,"severity":"P1","category":"x","title":"t","rationale":"r","suggestion":"s","cite":"a.ts:1"}]}\n```';
    const out = parseFindings(raw, 'seguranca');
    expect(out).toHaveLength(1);
    expect(out[0]!.file).toBe('a.ts');
  });
});

describe('llmTimeoutMs', () => {
  const orig = process.env.LLM_TIMEOUT_MS;
  const restore = () => { if (orig === undefined) delete process.env.LLM_TIMEOUT_MS; else process.env.LLM_TIMEOUT_MS = orig; };

  it('usa o default (60s) quando a env é ausente ou inválida', () => {
    delete process.env.LLM_TIMEOUT_MS;
    try { expect(llmTimeoutMs()).toBe(60_000); } finally { restore(); }
    process.env.LLM_TIMEOUT_MS = 'abc';
    try { expect(llmTimeoutMs()).toBe(60_000); } finally { restore(); }
  });

  it('respeita um valor configurado válido', () => {
    process.env.LLM_TIMEOUT_MS = '90000';
    try { expect(llmTimeoutMs()).toBe(90_000); } finally { restore(); }
  });

  // Regressao: valor gigante estourava RangeError em AbortSignal.timeout antes do clamp.
  it('faz clamp no teto de timers do Node (não estoura RangeError)', () => {
    process.env.LLM_TIMEOUT_MS = '999999999999999';
    try {
      expect(llmTimeoutMs()).toBe(2_147_483_647);
      expect(() => AbortSignal.timeout(llmTimeoutMs())).not.toThrow();
    } finally { restore(); }
  });
});

describe('runAgent', () => {
  it('usa o runner injetado (model,system,user) e carimba o nome do agente', async () => {
    const seen: { model: string; system: string; user: string }[] = [];
    const fakeRunner: ChatRunner = async (model, system, user) => {
      seen.push({ model, system, user });
      return '{"findings":[{"file":"a.ts","startLine":3,"endLine":3,"severity":"P1","category":"x","title":"t","rationale":"r","suggestion":"s","cite":"a.ts:3"}]}';
    };
    const res = await runAgent(SPEC, 'sou o system', 'sou o user', 'gemini/flash-lite', fakeRunner);
    expect(res.agent).toBe('seguranca');
    expect(res.findings[0]!.agent).toBe('seguranca');
    // O runner recebe os tres argumentos na ordem (model, system, user).
    expect(seen[0]).toEqual({ model: 'gemini/flash-lite', system: 'sou o system', user: 'sou o user' });
  });
});

describe('realChatRunner (borda LLM: erros e timeout)', () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it('traduz TimeoutError/AbortError em mensagem legível com o timeout', async () => {
    globalThis.fetch = (async () => {
      throw Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    }) as typeof fetch;
    await expect(realChatRunner('m', 's', 'u')).rejects.toThrow(/timeout apos \d+ms/);
  });

  // Regressao critica: o wrapper de timeout DEVE preservar err.name E err.cause. Sem isso,
  // isTimeoutError (que agora classifica por tipo estruturado, sem heuristica textual) nao
  // reconhece o erro embrulhado, retryOnTimeout nao retria, e o retry legitimo se perde
  // silenciosamente. Antes desta cobertura, remover as duas linhas de preservacao mantinha
  // todos os testes verdes — invariante critico sem guard.
  it('preserva err.name=TimeoutError E err.cause no timeout embrulhado (retry funciona)', async () => {
    let fetchCalls = 0;
    const original = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    globalThis.fetch = (async () => {
      fetchCalls++;
      throw original;
    }) as typeof fetch;
    let captured: unknown;
    try {
      await realChatRunner('m', 's', 'u');
    } catch (e) {
      captured = e;
    }
    expect(captured).toBeInstanceOf(Error);
    const err = captured as Error;
    expect(err.name).toBe('TimeoutError');
    expect(err.cause).toBe(original);
    // retryOnTimeout(attempts=2): TimeoutError classificado corretamente => 2 chamadas de fetch.
    expect(fetchCalls).toBe(2);
  });

  it('preserva AbortError tambem (nao so TimeoutError)', async () => {
    const original = Object.assign(new Error('aborted'), { name: 'AbortError' });
    globalThis.fetch = (async () => { throw original; }) as typeof fetch;
    let captured: unknown;
    try {
      await realChatRunner('m', 's', 'u');
    } catch (e) { captured = e; }
    const err = captured as Error;
    expect(err.name).toBe('AbortError');
    expect(err.cause).toBe(original);
  });

  it('propaga erro não-timeout intacto (não mascara como timeout)', async () => {
    globalThis.fetch = (async () => { throw new Error('ECONNRESET'); }) as typeof fetch;
    await expect(realChatRunner('m', 's', 'u')).rejects.toThrow('ECONNRESET');
  });

  it('lança com status e corpo quando o HTTP não é ok', async () => {
    globalThis.fetch = (async () => new Response('rate limited', { status: 429 })) as typeof fetch;
    await expect(realChatRunner('m', 's', 'u')).rejects.toThrow(/HTTP 429/);
  });

  it('retorna o content da primeira choice em resposta ok', async () => {
    const body = JSON.stringify({ choices: [{ message: { content: 'olá do modelo' } }] });
    globalThis.fetch = (async () => new Response(body, { status: 200 })) as typeof fetch;
    await expect(realChatRunner('m', 's', 'u')).resolves.toBe('olá do modelo');
  });
});

describe('isTimeoutError', () => {
  it('reconhece TimeoutError/AbortError por name', () => {
    const to = new Error('x'); to.name = 'TimeoutError';
    const ab = new Error('x'); ab.name = 'AbortError';
    expect(isTimeoutError(to)).toBe(true);
    expect(isTimeoutError(ab)).toBe(true);
  });
  it('reconhece timeout via err.cause.name (undici embrulha em TypeError)', () => {
    const inner = new Error('inner'); inner.name = 'TimeoutError';
    const outer = new TypeError('fetch failed');
    outer.cause = inner;
    expect(isTimeoutError(outer)).toBe(true);
  });
  it('reconhece codigos de timeout de undici (HEADERS/BODY/CONNECT)', () => {
    // .code é add-on de undici — não parte do tipo Error padrão; cast é intencional aqui.
    const err = Object.assign(new Error('boom'), { code: 'UND_ERR_HEADERS_TIMEOUT' });
    expect(isTimeoutError(err)).toBe(true);
    const wrapped = new TypeError('fetch failed');
    wrapped.cause = { code: 'UND_ERR_BODY_TIMEOUT' };
    expect(isTimeoutError(wrapped)).toBe(true);
  });
  // Regressao critica: heuristica textual era FONTE DE POST DUPLICADO.
  // HTTP 504 ou "invalid timeout param" (contrato) contem "timeout" mas NAO deve repetir.
  it('NAO trata erros de contrato com "timeout" no texto como timeout (evita POST duplicado)', () => {
    expect(isTimeoutError(new Error('HTTP 504 — Gateway Timeout'))).toBe(false);
    expect(isTimeoutError(new Error('HTTP 422 — invalid timeout parameter'))).toBe(false);
    expect(isTimeoutError(new Error('chat-completion timeout apos 60000ms'))).toBe(false);
  });
  it('nao trata erros comuns como timeout', () => {
    expect(isTimeoutError(new Error('HTTP 500'))).toBe(false);
    expect(isTimeoutError('string')).toBe(false);
    expect(isTimeoutError(null)).toBe(false);
    expect(isTimeoutError({ name: 'TimeoutError' })).toBe(false); // nao e Error real
  });
  // Cobertura negativa dos guards de cause/code: sem esses testes, uma regressao que
  // aceitasse cause nao-objeto ou code nao reconhecido passaria despercebida.
  it('cause presente mas nao-objeto (string/number) NAO conta como timeout', () => {
    expect(isTimeoutError(Object.assign(new Error('x'), { cause: 'boom' }))).toBe(false);
    expect(isTimeoutError(Object.assign(new Error('x'), { cause: 42 }))).toBe(false);
  });
  it('cause={} sem name/code NAO conta como timeout', () => {
    expect(isTimeoutError(Object.assign(new Error('x'), { cause: {} }))).toBe(false);
  });
  it('err.code com valor nao reconhecido (ex: ECONNRESET) NAO conta como timeout', () => {
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(false);
    expect(isTimeoutError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
  });
});

describe('retryOnTimeout', () => {
  it('reexecuta UMA vez extra apos timeout e entao devolve o sucesso', async () => {
    let calls = 0;
    const fn = async () => {
      calls++;
      if (calls === 1) { const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; }
      return 'ok';
    };
    expect(await retryOnTimeout(fn, 2)).toBe('ok');
    expect(calls).toBe(2);
  });
  it('NAO reexecuta erro que nao e timeout (propaga na hora)', async () => {
    let calls = 0;
    const fn = async () => { calls++; throw new Error('HTTP 422'); };
    await expect(retryOnTimeout(fn, 2)).rejects.toThrow('HTTP 422');
    expect(calls).toBe(1);
  });
  it('esgota as tentativas e propaga o ultimo timeout', async () => {
    let calls = 0;
    const fn = async () => { calls++; const e = new Error('timeout'); e.name = 'TimeoutError'; throw e; };
    await expect(retryOnTimeout(fn, 2)).rejects.toThrow('timeout');
    expect(calls).toBe(2);
  });
});

describe('runAgentSafe', () => {
  it('delega ao runAgent no caminho feliz', async () => {
    const runner: ChatRunner = async () => '{"agent":"seguranca","findings":[]}';
    const res = await runAgentSafe(SPEC, 'sys', 'usr', 'm', runner);
    expect(res.agent).toBe('seguranca');
    expect(res.degraded).toBeUndefined();
  });
  it('degrada (findings vazio + degraded) quando o runner falha — nao derruba o job', async () => {
    const runner: ChatRunner = async () => { throw new Error('chat-completion timeout apos 60000ms'); };
    const res = await runAgentSafe(SPEC, 'sys', 'usr', 'm', runner);
    expect(res).toEqual({ agent: 'seguranca', findings: [], degraded: true });
  });
});
