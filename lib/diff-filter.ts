import { minimatch } from 'minimatch';

/**
 * Globs de arquivos GERADOS por ferramenta (lockfiles, saidas de build, snapshots) que
 * nenhum humano revisa e que so inflam o diff. Um `pnpm-lock.yaml` sozinho passa de
 * centenas de milhares de linhas: no PR #863 do pe-portais o diff cru estourou o teto de
 * 1.048.576 tokens do LLM (~2,15M enviados) e o agente de seguranca degradou (HTTP 400).
 * Remover estes blocos do diff corta o ruido NA ORIGEM — os revisores (seguranca,
 * performance, arquitetura...) nao tem o que dizer sobre um arquivo gerado por maquina.
 */
export const GENERATED_FILE_GLOBS: string[] = [
  '**/pnpm-lock.yaml',
  '**/package-lock.json',
  '**/npm-shrinkwrap.json',
  '**/yarn.lock',
  '**/bun.lockb',
  '**/composer.lock',
  '**/Gemfile.lock',
  '**/poetry.lock',
  '**/Pipfile.lock',
  '**/Cargo.lock',
  '**/go.sum',
  '**/*.snap',
  '**/dist/**',
  '**/build/**',
  '**/.next/**',
  '**/coverage/**',
];

/** Verdadeiro se o caminho casa algum glob de arquivo gerado (GENERATED_FILE_GLOBS). */
function isGeneratedFile(path: string): boolean {
  return GENERATED_FILE_GLOBS.some((glob) => minimatch(path, glob));
}

/**
 * Quebra o diff unificado em blocos por arquivo. Cada bloco comeca em `diff --git ` — o
 * lookahead mantem o delimitador no inicio de cada parte, entao `join('')` reconstroi o
 * texto original byte a byte. Qualquer preambulo antes do primeiro `diff --git ` vira o
 * primeiro elemento (nao comeca com o delimitador) e e preservado.
 */
function splitDiffByFile(diff: string): string[] {
  return diff.split(/(?=^diff --git )/m).filter((block) => block !== '');
}

/**
 * Caminho (lado `b/`, o estado novo) de UM bloco de arquivo do diff, ou null se nao der
 * para identificar. Prioriza `+++ b/<path>` (mesma ancora que o resto do pipeline usa em
 * `changedFilesFromDiff`); cai no header `diff --git a/… b/<path>` quando nao ha `+++ b/`
 * (arquivo deletado tem `+++ /dev/null`; binario pode nem ter linha `+++`).
 */
function fileBlockPath(block: string): string | null {
  const addedLine = /^\+\+\+ b\/(.+)$/m.exec(block);
  if (addedLine?.[1]) return addedLine[1];
  const header = /^diff --git a\/.+ b\/(.+)$/m.exec(block);
  return header?.[1] ?? null;
}

/**
 * Remove do diff unificado os blocos de arquivos GERADOS (ver GENERATED_FILE_GLOBS),
 * preservando ordem e conteudo dos demais. Bloco sem caminho identificavel e MANTIDO
 * (conservador: nunca descartamos o que nao conseguimos classificar). Esta e a "Opcao 1"
 * do diagnostico do PR #863 — limpar o diff na origem para nao estourar o teto de tokens.
 *
 * @example
 * stripGeneratedFiles(diffComLockfile) // => mesmo diff sem o bloco do pnpm-lock.yaml
 */
export function stripGeneratedFiles(diff: string): string {
  return splitDiffByFile(diff)
    .filter((block) => {
      const path = fileBlockPath(block);
      return path === null || !isGeneratedFile(path);
    })
    .join('');
}
