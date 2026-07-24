import { Minimatch } from 'minimatch';

/**
 * Globs de arquivos INEQUIVOCAMENTE gerados por ferramenta (lockfiles e snapshots) que
 * nenhum humano escreve a mao e que so inflam o diff. Um `pnpm-lock.yaml` sozinho passa de
 * centenas de milhares de linhas: no PR #863 do pe-portais o diff cru estourou o teto de
 * 1.048.576 tokens do LLM (~2,15M enviados) e o agente de seguranca degradou (HTTP 400).
 *
 * DELIBERADAMENTE conservador (review de PR #19): NAO listamos diretorios de saida inteiros
 * (`dist/`, `build/`, `.next/`, `coverage/`). Descartar por diretorio criaria um BLIND SPOT
 * de seguranca — um autor poderia esconder codigo real sob `build/` e ele nunca seria
 * revisado — alem de arriscar podar um diretorio de fonte legitimamente chamado `dist`.
 * Estes dirs quase sempre estao no .gitignore (nao aparecem no diff); o culpado real do
 * estouro sao os lockfiles. O caso raro de saida de build gigante fica para o teto de
 * tokens defensivo (Opcao 2), nao para uma allowlist por caminho.
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
];

// Pre-compila os globs UMA vez no escopo do modulo (review de perf, PR #19): a forma
// funcional `minimatch(path, glob)` recompilaria cada glob em regex a cada chamada, e o
// predicado roda por bloco do diff (N blocos x M globs). Compilar uma vez troca
// O(N x M compilacoes) por O(M compilacoes) + O(N x M matches).
const GENERATED_MATCHERS: Minimatch[] = GENERATED_FILE_GLOBS.map((glob) => new Minimatch(glob));

/** Verdadeiro se o caminho casa algum glob de arquivo gerado (GENERATED_MATCHERS). */
function isGeneratedFile(path: string): boolean {
  return GENERATED_MATCHERS.some((matcher) => matcher.match(path));
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
 * LIMITACOES CONHECIDAS (conservadoras — sub-remocao, nunca corrupcao nem descarte
 * indevido de codigo real; review de PR #19): assume diff `git`-style de dois pontos
 * (`diff --git`), nao diffs combinados de merge (`diff --cc`/`--combined`); paths entre
 * aspas (git `core.quotepath` com nao-ASCII) nao sao reconhecidos e o bloco e mantido. Em
 * ambos os casos o arquivo gerado escapa do filtro (no-op), mas nada legitimo e removido.
 * Irrelevante para lockfiles, cujos caminhos sao sempre ASCII.
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
