import { describe, it, expect } from 'vitest';
import { stripGeneratedFiles, GENERATED_FILE_GLOBS } from '../lib/diff-filter.js';

/** Monta um bloco de diff unificado minimo (header + hunk) para UM arquivo modificado. */
function fileBlock(path: string, addedLine: string): string {
  return [
    `diff --git a/${path} b/${path}`,
    'index 1111111..2222222 100644',
    `--- a/${path}`,
    `+++ b/${path}`,
    '@@ -1,1 +1,2 @@',
    ' contexto',
    `+${addedLine}`,
    '',
  ].join('\n');
}

describe('stripGeneratedFiles', () => {
  it('remove o bloco do pnpm-lock.yaml e mantem o codigo real', () => {
    const diff = fileBlock('src/app.service.ts', 'const x = 1;') + fileBlock('pnpm-lock.yaml', 'lodash@4.17.21');

    const filtered = stripGeneratedFiles(diff);

    expect(filtered).toContain('src/app.service.ts');
    expect(filtered).not.toContain('pnpm-lock.yaml');
    expect(filtered).toContain('const x = 1;');
  });

  it('remove lockfile aninhado em subdiretorio de monorepo', () => {
    const diff = fileBlock('apps/pe-portal/pnpm-lock.yaml', 'x') + fileBlock('apps/pe-portal/page.tsx', 'y');

    const filtered = stripGeneratedFiles(diff);

    expect(filtered).not.toContain('pnpm-lock.yaml');
    expect(filtered).toContain('apps/pe-portal/page.tsx');
  });

  it('remove saidas de build e snapshots', () => {
    const diff =
      fileBlock('dist/main.js', 'a') +
      fileBlock('coverage/lcov.info', 'b') +
      fileBlock('src/__snapshots__/x.test.ts.snap', 'c') +
      fileBlock('src/real.ts', 'd');

    const filtered = stripGeneratedFiles(diff);

    expect(filtered).toContain('src/real.ts');
    expect(filtered).not.toContain('dist/main.js');
    expect(filtered).not.toContain('coverage/lcov.info');
    expect(filtered).not.toContain('.snap');
  });

  it('preserva byte a byte um diff sem arquivos gerados', () => {
    const diff = fileBlock('a.ts', 'um') + fileBlock('b.java', 'dois');

    expect(stripGeneratedFiles(diff)).toBe(diff);
  });

  it('mantem bloco sem caminho identificavel (conservador)', () => {
    const preamble = 'linha solta sem header de arquivo\n';
    const diff = preamble + fileBlock('a.ts', 'x');

    expect(stripGeneratedFiles(diff)).toContain('linha solta sem header');
  });

  it('devolve string vazia para diff vazio', () => {
    expect(stripGeneratedFiles('')).toBe('');
  });

  it('expoe os globs de arquivos gerados como constante', () => {
    expect(GENERATED_FILE_GLOBS).toContain('**/pnpm-lock.yaml');
    expect(GENERATED_FILE_GLOBS.length).toBeGreaterThan(0);
  });
});
