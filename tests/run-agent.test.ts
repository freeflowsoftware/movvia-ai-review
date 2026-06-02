// tests/run-agent.test.ts
import { describe, it, expect } from 'vitest';
import { parseFindings, runAgent, type OpencodeRunner } from '../lib/run-agent.js';
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
});

describe('runAgent', () => {
  it('usa o runner injetado e carimba o nome do agente', async () => {
    const fakeRunner: OpencodeRunner = async () =>
      '{"findings":[{"file":"a.ts","startLine":3,"endLine":3,"severity":"P1","category":"x","title":"t","rationale":"r","suggestion":"s","cite":"a.ts:3"}]}';
    const res = await runAgent(SPEC, 'prompt', 'gemini/flash-lite', fakeRunner);
    expect(res.agent).toBe('seguranca');
    expect(res.findings[0]!.agent).toBe('seguranca');
  });
});
