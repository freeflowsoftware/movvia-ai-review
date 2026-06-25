import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';

/**
 * Regras COMPARTILHADAS da Movvia (lock distribuido financeiro, sem CREATE TYPE ENUM,
 * skeleton loading, padroes de teste...) que sao o diferencial do review in-house.
 *
 * Hoje elas vivem no super-repo ~/projects/movvia/.claude/rules — que NAO e versionado e
 * NAO esta dentro de cada repo alvo (pe-api-core so tem o proprio CLAUDE.md). Logo no CI
 * o loadRepoRules nunca as ve. Movidas para org-rules/ no repo CENTRAL, viajam com a Action
 * (igual aos lang-packs) e sao injetadas por ROTEAMENTO: cada regra declara `appliesTo`
 * (globs) no frontmatter; sem appliesTo = transversal (aplica a qualquer diff).
 */

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Casa UM bloco de frontmatter ancorado no topo, separado do anterior por NO MAXIMO uma
 * quebra de linha (a linha em branco entre blocos). Usado para varrer blocos CONSECUTIVOS:
 * 16 das 17 org-rules trazem um 2o bloco estilo Cursor (`description:`/`globs:`) logo apos o
 * bloco de roteamento; sem remove-lo, esse YAML de metadados de IDE vazaria cru no prompt do
 * agente (via context-loader). So o 1o bloco carrega `appliesTo`; os demais sao metadados que
 * nao devem poluir o prompt.
 *
 * O `\r?\n?` (em vez de `\s*`) e deliberado: limita a remocao a blocos CONTIGUOS. Se usassemos
 * `\s*`, um corpo de regra que comecasse (apos linhas em branco) com uma secao markdown
 * delimitada por `---` (thematic break) seria comido silenciosamente. Como as 16 regras tem
 * exatamente 1 linha em branco entre os blocos, `\r?\n?` limpa todas e preserva conteudo real
 * separado por 2+ linhas em branco.
 */
const LEADING_FRONTMATTER = /^\r?\n?---\r?\n[\s\S]*?\r?\n---\r?\n?/;

/** Remove TODOS os blocos de frontmatter consecutivos no topo do body (idempotente). */
function stripLeadingFrontmatter(body: string): string {
  let out = body;
  for (let prev = ''; out !== prev; ) {
    prev = out;
    out = out.replace(LEADING_FRONTMATTER, '');
  }
  return out;
}

/**
 * Separa o frontmatter (appliesTo) do corpo da regra. Sem frontmatter OU sem `appliesTo`
 * => appliesTo null (transversal). O body sai sem o bloco de frontmatter para nao poluir
 * o prompt do agente com YAML de roteamento. appliesTo sai SEMPRE do 1o bloco; blocos de
 * frontmatter consecutivos (ex: 2o bloco Cursor-style) sao removidos do body para nao
 * injetar metadados de IDE no prompt.
 */
export function parseOrgRule(content: string): { appliesTo: string[] | null; body: string } {
  const m = FRONTMATTER.exec(content);
  if (!m) return { appliesTo: null, body: content };
  return { appliesTo: parseAppliesTo(m[1] ?? ''), body: stripLeadingFrontmatter(content.slice(m[0].length)) };
}

/** Le `appliesTo` do frontmatter: aceita inline `["a","b"]` ou block list `- "a"`. */
function parseAppliesTo(frontmatter: string): string[] | null {
  const lines = frontmatter.split(/\r?\n/);
  const idx = lines.findIndex((l) => /^appliesTo:/.test(l.trim()));
  if (idx === -1) return null;
  const inline = /^appliesTo:\s*\[(.+)\]/.exec(lines[idx]!.trim());
  if (inline) return splitGlobs(inline[1]!.split(','));
  const globs: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const item = /^\s*-\s*(.+)$/.exec(lines[i]!);
    if (!item) break;
    globs.push(item[1]!);
  }
  const cleaned = splitGlobs(globs);
  return cleaned.length ? cleaned : null;
}

/** Normaliza globs: tira aspas e espacos, descarta vazios. */
function splitGlobs(raw: string[]): string[] {
  return raw.map((s) => s.trim().replace(/^["']|["']$/g, '').trim()).filter(Boolean);
}

/**
 * Uma regra aplica se for transversal (appliesTo null) OU se ALGUM arquivo alterado casa
 * ALGUM glob. Roteamento por stack: a regra Java nao entra num PR so de TypeScript (foco +
 * economia de contexto), mas a regra de credenciais (sem appliesTo) entra sempre.
 */
export function orgRuleApplies(appliesTo: string[] | null, changedFiles: string[]): boolean {
  if (appliesTo === null) return true;
  return changedFiles.some((file) => appliesTo.some((glob) => minimatch(file, glob)));
}

/**
 * Logica PURA: dado o conteudo cru das org-rules + os arquivos do diff, devolve os bodies
 * das regras APLICAVEIS (ja sem frontmatter), preservando a ordem de entrada. Borda (FS)
 * fica em loadOrgRules — testavel sem tocar o filesystem.
 */
export function selectOrgRules(
  rules: Array<{ name: string; content: string }>,
  changedFiles: string[],
): string[] {
  return rules
    .map((r) => parseOrgRule(r.content))
    .filter((r) => orgRuleApplies(r.appliesTo, changedFiles))
    .map((r) => r.body.trim());
}

/**
 * Borda externa: le org-rules/*.md do repo CENTRAL (centralDir) e seleciona as aplicaveis
 * ao diff. Espelha loadLangPacks (agent-runner-cli) — mesmo padrao de leitura no central.
 * Dir ausente => []: o produto funciona sem org-rules (cai so nas regras do repo alvo).
 */
export function loadOrgRules(changedFiles: string[], centralDir: string): string[] {
  const dir = join(centralDir, 'org-rules');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, content: readFileSync(join(dir, f), 'utf8') }));
  return selectOrgRules(files, changedFiles);
}
