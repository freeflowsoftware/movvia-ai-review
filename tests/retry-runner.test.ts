// tests/retry-runner.test.ts
// PED-2729: retry de erro transitorio do LLM no agente de review.
import { describe, it, expect, afterEach } from 'vitest';
import { withRetry, isTransientLlmError, retryConfigFromEnv, realChatRunner, LlmError, type ChatRunner, type Sleeper } from '../lib/run-agent.js';

/** Sleeper fake: nao espera de verdade, so registra os ms pedidos. */
function fakeSleep(sleeps: number[]): Sleeper {
  return async (ms) => { sleeps.push(ms); };
}

describe('withRetry', () => {
  it('timeout na 1a tentativa, sucesso na 2a: resolve e chama o inner 2x', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const inner: ChatRunner = async () => {
      calls++;
      if (calls === 1) throw new LlmError('chat-completion timeout apos 60000ms', { transient: true });
      return '{"findings":[]}';
    };
    const runner = withRetry(inner, { maxAttempts: 3, baseMs: 0, sleep: fakeSleep(sleeps) });
    await expect(runner('m', 's', 'u')).resolves.toBe('{"findings":[]}');
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('timeout persistente esgota as tentativas e rejeita', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const inner: ChatRunner = async () => {
      calls++;
      throw new LlmError('chat-completion timeout apos 60000ms', { transient: true });
    };
    const runner = withRetry(inner, { maxAttempts: 3, baseMs: 0, sleep: fakeSleep(sleeps) });
    await expect(runner('m', 's', 'u')).rejects.toThrow(/timeout apos \d+ms/);
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
  });

  it('erro permanente (HTTP 400) nao tenta de novo — rejeita na 1a chamada', async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const inner: ChatRunner = async () => {
      calls++;
      throw new LlmError('chat-completion falhou: HTTP 400 — model invalido', { status: 400, transient: false });
    };
    const runner = withRetry(inner, { maxAttempts: 3, baseMs: 0, sleep: fakeSleep(sleeps) });
    await expect(runner('m', 's', 'u')).rejects.toThrow(/HTTP 400/);
    expect(calls).toBe(1);
    expect(sleeps).toHaveLength(0);
  });

  it('aplica backoff exponencial: baseMs, 2*baseMs, ... (random=1 => sem jitter, cap cheio)', async () => {
    const sleeps: number[] = [];
    const inner: ChatRunner = async () => {
      throw new LlmError('chat-completion timeout apos 60000ms', { transient: true });
    };
    // random: () => 1 => delay = cap/2 + 1*(cap/2) = cap, preservando a serie determinada
    // baseMs, 2*baseMs de antes do equal jitter.
    const runner = withRetry(inner, { maxAttempts: 3, baseMs: 500, sleep: fakeSleep(sleeps), random: () => 1 });
    await expect(runner('m', 's', 'u')).rejects.toThrow();
    expect(sleeps).toEqual([500, 1000]);
  });

  it('equal jitter: random=0 => delay = cap/2 (metade fixa do backoff)', async () => {
    const sleeps: number[] = [];
    const inner: ChatRunner = async () => {
      throw new LlmError('chat-completion timeout apos 60000ms', { transient: true });
    };
    const runner = withRetry(inner, { maxAttempts: 3, baseMs: 500, sleep: fakeSleep(sleeps), random: () => 0 });
    await expect(runner('m', 's', 'u')).rejects.toThrow();
    expect(sleeps).toEqual([250, 500]);
  });
});

describe('isTransientLlmError', () => {
  it('respeita a flag transient de LlmError', () => {
    expect(isTransientLlmError(new LlmError('x', { transient: true }))).toBe(true);
    expect(isTransientLlmError(new LlmError('x', { status: 400, transient: false }))).toBe(false);
  });

  it('erro de modelo invalido/config nao e transitorio', () => {
    expect(isTransientLlmError(new Error('invalid model id'))).toBe(false);
    expect(isTransientLlmError(new Error('model xyz not found'))).toBe(false);
    expect(isTransientLlmError(new Error('unknown model'))).toBe(false);
  });

  it('erro de rede generico (ECONNRESET, socket hang up) e transitorio', () => {
    expect(isTransientLlmError(new Error('socket hang up'))).toBe(true);
    expect(isTransientLlmError(new Error('ECONNRESET'))).toBe(true);
  });

  it('valor que nao e Error nunca e transitorio', () => {
    expect(isTransientLlmError('string qualquer')).toBe(false);
    expect(isTransientLlmError(null)).toBe(false);
    expect(isTransientLlmError(undefined)).toBe(false);
  });
});

describe('retryConfigFromEnv', () => {
  const origMax = process.env.AGENT_MAX_ATTEMPTS;
  const origBase = process.env.AGENT_RETRY_BASE_MS;
  afterEach(() => {
    if (origMax === undefined) delete process.env.AGENT_MAX_ATTEMPTS; else process.env.AGENT_MAX_ATTEMPTS = origMax;
    if (origBase === undefined) delete process.env.AGENT_RETRY_BASE_MS; else process.env.AGENT_RETRY_BASE_MS = origBase;
  });

  it('usa os defaults (3 tentativas, 500ms) quando as envs estao ausentes', () => {
    delete process.env.AGENT_MAX_ATTEMPTS;
    delete process.env.AGENT_RETRY_BASE_MS;
    expect(retryConfigFromEnv()).toEqual({ maxAttempts: 3, baseMs: 500 });
  });

  it('faz clamp em AGENT_MAX_ATTEMPTS acima do teto (5)', () => {
    process.env.AGENT_MAX_ATTEMPTS = '99';
    expect(retryConfigFromEnv().maxAttempts).toBe(5);
  });

  it('cai no default quando AGENT_MAX_ATTEMPTS e invalido', () => {
    process.env.AGENT_MAX_ATTEMPTS = 'abc';
    expect(retryConfigFromEnv().maxAttempts).toBe(3);
  });

  it('cai no default quando AGENT_MAX_ATTEMPTS e string vazia (nao vira 0)', () => {
    process.env.AGENT_MAX_ATTEMPTS = '';
    expect(retryConfigFromEnv().maxAttempts).toBe(3);
  });

  it('usa o default (500ms) quando AGENT_RETRY_BASE_MS esta ausente', () => {
    delete process.env.AGENT_RETRY_BASE_MS;
    expect(retryConfigFromEnv().baseMs).toBe(500);
  });

  it('faz clamp em AGENT_RETRY_BASE_MS acima do teto (30000)', () => {
    process.env.AGENT_RETRY_BASE_MS = '99999';
    expect(retryConfigFromEnv().baseMs).toBe(30_000);
  });

  it('cai no default quando AGENT_RETRY_BASE_MS e invalido', () => {
    process.env.AGENT_RETRY_BASE_MS = 'xyz';
    expect(retryConfigFromEnv().baseMs).toBe(500);
  });
});

describe('withRetry onRetry', () => {
  it('chama onRetry com attempt, delayMs e err corretos antes do sleep', async () => {
    const sleeps: number[] = [];
    const retries: { attempt: number; delayMs: number; err: unknown }[] = [];
    let calls = 0;
    const timeoutErr = new LlmError('chat-completion timeout apos 60000ms', { transient: true });
    const inner: ChatRunner = async () => {
      calls++;
      if (calls === 1) throw timeoutErr;
      return '{"findings":[]}';
    };
    const runner = withRetry(inner, {
      maxAttempts: 3,
      baseMs: 500,
      sleep: fakeSleep(sleeps),
      onRetry: (info) => retries.push(info),
      random: () => 1, // sem jitter: delayMs = cap = 500, mantendo a asserção exata abaixo
    });
    await expect(runner('m', 's', 'u')).resolves.toBe('{"findings":[]}');
    expect(retries).toHaveLength(1);
    expect(retries[0]).toEqual({ attempt: 1, delayMs: 500, err: timeoutErr });
    expect(retries[0]!.err).toBeInstanceOf(LlmError);
  });
});

describe('realChatRunner: mapeamento status -> transient', () => {
  const origFetch = globalThis.fetch;
  const origApiKey = process.env.LLM_API_KEY;
  const origBaseUrl = process.env.LLM_BASE_URL;

  afterEach(() => {
    globalThis.fetch = origFetch;
    if (origApiKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = origApiKey;
    if (origBaseUrl === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = origBaseUrl;
  });

  it('429 (rate limit) e transitorio', async () => {
    process.env.LLM_API_KEY = 'fake-key';
    process.env.LLM_BASE_URL = 'https://fake.example';
    globalThis.fetch = (async () => ({
      ok: false,
      status: 429,
      text: async () => 'rate',
    })) as unknown as typeof fetch;
    try {
      await realChatRunner('m', 's', 'u');
      throw new Error('deveria ter rejeitado');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).transient).toBe(true);
      expect((err as LlmError).status).toBe(429);
    }
  });

  it('400 (modelo invalido) nao e transitorio', async () => {
    process.env.LLM_API_KEY = 'fake-key';
    process.env.LLM_BASE_URL = 'https://fake.example';
    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      text: async () => 'invalid model',
    })) as unknown as typeof fetch;
    try {
      await realChatRunner('m', 's', 'u');
      throw new Error('deveria ter rejeitado');
    } catch (err) {
      expect(err).toBeInstanceOf(LlmError);
      expect((err as LlmError).transient).toBe(false);
      expect((err as LlmError).status).toBe(400);
    }
  });
});
