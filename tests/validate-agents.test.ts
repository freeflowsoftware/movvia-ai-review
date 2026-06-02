// tests/validate-agents.test.ts
import { describe, it, expect } from 'vitest';
import { validateSpecs } from '../scripts/validate-agents.js';
import { parseAgentFile } from '../lib/discover.js';

const ok = parseAgentFile(`---\nname: a\ndimension: d\n---\ncorpo`, 'agents/a.md');
const semPersona = parseAgentFile(`---\nname: b\ndimension: d\n---\n`, 'agents/b.md');

describe('validateSpecs', () => {
  it('sem erros quando todos validos', () => {
    expect(validateSpecs([ok])).toEqual([]);
  });
  it('aponta nome duplicado', () => {
    const dup = parseAgentFile(`---\nname: a\ndimension: d\n---\noutro`, 'agents/a2.md');
    expect(validateSpecs([ok, dup]).join(' ')).toMatch(/duplicad/);
  });
  it('aponta persona vazia', () => {
    expect(validateSpecs([semPersona]).join(' ')).toMatch(/persona/);
  });
  it('aponta name fora de kebab-case', () => {
    const naoKebab = parseAgentFile(`---\nname: A_Bad\ndimension: d\n---\ncorpo`, 'agents/a-bad.md');
    expect(validateSpecs([naoKebab]).join(' ')).toMatch(/kebab/);
  });
});
