import { describe, it, expect } from 'vitest';
import {
  detectLanguages,
  buildPrompt,
  buildSystemPrompt,
  buildUserPrompt,
  agentMatchesPaths,
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

  // Especializacao forte: o system prompt trava o agente na sua dimensao. Antes os agentes
  // reportavam problemas de outras dimensoes (off-dimension), poluindo o veredicto. Estes
  // asserts garantem que a dimensao e citada e a regra de exclusividade esta presente.
  it('cita a dimensao e a regra de exclusividade (reporte SOMENTE a sua dimensao)', () => {
    const s = buildSystemPrompt(SPEC);
    expect(s).toContain('EXCLUSIVAMENTE o revisor da dimensao performance');
    expect(s).toContain('Reporte SOMENTE problemas desta dimensao');
    expect(s).toContain('retorne findings vazio []');
    expect(s).toContain('melhor zero findings que findings fora da sua dimensao');
  });

  // A dimensao usada e spec.dimension (nao spec.name): para um agente onde nome e dimensao
  // divergem, o bloco de exclusividade deve seguir a dimensao.
  it('usa spec.dimension (nao spec.name) no bloco de exclusividade', () => {
    const s = buildSystemPrompt({ ...SPEC, name: 'perf', dimension: 'performance' });
    expect(s).toContain('EXCLUSIVAMENTE o revisor da dimensao performance');
  });

  // Fase 1b: a instrucao que ensina o agente a USAR o context-pack para confirmar padrao
  // ANTES de reportar (anti-FP), preservando o primado da regra documentada sobre o padrao
  // observado — sem isso o pack viraria "anti-padrao normalizado" (vizinhos tem any => para
  // de reportar any). Trava o texto exato do blueprint.
  it('contem a instrucao de usar o CONTEXTO e "Regra documentada vence"', () => {
    const s = buildSystemPrompt(SPEC);
    expect(s).toContain('Use o CONTEXTO DO CODEBASE para confirmar se o que parece ausente');
    expect(s).toContain('Regra documentada vence padrao observado');
  });
});

describe('agentMatchesPaths', () => {
  it('casa quando algum arquivo casa algum glob', () => {
    expect(agentMatchesPaths(['src/conta.service.ts'], ['**/*.service.ts'])).toBe(true);
  });
  it('nao casa quando nenhum arquivo bate os globs', () => {
    expect(agentMatchesPaths(['README.md'], ['**/*.service.ts', '**/*.ts'])).toBe(false);
  });
  it('o glob **/* casa qualquer arquivo', () => {
    expect(agentMatchesPaths(['qualquer/caminho/arquivo.py'], ['**/*'])).toBe(true);
  });
  it('retorna false sem arquivos alterados', () => {
    expect(agentMatchesPaths([], ['**/*'])).toBe(false);
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

  // Fase 1b: o context-pack determinístico injeta arquivos reais/vizinhos/padrões para
  // matar falso-positivo ("validacao ausente" num campo que segue o padrao). A secao so
  // existe quando contextPack esta presente, para nao adicionar ruido nos PRs sem pack.
  it('contem a secao "## CONTEXTO DO CODEBASE" quando contextPack presente', () => {
    const u = buildUserPrompt({
      repoRules: '', langPacks: [], adrs: '', diff: '+const x = 1;',
      contextPack: 'conta.service.ts: validacao via class-validator',
    });
    expect(u).toContain('## CONTEXTO DO CODEBASE (arquivos reais, vizinhos, padroes)');
    expect(u).toContain('conta.service.ts: validacao via class-validator');
  });

  it('omite a secao "## CONTEXTO DO CODEBASE" quando nao ha contextPack', () => {
    const u = buildUserPrompt({ repoRules: '', langPacks: [], adrs: '', diff: '+const x = 1;' });
    expect(u).not.toContain('## CONTEXTO DO CODEBASE');
  });

  // Ordem CANONICA do blueprint: regras (documentadas) ACIMA do contexto (padrao observado),
  // e o DIFF por ultimo. "Regra documentada vence padrao observado" — por isso as regras vem
  // antes do pack, e o pack antes do diff que ele contextualiza.
  it('injeta CONTEXTO entre as ADRs/regras e o DIFF (ordem regras < contexto < diff)', () => {
    const u = buildUserPrompt({
      repoRules: 'REGRA: usar lock distribuido',
      langPacks: [], adrs: 'ADR-001: hexagonal', diff: '+const x = 1;',
      contextPack: 'PADRAO_OBSERVADO_NO_REPO',
    });
    const idxRegras = u.indexOf('REGRA: usar lock distribuido');
    const idxAdr = u.indexOf('ADR-001: hexagonal');
    const idxContexto = u.indexOf('## CONTEXTO DO CODEBASE');
    const idxDiff = u.indexOf('## DIFF DO PR');
    expect(idxRegras).toBeGreaterThanOrEqual(0);
    expect(idxAdr).toBeLessThan(idxContexto);   // ADRs antes do contexto
    expect(idxRegras).toBeLessThan(idxContexto); // regras antes do contexto
    expect(idxContexto).toBeLessThan(idxDiff);   // contexto antes do diff
  });
});
