import { describe, it, expect } from 'vitest';
import {
  detectLanguages,
  buildPrompt,
  buildSystemPrompt,
  buildUserPrompt,
} from '../lib/context-loader.js';
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

// O harness passou a chamar chat-completion direto: a persona vira SYSTEM (para focar o
// agente na sua dimensao) e o contexto do PR vira USER. Estes testes travam o split.
describe('buildSystemPrompt', () => {
  it('contem a persona, a calibracao de severidade e as instrucoes obrigatorias (schema camelCase)', () => {
    const s = buildSystemPrompt(SPEC);
    expect(s).toContain('revisor de PERFORMANCE');     // persona
    expect(s).toContain('## Calibracao de severidade');
    expect(s).toContain('N+1 query');                  // severityHints
    expect(s).toContain('PT-BR');                      // instrucao de idioma
    expect(s).toContain('[arquivo:linha');             // exigencia de cite-the-line
    expect(s).toContain('startLine');                  // schema explicito (camelCase canonico)
    expect(s).toContain('camelCase');
  });

  it('NAO contem o diff nem as regras do repo (isso e do user prompt)', () => {
    const s = buildSystemPrompt(SPEC);
    expect(s).not.toContain('## DIFF DO PR');
    expect(s).not.toContain('## Regras do repositorio alvo');
  });
});

describe('buildUserPrompt', () => {
  it('contem regras do repo, lang-packs, ADRs, US do Jira e o diff', () => {
    const u = buildUserPrompt({
      repoRules: 'REGRA: usar lock distribuido',
      langPacks: ['JS: map().filter() = 2 passagens eager'],
      adrs: 'ADR-001: hexagonal',
      diff: '+const x = 1;',
      ticket: { summary: 'Debitar saldo no pedagio', description: 'AC1: travar conta antes do debito' },
    });
    expect(u).toContain('REGRA: usar lock distribuido');
    expect(u).toContain('2 passagens eager');
    expect(u).toContain('ADR-001');
    expect(u).toContain('## US do Jira');
    expect(u).toContain('Debitar saldo no pedagio');
    expect(u).toContain('+const x = 1;');
  });

  it('omite a secao "## US do Jira" quando nao ha ticket', () => {
    const u = buildUserPrompt({ repoRules: '', langPacks: [], adrs: '', diff: '+const x = 1;' });
    expect(u).not.toContain('## US do Jira');
  });

  it('NAO contem a persona (isso e do system prompt)', () => {
    const u = buildUserPrompt({ repoRules: '', langPacks: [], adrs: '', diff: '+const x = 1;' });
    expect(u).not.toContain('revisor de PERFORMANCE');
  });
});
