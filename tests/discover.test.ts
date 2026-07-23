import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAgentFile, toMatrix } from '../lib/discover.js';

const RAW = `---
name: seguranca
dimension: security
model: ""
paths: ["**/*"]
severity_hints:
  P0: "credencial hardcoded"
  P1: "validacao faltando"
---
Voce e o revisor de SEGURANCA. Cite [arquivo:linha].`;

describe('parseAgentFile', () => {
  it('extrai frontmatter e persona', () => {
    const spec = parseAgentFile(RAW, 'agents/seguranca.md');
    expect(spec.name).toBe('seguranca');
    expect(spec.dimension).toBe('security');
    expect(spec.model).toBe('');
    expect(spec.paths).toEqual(['**/*']);
    expect(spec.severityHints.P0).toBe('credencial hardcoded');
    expect(spec.persona).toContain('revisor de SEGURANCA');
  });

  it('lanca erro com o caminho quando name ausente', () => {
    const bad = `---\ndimension: security\n---\ncorpo`;
    expect(() => parseAgentFile(bad, 'agents/x.md')).toThrow(/agents\/x\.md.*name/);
  });
});

describe('toMatrix', () => {
  it('monta {include:[...]} com um item por agente', () => {
    const spec = parseAgentFile(RAW, 'agents/seguranca.md');
    const m = toMatrix([spec]);
    expect(m.include).toHaveLength(1);
    expect(m.include[0]).toMatchObject({ name: 'seguranca', file: 'agents/seguranca.md' });
  });
});

// Regressao (pe-portais#695/#696): o agente de requisitos confronta criterio de aceite contra
// o diff — tarefa de raciocinio que o Flash-Lite errava (alegava ausencia de algo presente).
// O frontmatter DEVE fixar deepseek, como seguranca/regressao/arquitetura. Se alguem reverter
// model para "" (cai no Flash-Lite via DEFAULT_MODEL), este teste quebra.
describe('agente de requisitos roda em modelo de raciocinio', () => {
  it('agents/requisitos.md fixa deepseek-v4-flash no frontmatter', () => {
    const spec = parseAgentFile(readFileSync('agents/requisitos.md', 'utf8'), 'agents/requisitos.md');
    expect(spec.model).toBe('deepseek/deepseek-v4-flash');
  });
});
