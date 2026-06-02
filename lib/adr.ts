import { minimatch } from 'minimatch';

export const ARCH_GLOBS = [
  'pe-migrations/**',
  '**/schema.prisma',
  '**/Dockerfile',
  'pe-infra/**',
  '**/application*.yml',
  '**/domain/**',
];

export const ADR_GLOBS = [
  '**/adr/**',
  '**/ADR-*.md',
  'docs/**/ADR-*.md',
];

const ADR_REF = /\bADR-\d+\b/i;

export function needsAdr(changedFiles: string[], archGlobs: string[]): boolean {
  return changedFiles.some((f) => archGlobs.some((g) => minimatch(f, g)));
}

export function hasAdr(changedFiles: string[], prBody: string, adrGlobs: string[]): boolean {
  if (changedFiles.some((f) => adrGlobs.some((g) => minimatch(f, g)))) return true;
  return ADR_REF.test(prBody);
}

// CLI: arquivos via stdin (1 por linha) + corpo do PR em PR_BODY. exit 1 se faltar ADR.
if (process.argv[1]?.endsWith('adr.ts')) {
  const files = (await new Promise<string>((r) => {
    let d = ''; process.stdin.on('data', (c) => (d += c)); process.stdin.on('end', () => r(d));
  })).split('\n').map((s) => s.trim()).filter(Boolean);
  const body = process.env.PR_BODY ?? '';
  if (needsAdr(files, ARCH_GLOBS) && !hasAdr(files, body, ADR_GLOBS)) {
    console.error('::error::Mudanca arquitetural sem ADR. Adicione/refira um ADR (ADR-NNN).');
    process.exit(1);
  }
  console.log('ADR gate OK');
}
