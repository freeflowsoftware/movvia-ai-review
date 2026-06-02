// tests/agent-runner-cli.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRepoRules, loadLangPacks, loadAdrs } from '../lib/agent-runner-cli.js';

describe('loadRepoRules', () => {
  it('concatena .claude/rules/*.md e CLAUDE.md do repo alvo', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-'));
    mkdirSync(join(dir, '.claude', 'rules'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'rules', 'locks.md'), 'REGRA LOCK');
    writeFileSync(join(dir, 'CLAUDE.md'), 'REGRA RAIZ');
    const out = loadRepoRules(dir);
    expect(out).toContain('REGRA LOCK');
    expect(out).toContain('REGRA RAIZ');
  });
  it('retorna string vazia quando nao ha regras', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-'));
    expect(loadRepoRules(dir)).toBe('');
  });
});

describe('loadLangPacks', () => {
  it('carrega o lang-pack das linguagens detectadas', () => {
    const central = mkdtempSync(join(tmpdir(), 'central-'));
    mkdirSync(join(central, 'lang-packs'), { recursive: true });
    writeFileSync(join(central, 'lang-packs', 'java.md'), 'JAVA LAZY');
    const out = loadLangPacks(['Foo.java'], central);
    expect(out.join(' ')).toContain('JAVA LAZY');
  });
});

describe('loadAdrs', () => {
  // Regressao: antes o contexto de ADR era um placeholder estatico
  // ('(ADRs disponiveis no repo de docs)') que dava ao agente um stub inutil na
  // secao "## ADRs relevantes" do prompt. Agora carrega o conteudo real via ADR_GLOBS.
  it('carrega o conteudo dos ADRs do repo (docs/adr e ADR-*.md)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-'));
    mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'adr', '001-locks.md'), 'DECISAO LOCK DISTRIBUIDO');
    writeFileSync(join(dir, 'ADR-002.md'), 'DECISAO ENUM VARCHAR');
    const out = loadAdrs(dir);
    expect(out).toContain('DECISAO LOCK DISTRIBUIDO');
    expect(out).toContain('DECISAO ENUM VARCHAR');
  });
  it('retorna string vazia quando nao ha ADRs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-'));
    expect(loadAdrs(dir)).toBe('');
  });
});
