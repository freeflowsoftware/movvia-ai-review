import { describe, it, expect } from 'vitest';
import { detectLanguages, buildPrompt } from '../lib/context-loader.js';
import type { AgentSpec } from '../lib/types.js';

const SPEC: AgentSpec = {
  name: 'performance', dimension: 'performance', model: '', paths: ['**/*'],
  severityHints: { P1: 'N+1 query' }, persona: 'Voce e o revisor de PERFORMANCE.',
  file: 'agents/performance.md',
};

describe('detectLanguages', () => {
  it('mapeia extensoes para linguagens', () => {
    expect(detectLanguages(['a.ts', 'b.java', 'c.py', 'd.tsx']).sort())
      .toEqual(['java', 'javascript-typescript', 'python']);
  });
  it('ignora extensoes desconhecidas', () => {
    expect(detectLanguages(['x.md', 'y.yml'])).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('inclui persona, regras, lang-packs, ADRs e diff nas secoes esperadas', () => {
    const p = buildPrompt({
      spec: SPEC,
      repoRules: 'REGRA: usar lock distribuido',
      langPacks: ['JS: map().filter() = 2 passagens eager'],
      adrs: 'ADR-001: hexagonal',
      diff: '+const x = 1;',
    });
    expect(p).toContain('revisor de PERFORMANCE');
    expect(p).toContain('REGRA: usar lock distribuido');
    expect(p).toContain('2 passagens eager');
    expect(p).toContain('ADR-001');
    expect(p).toContain('+const x = 1;');
    expect(p).toContain('PT-BR');               // instrucao de idioma
    expect(p).toContain('[arquivo:linha');      // exigencia de cite-the-line
    expect(p).toContain('startLine');           // schema explicito (camelCase canonico)
    expect(p).toContain('camelCase');
  });

  // FIX P1-funcional: o agente de requisitos precisa ver a US do Jira no prompt para
  // confrontar criterios de aceite com o que o PR implementa. Sem o ticket, o gating de
  // dominio (diferencial do produto) opera no escuro. Estes asserts travam a secao.
  it('inclui a secao "## US do Jira" com summary/description quando ticket presente', () => {
    const p = buildPrompt({
      spec: SPEC,
      repoRules: '',
      langPacks: [],
      adrs: '',
      diff: '+const x = 1;',
      ticket: { summary: 'Debitar saldo no pedagio', description: 'AC1: travar conta antes do debito' },
    });
    expect(p).toContain('## US do Jira');
    expect(p).toContain('Debitar saldo no pedagio');
    expect(p).toContain('AC1: travar conta antes do debito');
  });

  it('omite a secao "## US do Jira" quando nao ha ticket', () => {
    const p = buildPrompt({
      spec: SPEC, repoRules: '', langPacks: [], adrs: '', diff: '+const x = 1;',
    });
    expect(p).not.toContain('## US do Jira');
  });
});
