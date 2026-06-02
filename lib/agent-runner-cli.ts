import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { minimatch } from 'minimatch';
import { parseAgentFile } from './discover.js';
import { detectLanguages, buildPrompt } from './context-loader.js';
import { runAgent, realOpencodeRunner } from './run-agent.js';
import { ADR_GLOBS } from './adr.js';

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
  const prompt = buildPrompt({
    spec,
    repoRules: loadRepoRules(repoDir),
    langPacks: loadLangPacks(changedFiles, central),
    adrs: loadAdrs(repoDir),
    diff,
  });
  const model = process.env.AGENT_MODEL || 'gemini/gemini-flash-lite';
  const res = await runAgent(spec, prompt, model, realOpencodeRunner);
  process.stdout.write(JSON.stringify(res));
}
