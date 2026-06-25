// tests/run-agent.test.ts
import { describe, it, expect } from 'vitest';
import { parseFindings, runAgent, llmTimeoutMs, type ChatRunner } from '../lib/run-agent.js';
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
