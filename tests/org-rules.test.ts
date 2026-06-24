import { describe, it, expect } from 'vitest';
import { parseOrgRule, orgRuleApplies, selectOrgRules } from '../lib/org-rules.js';

// As org-rules sao as regras COMPARTILHADAS da Movvia (lock financeiro, sem enum nativo,
// skeleton loading...) que hoje vivem no super-repo NAO-versionado e nao chegam ao CI.
// Movidas para o repo central, viajam com a Action e sao injetadas por ROTEAMENTO: cada
// regra declara um `appliesTo` (globs) no frontmatter; sem appliesTo = aplica sempre.

describe('parseOrgRule', () => {
  it('sem frontmatter -> appliesTo null (aplica sempre) e body = conteudo cru', () => {
    const r = parseOrgRule('# Regra X\n\ntexto');
    expect(r.appliesTo).toBeNull();
    expect(r.body).toBe('# Regra X\n\ntexto');
  });

  it('frontmatter com appliesTo em block list -> array de globs + body sem frontmatter', () => {
    const content = '---\nappliesTo:\n  - "**/*.ts"\n  - "**/*.spec.ts"\n---\n# NestJS rule\ncorpo';
    const r = parseOrgRule(content);
    expect(r.appliesTo).toEqual(['**/*.ts', '**/*.spec.ts']);
    expect(r.body).toBe('# NestJS rule\ncorpo');
  });

  it('frontmatter com appliesTo inline ["a","b"] -> array', () => {
    const r = parseOrgRule('---\nappliesTo: ["**/*.java", "**/*.sql"]\n---\ncorpo');
    expect(r.appliesTo).toEqual(['**/*.java', '**/*.sql']);
  });

  it('frontmatter SEM appliesTo -> null (aplica sempre)', () => {
    const r = parseOrgRule('---\ntitle: x\n---\ncorpo');
    expect(r.appliesTo).toBeNull();
    expect(r.body).toBe('corpo');
  });
});

describe('orgRuleApplies', () => {
  it('appliesTo null aplica a qualquer diff (regra transversal, ex: credenciais)', () => {
    expect(orgRuleApplies(null, ['x.java'])).toBe(true);
    expect(orgRuleApplies(null, [])).toBe(true);
  });

  it('aplica quando ALGUM arquivo alterado casa ALGUM glob', () => {
    expect(orgRuleApplies(['**/*.ts'], ['src/conta.service.ts', 'README.md'])).toBe(true);
  });

  it('NAO aplica quando nenhum arquivo casa (regra de outra stack)', () => {
    // Regra Java num PR so de TypeScript -> nao injeta (economiza contexto + foco).
    expect(orgRuleApplies(['**/*.java'], ['src/a.ts', 'src/b.tsx'])).toBe(false);
  });

  it('nextjs-trailing-slash: casa tsx de componente frontend, nao casa service.ts backend', () => {
    const appliesTo = ['**/*.tsx'];
    // Componente React do pe-portais — deve injetar a regra
    expect(orgRuleApplies(appliesTo, ['apps/pe-portal/components/layout/footer/FooterHelp.tsx'])).toBe(true);
    // Arquivo de dados TypeScript — nao e um componente, regra nao se aplica
    expect(orgRuleApplies(appliesTo, ['apps/pe-portal/data/footerData.ts'])).toBe(false);
    // Servico NestJS backend — regra Next.js nao deve injetar em PRs backend
    expect(orgRuleApplies(appliesTo, ['src/conta/conta.service.ts'])).toBe(false);
  });
});

describe('selectOrgRules', () => {
  const rules = [
    { name: 'cred.md', content: '# Credenciais\nnunca hardcode' }, // sem frontmatter -> sempre
    { name: 'nest.md', content: '---\nappliesTo:\n  - "**/*.ts"\n---\n# Nest\nlock' },
    { name: 'java.md', content: '---\nappliesTo:\n  - "**/*.java"\n---\n# Java\nhexagonal' },
  ];

  it('PR TypeScript: injeta a transversal + a de Node, NAO a de Java', () => {
    const out = selectOrgRules(rules, ['src/conta.service.ts']);
    expect(out).toEqual(['# Credenciais\nnunca hardcode', '# Nest\nlock']);
  });

  it('PR Java: injeta a transversal + a de Java, NAO a de Node', () => {
    const out = selectOrgRules(rules, ['Foo.java']);
    expect(out).toEqual(['# Credenciais\nnunca hardcode', '# Java\nhexagonal']);
  });

  it('PR misto (Node + Java): injeta as tres', () => {
    const out = selectOrgRules(rules, ['a.ts', 'B.java']);
    expect(out).toEqual(['# Credenciais\nnunca hardcode', '# Nest\nlock', '# Java\nhexagonal']);
  });

  it('diff sem match de stack: injeta so as transversais (sem appliesTo)', () => {
    const out = selectOrgRules(rules, ['docs/x.md']);
    expect(out).toEqual(['# Credenciais\nnunca hardcode']);
  });
});
