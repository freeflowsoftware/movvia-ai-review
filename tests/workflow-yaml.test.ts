import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

// Os arquivos de workflow sao o artefato sob teste: o GitHub Actions usa um parser
// proprio tolerante, mas yamllint/pre-commit/actionlint-via-yaml usam YAML 1.2 estrito.
// Expressoes ${{ }} dentro de flow-mappings ({ k: ${{ x }} }) sao rejeitadas como
// flow-map-start inesperado. Este teste garante que os YAMLs commitados sejam validos
// sob YAML 1.2 (block style nas linhas com expressao).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const yamlFiles = [
  '.github/workflows/ai-review.yml',
  '.github/caller-template.yml',
  'config/defaults.yml',
];

describe('YAMLs do projeto parseiam sob YAML 1.2 estrito', () => {
  for (const relPath of yamlFiles) {
    it(`${relPath} e valido em YAML 1.2`, () => {
      const src = readFileSync(resolve(repoRoot, relPath), 'utf8');
      expect(() => YAML.parse(src)).not.toThrow();
    });
  }
});
