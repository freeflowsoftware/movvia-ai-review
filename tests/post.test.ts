import { describe, it, expect } from 'vitest';
import { summaryMarker, parseSummarySha, findingMarker, buildSummary } from '../lib/post.js';
import { findingId } from '../lib/gatekeeper.js';
import type { Finding, Verdict } from '../lib/types.js';

const verdict: Verdict = { event: 'REQUEST_CHANGES', conclusion: 'failure', counts: { P0: 1, P1: 0, P2: 2 } };
const findings: Finding[] = [{
  agent: 'seguranca', file: 'a.ts', startLine: 10, endLine: 12, severity: 'P0',
  category: 'cred', title: 'Token hardcoded', rationale: 'r', suggestion: 's', cite: 'a.ts:10-12',
}];

describe('summaryMarker / parseSummarySha', () => {
  it('embute e extrai o sha', () => {
    const marker = summaryMarker('abc1234');
    expect(parseSummarySha(`texto\n${marker}\nmais`)).toBe('abc1234');
  });
  it('retorna null quando nao ha marker (PR ainda nao revisado)', () => {
    expect(parseSummarySha('sem marker')).toBeNull();
  });
});

describe('findingMarker', () => {
  it('inclui o id estavel do finding (ancorado em findingId do gatekeeper)', () => {
    // O marker e a ancora de dedup contra threads existentes; deve carregar o
    // mesmo id estavel que o gatekeeper usa, nao a linha crua.
    expect(findingMarker(findings[0]!)).toContain(findingId(findings[0]!));
  });

  it('produz o MESMO marker quando o codigo desloca 1 linha (idempotencia)', () => {
    // Dedup-contra-threads-existentes so funciona se um commit que empurra o
    // codigo nao gerar um marker novo. Mesmo arquivo/categoria, startLine
    // deslocado dentro do bucket -> marker identico -> nao duplica comentario.
    const original = findings[0]!;
    const deslocado: Finding = { ...original, startLine: original.startLine + 1, endLine: original.endLine + 1 };
    expect(findingMarker(deslocado)).toBe(findingMarker(original));
  });
});

describe('buildSummary', () => {
  it('mostra contagem por severidade, veredicto e carimba o sha', () => {
    const s = buildSummary(findings, verdict, 'abc1234');
    expect(s).toContain('1 P0');
    expect(s).toContain('Mudancas necessarias');
    expect(s).toContain(summaryMarker('abc1234'));
  });
});
