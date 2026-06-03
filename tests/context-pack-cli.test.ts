import { describe, it, expect } from 'vitest';
import { loadContextPackOpts, changedFilesFromDiff } from '../lib/context-pack-cli.js';

/** Fake nomeado do leitor de YAML — devolve o texto fixado sem tocar o disco (regra Movvia). */
function fakeYamlReader(yaml: string): (path: string) => string {
  return () => yaml;
}

describe('loadContextPackOpts', () => {
  it('mapeia o bloco context_pack snake_case para ContextPackOpts camelCase', () => {
    const yaml = [
      'context_pack:',
      '  max_tokens: 50000',
      '  max_siblings: 2',
      '  max_imports: 3',
      '  max_exemplars: 1',
      '  skeleton_loc_threshold: 200',
    ].join('\n');
    const opts = loadContextPackOpts('ignored', fakeYamlReader(yaml));
    expect(opts).toEqual({
      maxTokens: 50000,
      maxSiblings: 2,
      maxImports: 3,
      maxExemplars: 1,
      skeletonLocThreshold: 200,
    });
  });

  // Degradacao graciosa: bloco ausente => cai nos defaults do blueprint (pack menor, nunca quebra).
  it('cai nos defaults do blueprint quando nao ha bloco context_pack', () => {
    const opts = loadContextPackOpts('ignored', fakeYamlReader('gatekeeper:\n  adversarial_threshold: 0.8'));
    expect(opts).toEqual({
      maxTokens: 100000,
      maxSiblings: 4,
      maxImports: 6,
      maxExemplars: 3,
      skeletonLocThreshold: 400,
    });
  });

  it('usa o default por campo quando so alguns valores estao presentes', () => {
    const opts = loadContextPackOpts('ignored', fakeYamlReader('context_pack:\n  max_tokens: 1'));
    expect(opts.maxTokens).toBe(1);          // do YAML
    expect(opts.maxSiblings).toBe(4);        // default
    expect(opts.skeletonLocThreshold).toBe(400); // default
  });
});

describe('changedFilesFromDiff', () => {
  it('extrai os caminhos de "+++ b/<path>" do diff unificado', () => {
    const diff = [
      'diff --git a/src/conta.service.ts b/src/conta.service.ts',
      '--- a/src/conta.service.ts',
      '+++ b/src/conta.service.ts',
      '@@ -1 +1 @@',
      '+const x = 1;',
      'diff --git a/Foo.java b/Foo.java',
      '+++ b/Foo.java',
    ].join('\n');
    expect(changedFilesFromDiff(diff)).toEqual(['src/conta.service.ts', 'Foo.java']);
  });

  it('retorna lista vazia para diff sem cabecalhos de arquivo', () => {
    expect(changedFilesFromDiff('texto qualquer sem diff')).toEqual([]);
  });
});
