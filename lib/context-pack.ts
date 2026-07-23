import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, extname, basename } from 'node:path';

/**
 * Porta de leitura do filesystem (DIP, borda externa — regra Movvia de injecao de I/O).
 * As funcoes do context-pack so leem; nunca escrevem. Testes injetam um fake nomeado
 * (FakeFileSystemReader) para exercitar degradacao graciosa sem tocar o disco real.
 */
export interface FileSystemReader {
  readFile(absPath: string): string;
  listDir(absPath: string): string[];
  exists(absPath: string): boolean;
  isFile(absPath: string): boolean;
}

/** Implementacao real sobre node:fs. Lanca em erro — quem chama isola via try/catch por camada. */
export const nodeFileSystemReader: FileSystemReader = {
  readFile: (p) => readFileSync(p, 'utf8'),
  listDir: (p) => readdirSync(p),
  exists: (p) => existsSync(p),
  isFile: (p) => statSync(p).isFile(),
};

/** Um trecho de codigo no pack, sempre com o caminho relativo ao repo para o LLM ancorar. */
export interface PackFile {
  /** Caminho relativo ao repoDir (POSIX). */
  path: string;
  content: string;
  /** true quando o conteudo foi reduzido a assinaturas (skeletonize). */
  skeletonized: boolean;
}

/** As 4 camadas de contexto de UM arquivo alterado (ver FASE 1 do blueprint). */
export interface FileContextLayers {
  /** Caminho do arquivo alterado (chave do pack). */
  file: string;
  /** Camada 1: o arquivo alterado INTEIRO (nunca skeletonizado, nunca cortado por budget). */
  changed: PackFile;
  /** Camada 2: irmaos do mesmo diretorio, mesma extensao, priorizando mesmo sufixo. */
  siblings: PackFile[];
  /** Camada 3: imports intra-repo resolvidos (1 nivel). */
  imports: PackFile[];
  /** Camada 4: exemplares maduros do mesmo tipo/sufixo (maior LOC). */
  exemplars: PackFile[];
}

/**
 * Índice de PRESENÇA do repo inteiro (deterministico, sem LLM). Serializado no artefato
 * mas NUNCA injetado em prompt — consumido só pelo guard determinístico do gatekeeper
 * (refuteByPresence), que descarta findings de AUSÊNCIA cujo símbolo/teste/env existe de
 * fato. Mata a maior classe de falso-positivo (model/componente/teste/env "ausente" que
 * está no repo, fora da janela do context-pack) a custo ZERO de token de LLM.
 */
export interface PresenceIndex {
  /** Nomes declarados no repo: model/enum/type Prisma, class/interface/function/const TS/Java/Py. */
  symbols: string[];
  /** Sujeitos de arquivos de teste (ex: `useIsAndroid` de `useIsAndroid.test.ts`, `Foo` de `FooTest.java`). */
  testSubjects: string[];
  /** Chaves presentes em qualquer `.env*.example` (ex: `ENABLE_CONSULTA_ALERTA_REMINDERS`). */
  envKeys: string[];
}

export interface ContextPack {
  files: FileContextLayers[];
  /** Índice de presença do repo inteiro (metadado; ver PresenceIndex). */
  presenceIndex: PresenceIndex;
}

export interface ContextPackOpts {
  maxSiblings: number;
  maxImports: number;
  maxExemplars: number;
  /** Arquivos com mais LOC que isto sao skeletonizados (exceto o alterado). */
  skeletonLocThreshold: number;
  /** Cap rigido de tokens do pack inteiro. Corte por prioridade quando excede. */
  maxTokens: number;
}

/** Mapa de aliases tsconfig (`@pe/*` -> `src/pe/*`) ja com o `*` removido das pontas. */
type AliasMap = Map<string, string>;

// ---------------------------------------------------------------------------
// Camada 1 — arquivo alterado inteiro
// ---------------------------------------------------------------------------

/** Le o arquivo alterado INTEIRO. Camada 1: sempre inteiro, nunca skeletonizado (blueprint). */
function readChangedWhole(fs: FileSystemReader, repoDir: string, file: string): PackFile {
  return { path: toPosix(file), content: fs.readFile(join(repoDir, file)), skeletonized: false };
}

// ---------------------------------------------------------------------------
// Camada 2 — irmaos do diretorio
// ---------------------------------------------------------------------------

/**
 * Irmaos do mesmo diretorio com a MESMA extensao do arquivo alterado, priorizando os de
 * mesmo sufixo composto (ex: `*.service.ts`) — onde mora o padrao local que mata o FP
 * "validacao ausente". `max` limita a cota (blueprint: <=4). Exclui o proprio arquivo.
 */
export function collectSiblings(
  fs: FileSystemReader,
  repoDir: string,
  file: string,
  max: number,
): PackFile[] {
  const dir = dirname(file);
  const ext = extname(file);
  const suffix = composedSuffix(file);
  const self = toPosix(file);
  const entries = fs
    .listDir(join(repoDir, dir))
    .filter((name) => extname(name) === ext && toPosix(join(dir, name)) !== self);
  const ranked = rankBySuffix(entries, suffix);
  return takeAsPackFiles(fs, repoDir, dir, ranked, max);
}

/** Ordena vizinhos: os de mesmo sufixo composto primeiro, depois o resto (estavel por nome). */
function rankBySuffix(entries: string[], suffix: string): string[] {
  const sorted = [...entries].sort();
  const sameSuffix = sorted.filter((n) => suffix !== '' && n.endsWith(suffix));
  const rest = sorted.filter((n) => !(suffix !== '' && n.endsWith(suffix)));
  return [...sameSuffix, ...rest];
}

/** Pega ate `max` nomes do diretorio `dir` e le cada um como PackFile (caminho relativo). */
function takeAsPackFiles(
  fs: FileSystemReader,
  repoDir: string,
  dir: string,
  names: string[],
  max: number,
): PackFile[] {
  return names.slice(0, max).map((name) => readNeighbor(fs, repoDir, join(dir, name)));
}

// ---------------------------------------------------------------------------
// Camada 3 — imports intra-repo (1 nivel)
// ---------------------------------------------------------------------------

const IMPORT_REGEXES: RegExp[] = [
  /\bfrom\s+['"]([^'"]+)['"]/g, // TS/JS: import ... from '...'
  /\bimport\s+['"]([^'"]+)['"]/g, // TS/JS side-effect: import '...'
  /^\s*import\s+([\w.]+)\s*;/gm, // Java: import x.y.Z;
  /^\s*from\s+([\w.]+)\s+import\b/gm, // Python: from x.y import z
];

/**
 * Resolve imports RELATIVOS/intra-repo do conteudo (1 nivel) para suas assinaturas reais —
 * camada que mata o FP "API/metodo inventado". `aliases` (tsconfig.paths) expande `@pe/*`.
 * Best-effort: import nao-resolvido e simplesmente omitido (NUNCA vira evidencia de ausencia).
 */
export function resolveIntraRepoImports(
  fs: FileSystemReader,
  fileContent: string,
  repoDir: string,
  fromFile: string,
  aliases: AliasMap,
  max: number,
): PackFile[] {
  const specifiers = extractImportSpecifiers(fileContent);
  const out: PackFile[] = [];
  const seen = new Set<string>();
  for (const spec of specifiers) {
    if (out.length >= max) break;
    const resolved = resolveSpecifier(fs, repoDir, fromFile, spec, aliases);
    if (resolved === null || seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(readNeighbor(fs, repoDir, resolved));
  }
  return out;
}

/** Todos os especificadores de import do conteudo, deduplicados na ordem de aparicao. */
function extractImportSpecifiers(content: string): string[] {
  const specs: string[] = [];
  for (const re of IMPORT_REGEXES) {
    for (const m of content.matchAll(re)) {
      const spec = m[1];
      if (spec && !specs.includes(spec)) specs.push(spec);
    }
  }
  return specs;
}

/**
 * Resolve UM especificador para um caminho relativo ao repo, ou null se nao for intra-repo.
 * Ordem: relativo (`./`,`../`) -> alias tsconfig -> dotted Java/Py (`a.b.C`). So retorna se
 * o arquivo existir de fato dentro do repo (best-effort; cross-repo/classpath fica de fora).
 */
function resolveSpecifier(
  fs: FileSystemReader,
  repoDir: string,
  fromFile: string,
  spec: string,
  aliases: AliasMap,
): string | null {
  if (spec.startsWith('.')) return resolveRelative(fs, repoDir, fromFile, spec);
  const aliased = expandAlias(spec, aliases);
  if (aliased !== null) return existingWithExt(fs, repoDir, aliased);
  if (spec.includes('.')) return existingWithExt(fs, repoDir, spec.split('.').join('/'));
  return null;
}

/** Junta o import relativo ao diretorio do arquivo de origem e tenta extensoes conhecidas. */
function resolveRelative(
  fs: FileSystemReader,
  repoDir: string,
  fromFile: string,
  spec: string,
): string | null {
  const base = toPosix(join(dirname(fromFile), spec));
  return existingWithExt(fs, repoDir, base);
}

/** Expande `@pe/foo` -> `src/pe/foo` usando o primeiro alias cujo prefixo casa. */
function expandAlias(spec: string, aliases: AliasMap): string | null {
  for (const [prefix, target] of aliases) {
    if (spec === prefix) return target;
    if (spec.startsWith(`${prefix}/`)) return `${target}/${spec.slice(prefix.length + 1)}`;
  }
  return null;
}

const RESOLVE_EXTS = ['', '.ts', '.tsx', '.js', '.jsx', '.java', '.py'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js'];

/** Primeiro caminho que existe como arquivo (base, base+ext, base/index.*), ou null. */
function existingWithExt(fs: FileSystemReader, repoDir: string, base: string): string | null {
  for (const ext of RESOLVE_EXTS) {
    const rel = `${base}${ext}`;
    if (isExistingFile(fs, repoDir, rel)) return rel;
  }
  for (const idx of INDEX_FILES) {
    const rel = `${base}/${idx}`;
    if (isExistingFile(fs, repoDir, rel)) return rel;
  }
  return null;
}

function isExistingFile(fs: FileSystemReader, repoDir: string, rel: string): boolean {
  if (rel === '') return false;
  const abs = join(repoDir, rel);
  return fs.exists(abs) && fs.isFile(abs);
}

// ---------------------------------------------------------------------------
// Camada 4 — exemplares maduros do mesmo tipo
// ---------------------------------------------------------------------------

/**
 * Exemplares maduros do mesmo SUFIXO no repo inteiro (ex: `*.dto.ts`), escolhendo os de
 * maior LOC — os mais completos servem de molde e matam o FP "teste sem assert". Exclui o
 * proprio arquivo alterado. `max` limita a cota (blueprint: <=3).
 */
export function collectExemplars(
  fs: FileSystemReader,
  repoDir: string,
  suffix: string,
  excludeFile: string,
  max: number,
): PackFile[] {
  if (suffix === '') return [];
  const candidates = walkRepo(fs, repoDir)
    .filter((rel) => rel.endsWith(suffix) && rel !== toPosix(excludeFile))
    .map((rel) => ({ rel, loc: countLines(fs.readFile(join(repoDir, rel))) }))
    .sort((a, b) => b.loc - a.loc)
    .slice(0, max);
  return candidates.map(({ rel }) => readNeighbor(fs, repoDir, rel));
}

const WALK_IGNORE = /(^|\/)(node_modules|\.git|dist|target|build|\.next|coverage)(\/|$)/;

/** Lista recursiva de arquivos relativos ao repo, pulando diretorios de build/deps. */
function walkRepo(fs: FileSystemReader, repoDir: string): string[] {
  const out: string[] = [];
  const stack = [''];
  while (stack.length > 0) {
    const rel = stack.pop() as string;
    if (rel !== '' && WALK_IGNORE.test(rel)) continue;
    for (const name of fs.listDir(join(repoDir, rel))) {
      const childRel = rel === '' ? name : `${rel}/${name}`;
      if (fs.isFile(join(repoDir, childRel))) out.push(childRel);
      else stack.push(childRel);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Skeletonize
// ---------------------------------------------------------------------------

// Declaracao estrutural (TS/Java/Py): classe, interface, enum, type, decorator, def/function.
const DECLARATION_REGEX =
  /^\s*(@|(export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|abstract\s+|default\s+)*\b(class|interface|enum|namespace|module|type|function|def|record|struct)\b)/;

// Assinatura de metodo/funcao que abre bloco `{` OU declara membro de interface/abstrato `;`.
// Exige parenteses `(...)` para nao confundir com objeto literal/atribuicao simples.
const METHOD_SIGNATURE_REGEX = /^\s*[\w<>,.\s@*[\]?:|&]*\([^)]*\)\s*(:[^={};]+)?\s*[{;]\s*$/;

// Expressao de funcao atribuida (const fn = (...) => / = function). Mantemos so a assinatura.
const FUNCTION_EXPR_REGEX = /^\s*(export\s+)?(const|let|var)\s+\w+\s*[:=].*(=>|\bfunction\b)/;

/**
 * Verdadeiro se a linha PARECE uma assinatura/declaracao (e nao corpo/statement). Mantemos
 * declaracoes estruturais, assinaturas de metodo e funcoes atribuidas; descartamos
 * atribuicoes simples (`const v = 0;`) e linhas de corpo. Heuristico por linha (sem AST).
 */
function isSignatureLine(line: string): boolean {
  if (DECLARATION_REGEX.test(line)) return true;
  if (FUNCTION_EXPR_REGEX.test(line)) return true;
  if (METHOD_SIGNATURE_REGEX.test(line) && line.includes('(')) return true;
  return false;
}

/**
 * Reduz o conteudo a "assinaturas" (linhas que parecem declaracoes/metodos) — usado em
 * arquivos grandes (>threshold) das camadas 2-4 para caber no budget sem perder a forma da
 * API. Heuristico via regex de proposito: nao parseamos AST (custo/3 linguagens). O arquivo
 * ALTERADO nunca passa por aqui (camada 1 e sempre inteira).
 */
export function skeletonize(content: string): string {
  return content
    .split('\n')
    .filter((line) => isSignatureLine(line))
    .join('\n');
}

/** Le um arquivo vizinho/import/exemplar inteiro; a skeletonizacao por LOC vem depois. */
function readNeighbor(fs: FileSystemReader, repoDir: string, rel: string): PackFile {
  return { path: toPosix(rel), content: fs.readFile(join(repoDir, rel)), skeletonized: false };
}

/** Aplica skeletonize aos PackFiles acima do threshold (preserva camada 1 a cargo do caller). */
function applySkeleton(files: PackFile[], threshold: number): PackFile[] {
  return files.map((f) =>
    countLines(f.content) > threshold
      ? { ...f, content: skeletonize(f.content), skeletonized: true }
      : f,
  );
}

// ---------------------------------------------------------------------------
// Token budget
// ---------------------------------------------------------------------------

/** Estimativa de tokens ~ chars/4 (heuristica do blueprint; nao chamamos tokenizer real). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function packFileTokens(f: PackFile): number {
  return estimateTokens(f.content);
}

/**
 * Corta o pack para caber em maxTokens, por PRIORIDADE: alterado > irmaos > imports >
 * exemplos (blueprint). O arquivo alterado de cada camada-1 nunca e descartado; cortamos
 * primeiro exemplos, depois imports, depois irmaos — globalmente, do menos prioritario.
 */
export function enforceTokenBudget(pack: ContextPack, maxTokens: number): ContextPack {
  let used = sumChangedTokens(pack);
  const files = pack.files.map((f) => ({ ...f, siblings: [], imports: [], exemplars: [] }));
  for (const layer of ['siblings', 'imports', 'exemplars'] as const) {
    used = fillLayerWithinBudget(pack, files, layer, used, maxTokens);
  }
  // Preserva presenceIndex (e qualquer campo futuro): o budget corta só camadas do pack,
  // nunca o índice de presença (metadado fora do prompt, custo de token zero).
  return { ...pack, files };
}

/** Tokens da camada 1 (arquivos alterados), que nunca sao cortados. */
function sumChangedTokens(pack: ContextPack): number {
  return pack.files.reduce((acc, f) => acc + packFileTokens(f.changed), 0);
}

/**
 * Preenche UMA camada (siblings|imports|exemplars) em todos os arquivos enquanto couber no
 * budget. Ordem da camada importa: camadas mais prioritarias sao preenchidas antes (siblings
 * antes de exemplars), entao um exemplar so entra se sobrou espaco apos os irmaos.
 */
function fillLayerWithinBudget(
  src: ContextPack,
  dst: FileContextLayers[],
  layer: 'siblings' | 'imports' | 'exemplars',
  used: number,
  maxTokens: number,
): number {
  let running = used;
  for (let i = 0; i < src.files.length; i++) {
    const sourceLayer = src.files[i]?.[layer] ?? [];
    for (const pf of sourceLayer) {
      const cost = packFileTokens(pf);
      if (running + cost > maxTokens) continue; // pula o que estoura, tenta o proximo (menor)
      (dst[i] as FileContextLayers)[layer].push(pf);
      running += cost;
    }
  }
  return running;
}

// ---------------------------------------------------------------------------
// tsconfig.paths (aliases)
// ---------------------------------------------------------------------------

const ALIAS_BLOCK_REGEX = /"paths"\s*:\s*\{([\s\S]*?)\}/;
const ALIAS_ENTRY_REGEX = /"([^"]+)"\s*:\s*\[\s*"([^"]+)"/g;

/**
 * Le `compilerOptions.paths` do tsconfig.json (se existir) e devolve um mapa prefixo->alvo
 * com o `/*` removido das pontas, para `expandAlias`. Parse via regex (tsconfig aceita
 * comentarios/trailing commas — JSON.parse falharia); best-effort, sem alias em erro.
 */
export function loadTsconfigAliases(fs: FileSystemReader, repoDir: string): AliasMap {
  const map: AliasMap = new Map();
  const path = join(repoDir, 'tsconfig.json');
  if (!fs.exists(path)) return map;
  const block = ALIAS_BLOCK_REGEX.exec(fs.readFile(path));
  if (!block || block[1] === undefined) return map;
  for (const m of block[1].matchAll(ALIAS_ENTRY_REGEX)) {
    if (m[1] && m[2]) map.set(stripGlobTail(m[1]), stripGlobTail(m[2]));
  }
  return map;
}

/** Remove o sufixo `/*` ou `*` de um alias/alvo (`@pe/*` -> `@pe`, `src/*` -> `src`). */
function stripGlobTail(s: string): string {
  return s.replace(/\/?\*$/, '');
}

// ---------------------------------------------------------------------------
// Orquestrador
// ---------------------------------------------------------------------------

/**
 * Monta o context-pack das 4 camadas para cada arquivo alterado e aplica budget+skeleton.
 * DEGRADACAO GRACIOSA: cada camada e isolada por try/catch — erro de I/O/parse vira secao
 * vazia, NUNCA lanca. "Vizinho nao resolvido != ausencia" (mitiga falso-negativo).
 */
export function buildContextPack(
  repoDir: string,
  changedFiles: string[],
  opts: ContextPackOpts,
  fs: FileSystemReader = nodeFileSystemReader,
): ContextPack {
  const aliases = safe(() => loadTsconfigAliases(fs, repoDir), new Map<string, string>());
  const files = changedFiles.map((file) => buildFileLayers(fs, repoDir, file, opts, aliases));
  const presenceIndex = buildPresenceIndex(repoDir, fs);
  return enforceTokenBudget({ files, presenceIndex }, opts.maxTokens);
}

/** As 4 camadas de UM arquivo, cada uma isolada por try/catch (degradacao por camada). */
function buildFileLayers(
  fs: FileSystemReader,
  repoDir: string,
  file: string,
  opts: ContextPackOpts,
  aliases: AliasMap,
): FileContextLayers {
  const changed = safe(
    () => readChangedWhole(fs, repoDir, file),
    { path: toPosix(file), content: '', skeletonized: false },
  );
  const siblings = safe(() => collectSiblings(fs, repoDir, file, opts.maxSiblings), []);
  const imports = safe(
    () => resolveIntraRepoImports(fs, changed.content, repoDir, file, aliases, opts.maxImports),
    [],
  );
  const exemplars = safe(
    () => collectExemplars(fs, repoDir, composedSuffix(file), file, opts.maxExemplars),
    [],
  );
  const t = opts.skeletonLocThreshold;
  return {
    file: toPosix(file),
    changed, // camada 1 nunca skeletoniza
    siblings: applySkeleton(siblings, t),
    imports: applySkeleton(imports, t),
    exemplars: applySkeleton(exemplars, t),
  };
}

// ---------------------------------------------------------------------------
// Helpers genericos
// ---------------------------------------------------------------------------

/** Roda `fn` e devolve `fallback` em qualquer erro — coracao da degradacao graciosa. */
function safe<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/**
 * Sufixo "composto" do arquivo: a partir do PRIMEIRO ponto do nome (`conta.service.ts` ->
 * `.service.ts`, `Foo.java` -> `.java`). E o que distingue `*.service.ts` de `*.dto.ts` na
 * priorizacao de irmaos e na escolha de exemplares. Sem ponto no nome -> ''.
 */
export function composedSuffix(file: string): string {
  const name = basename(file);
  const dot = name.indexOf('.');
  return dot === -1 ? '' : name.slice(dot);
}

function countLines(content: string): number {
  return content.split('\n').length;
}

/** Normaliza separadores para POSIX (`\` -> `/`) — caminhos no pack sao sempre relativos POSIX. */
function toPosix(p: string): string {
  return p.split('\\').join('/');
}

// ---------------------------------------------------------------------------
// PresenceIndex — índice determinístico de presença do repo (custo de token ZERO)
// ---------------------------------------------------------------------------

/** Índice de presença vazio: usado como fallback na degradação graciosa e por callers legados. */
export const EMPTY_PRESENCE_INDEX: PresenceIndex = { symbols: [], testSubjects: [], envKeys: [] };

// Declaração nomeada (TS/JS/Java/Py) + model/enum/type do Prisma: captura o IDENTIFICADOR
// declarado. É a evidência de que um símbolo "ausente" segundo um finding existe de fato.
const NAMED_DECL_REGEX =
  /\b(?:class|interface|enum|type|function|def|record|struct|namespace|model)\s+([A-Za-z_$][\w$]*)/g;
// const/let/var EXPORTADO captura componentes/consts publicas (ex: `export const RvHero = ...`).
// Exige `export`: um binding LOCAL (dentro de funcao) nunca e o que um finding quer dizer com
// "X ausente/nao definido", e indexa-lo so inflaria o indice com milhares de variaveis locais.
// Declaracoes class/function/model (mesmo nao exportadas) seguem cobertas por NAMED_DECL_REGEX.
// [ \t]* (nao \s*): whitespace inicial so na MESMA linha do `export`. \s* cruza \n e faz
// backtracking catastrofico em arquivo com muitas linhas em branco sem export subsequente
// (reproduzido: >60s em 262KB) — evita esse ReDoS por construcao.
const NAMED_BINDING_REGEX = /^[ \t]*export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
// Allowlist de extensoes que declaram simbolos: so essas linguagens tem class/model/const etc.
// Evita ler/regexar lockfiles, JSON, assets, .md — a maior fonte de custo em monorepo (F1).
const INDEXABLE_EXT_REGEX = /\.(ts|tsx|js|jsx|mjs|cjs|java|py|prisma)$/;
// Cap de tamanho por arquivo: acima disso pulamos o regex (arquivo gerado/minificado que
// escapou da allowlist de dir). ~256KB cobre qualquer fonte legitima com folga larga.
const MAX_INDEX_BYTES = 262_144;
// Arquivo de teste: `*.test.*` / `*.spec.*`, dentro de `__tests__/`, ou `*Test.java`.
const TEST_FILE_REGEX = /(\.(test|spec)\.[jt]sx?$)|(^|\/)__tests__\/|(Test\.java$)/;
// Chave de env: LINHA `NOME_MAIUSCULO=...` num arquivo `.env*.example`.
const ENV_KEY_REGEX = /^\s*([A-Z][A-Z0-9_]*)\s*=/gm;

/** Extrai o "sujeito" de um arquivo de teste: `useIsAndroid.test.ts` -> `useIsAndroid`, `FooTest.java` -> `Foo`. */
function testSubjectOf(rel: string): string {
  const name = basename(rel);
  if (name.endsWith('Test.java')) return name.slice(0, -'Test.java'.length);
  // Remove a cadeia de extensão e o sufixo .test/.spec: pega o nome antes do primeiro ponto.
  const stem = name.slice(0, name.indexOf('.') === -1 ? name.length : name.indexOf('.'));
  return stem;
}

/** Coleta os identificadores capturados por um regex global (grupo 1) numa lista. */
function collectMatches(content: string, regex: RegExp): string[] {
  return [...content.matchAll(regex)].map((m) => m[1] ?? '').filter(Boolean);
}

/**
 * Constrói o PresenceIndex percorrendo o repo inteiro (mesma varredura de collectExemplars).
 * DETERMINÍSTICO, sem LLM, sem prompt: o índice é metadado do artefato, lido só pelo guard
 * do gatekeeper. Degrada gracioso (índice vazio) em qualquer erro de I/O — "não indexado !=
 * ausente": o guard só SUPRIME quando ACHA presença, nunca cria falso-negativo por índice vazio.
 */
export function buildPresenceIndex(repoDir: string, fs: FileSystemReader = nodeFileSystemReader): PresenceIndex {
  return safe(() => {
    const symbols = new Set<string>();
    const testSubjects = new Set<string>();
    const envKeys = new Set<string>();
    for (const rel of walkRepo(fs, repoDir)) {
      const name = basename(rel);
      const isEnvExample = /\.env[\w.]*\.example$/.test(name);
      // So lemos o arquivo se ele declara simbolos (allowlist) OU e um .env*.example (env keys).
      // Corta lockfiles/JSON/assets — a segunda varredura full-repo deixa de custar O(repo inteiro).
      if (!INDEXABLE_EXT_REGEX.test(rel) && !isEnvExample) continue;
      const content = safe(() => fs.readFile(join(repoDir, rel)), '');
      if (!content || content.length > MAX_INDEX_BYTES) continue; // cap: pula arquivo gigante
      if (TEST_FILE_REGEX.test(rel)) testSubjects.add(testSubjectOf(rel));
      if (isEnvExample) {
        for (const k of collectMatches(content, ENV_KEY_REGEX)) envKeys.add(k);
        continue; // .env.example nao declara simbolo de codigo
      }
      for (const s of collectMatches(content, NAMED_DECL_REGEX)) symbols.add(s);
      for (const s of collectMatches(content, NAMED_BINDING_REGEX)) symbols.add(s);
    }
    // Sort deterministico: listDir/walkRepo nao garantem ordem estavel entre FS/hosts. Sem
    // sort, o context-pack.json diferiria entre runs equivalentes — quebra reproducibilidade,
    // diff em snapshot e cache por hash do artefato. Custo trivial (N nomes curtos).
    return {
      symbols: [...symbols].sort(),
      testSubjects: [...testSubjects].sort(),
      envKeys: [...envKeys].sort(),
    };
  }, EMPTY_PRESENCE_INDEX);
}
