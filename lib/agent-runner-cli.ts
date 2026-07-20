import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import { parseAgentFile } from './discover.js';
import { detectLanguages, buildSystemPrompt, buildUserPrompt, agentMatchesPaths } from './context-loader.js';
import { runAgent, realChatRunner, withRetry } from './run-agent.js';
import { loadOrgRules } from './org-rules.js';
import { ADR_GLOBS } from './adr.js';
import type { ContextPack, FileContextLayers, PackFile } from './context-pack.js';
import {
  extractJiraKey,
  fetchJiraTicket,
  HttpJiraClient,
  type JiraTicket,
} from './jira.js';

export function loadRepoRules(repoDir: string): string {
  const parts: string[] = [];
  const rulesDir = join(repoDir, '.claude', 'rules');
  if (existsSync(rulesDir)) {
    for (const f of readdirSync(rulesDir).filter((x) => x.endsWith('.md')).sort()) {
      parts.push(readFileSync(join(rulesDir, f), 'utf8'));
    }
  }
  for (const root of ['CLAUDE.md', 'AGENTS.md']) {
    if (existsSync(join(repoDir, root))) parts.push(readFileSync(join(repoDir, root), 'utf8'));
  }
  return parts.join('\n\n');
}

export function loadLangPacks(changedFiles: string[], centralDir: string): string[] {
  return detectLanguages(changedFiles).flatMap((lang) => {
    const p = join(centralDir, 'lang-packs', `${lang}.md`);
    return existsSync(p) ? [readFileSync(p, 'utf8')] : [];
  });
}

/**
 * Carrega o conteudo real dos ADRs do repo alvo, casando os caminhos relativos
 * contra os ADR_GLOBS compartilhados com o gate de ADR (lib/adr.ts). Antes esta
 * secao do prompt recebia um placeholder estatico inutil; agora o agente ve as
 * decisoes arquiteturais ja tomadas. Limita a 50 arquivos para nao estourar o
 * contexto do modelo em repos com muitos ADRs.
 */
const ADR_IGNORE = /(^|\/)(node_modules|\.git|dist|target|build)(\/|$)/;

export function loadAdrs(repoDir: string): string {
  if (!existsSync(repoDir)) return '';
  const matches = readdirSync(repoDir, { recursive: true })
    .map((entry) => String(entry).split('\\').join('/'))
    .filter((rel) => !ADR_IGNORE.test(rel))
    .filter((rel) => ADR_GLOBS.some((g) => minimatch(rel, g)))
    .filter((rel) => statSync(join(repoDir, rel)).isFile())
    .sort()
    .slice(0, 50);
  return matches.map((rel) => readFileSync(join(repoDir, rel), 'utf8')).join('\n\n');
}

/** Bloco de UM PackFile no prompt: caminho + nota de skeletonizacao + conteudo em fence. */
function renderPackFile(label: string, f: PackFile): string {
  const note = f.skeletonized ? ' (apenas assinaturas)' : '';
  return `### ${label}: ${f.path}${note}\n\`\`\`\n${f.content}\n\`\`\``;
}

/** Bloco de uma camada (irmaos/imports/exemplares) — vazio quando a camada nao tem arquivos. */
function renderLayer(label: string, files: PackFile[]): string[] {
  return files.map((f) => renderPackFile(label, f));
}

/** Renderiza as 4 camadas de UM arquivo alterado em blocos legiveis para o LLM. */
function renderFileLayers(layers: FileContextLayers): string {
  return [
    renderPackFile('Arquivo alterado', layers.changed),
    ...renderLayer('Irmao do diretorio', layers.siblings),
    ...renderLayer('Import intra-repo', layers.imports),
    ...renderLayer('Exemplar do mesmo tipo', layers.exemplars),
  ].join('\n\n');
}

/**
 * Le o ContextPack JSON do artefato (context-pack-cli) e renderiza SO as secoes dos
 * `changedFiles` que este agente vai revisar (cada agente roda em um subconjunto de arquivos
 * via roteamento por paths — sem o filtro o prompt carregaria contexto de arquivos que o
 * agente nem olha). DEGRADACAO GRACIOSA: packPath vazio/ilegivel/sem match => '' (o pack
 * jamais quebra o pipeline; "vizinho nao resolvido != ausencia" do blueprint).
 */
export function loadContextPack(packPath: string, changedFiles: string[]): string {
  if (!packPath || !existsSync(packPath)) return '';
  try {
    const pack = JSON.parse(readFileSync(packPath, 'utf8')) as ContextPack;
    const wanted = new Set(changedFiles);
    const selected = (pack.files ?? []).filter((f) => wanted.has(f.file));
    return selected.map(renderFileLayers).join('\n\n');
  } catch {
    return ''; // JSON corrompido nao pode derrubar o review
  }
}

/**
 * Resolve a chave Jira do PR: JIRA_KEY explicito tem prioridade; senao extrai do PR_TITLE.
 * Early return quando nada casa para nao chamar a Jira a toa nos repos sem ticket no titulo.
 */
export function resolveJiraKey(env: NodeJS.ProcessEnv): string | null {
  if (env.JIRA_KEY) return env.JIRA_KEY;
  return env.PR_TITLE ? extractJiraKey(env.PR_TITLE) : null;
}

/**
 * Busca a US do Jira para injetar no prompt. Borda externa via HttpJiraClient (DIP).
 * Retorna undefined (nao null) quando falta chave ou secrets — buildPrompt omite a secao.
 * Sem isso, o agente de requisitos opera sem a US e o gating de dominio cai (bug F6).
 */
export async function loadJiraTicket(env: NodeJS.ProcessEnv): Promise<JiraTicket | undefined> {
  const key = resolveJiraKey(env);
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = env;
  if (!key || !JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) return undefined;
  const client = new HttpJiraClient(JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN);
  return (await fetchJiraTicket(key, client)) ?? undefined;
}

// CLI: agent-runner-cli.ts <agentName> <repoDir> <diffPath> [packPath]
if (process.argv[1]?.endsWith('agent-runner-cli.ts')) {
  // Fallback '' nos argv (mesma convencao de jira.ts/adr.ts) para satisfazer
  // noUncheckedIndexedAccess do tsconfig — slice() devolve (string|undefined)[].
  // packPath e o 4o argv OPCIONAL (artefato context-pack); vazio => prompt sem contexto.
  const [name = '', repoDir = '', diffPath = '', packPath = ''] = process.argv.slice(2);
  const central = join(import.meta.dirname, '..');
  const spec = parseAgentFile(readFileSync(join(central, 'agents', `${name}.md`), 'utf8'), `agents/${name}.md`);
  const diff = readFileSync(diffPath, 'utf8');
  // matchAll devolve grupos string|undefined; o regex casa => m[1] sempre presente.
  const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? '');
  // Roteamento por paths: se o diff nao toca nenhum glob do agente, emite findings vazio
  // e NAO chama o LLM (economia de tokens + evita findings off-dimension de um agente que
  // nem deveria rodar neste PR). Sai antes de montar prompt/buscar Jira/ler o context-pack.
  if (!agentMatchesPaths(changedFiles, spec.paths)) {
    process.stdout.write(JSON.stringify({ agent: spec.name, findings: [] }));
    process.exit(0);
  }
  const ticket = await loadJiraTicket(process.env);
  // Split system/user: a persona da dimensao vira SYSTEM (foca o agente), o contexto do
  // PR vira USER. Antes era um prompt unico passado ao opencode run.
  const system = buildSystemPrompt(spec);
  const user = buildUserPrompt({
    // Regras compartilhadas da Movvia, do repo CENTRAL, roteadas por stack (org-rules/):
    // chegam ao agente mesmo que o repo alvo nao tenha .claude/rules commitado.
    orgRules: loadOrgRules(changedFiles, central),
    repoRules: loadRepoRules(repoDir),
    langPacks: loadLangPacks(changedFiles, central),
    adrs: loadAdrs(repoDir),
    diff,
    ticket,
    // Context-pack determinístico (Fase 1b): so as secoes dos arquivos que ESTE agente revisa.
    contextPack: loadContextPack(packPath, changedFiles) || undefined,
  });
  // AGENT_MODEL vem do frontmatter do agente (matrix.model). Vazio = default do CI,
  // configuravel por DEFAULT_MODEL. Id PURO do OpenRouter (sem prefixo 'llm/' do opencode):
  // a chat-completion direta roteia pelo id do modelo, nao pelo provider customizado.
  const model = process.env.AGENT_MODEL || process.env.DEFAULT_MODEL || 'google/gemini-2.5-flash-lite';
  // PED-2729: agent-runner-cli.ts redireciona stdout para o JSON de findings do workflow
  // (ver step "Rodar agente" no ai-review.yml), entao o log de retry vai OBRIGATORIAMENTE
  // para stderr (console.error) — nunca stdout, ou corrompe o JSON consumido pelo gatekeeper.
  const runner = withRetry(realChatRunner, {
    onRetry: ({ attempt, delayMs, err }) =>
      console.error(`[${name}] tentativa ${attempt} do LLM falhou (${(err as Error).message}); re-tentando em ${delayMs}ms`),
  });
  const res = await runAgent(spec, system, user, model, runner);
  process.stdout.write(JSON.stringify(res));
}
