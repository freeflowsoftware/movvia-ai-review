import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import { parseAgentFile } from './discover.js';
import { detectLanguages, buildPrompt } from './context-loader.js';
import { runAgent, realOpencodeRunner } from './run-agent.js';
import { ADR_GLOBS } from './adr.js';
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

// CLI: agent-runner-cli.ts <agentName> <repoDir> <diffPath>
if (process.argv[1]?.endsWith('agent-runner-cli.ts')) {
  // Fallback '' nos argv (mesma convencao de jira.ts/adr.ts) para satisfazer
  // noUncheckedIndexedAccess do tsconfig — slice() devolve (string|undefined)[].
  const [name = '', repoDir = '', diffPath = ''] = process.argv.slice(2);
  const central = join(import.meta.dirname, '..');
  const spec = parseAgentFile(readFileSync(join(central, 'agents', `${name}.md`), 'utf8'), `agents/${name}.md`);
  const diff = readFileSync(diffPath, 'utf8');
  // matchAll devolve grupos string|undefined; o regex casa => m[1] sempre presente.
  const changedFiles = [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? '');
  const ticket = await loadJiraTicket(process.env);
  const prompt = buildPrompt({
    spec,
    repoRules: loadRepoRules(repoDir),
    langPacks: loadLangPacks(changedFiles, central),
    adrs: loadAdrs(repoDir),
    diff,
    ticket,
  });
  // AGENT_MODEL vem do frontmatter do agente (matrix.model). Vazio = default do CI,
  // configuravel por DEFAULT_MODEL, batendo com o provider/model do opencode.json.
  const model = process.env.AGENT_MODEL || process.env.DEFAULT_MODEL || 'llm/google/gemini-2.5-flash-lite';
  const res = await runAgent(spec, prompt, model, realOpencodeRunner);
  process.stdout.write(JSON.stringify(res));
}
