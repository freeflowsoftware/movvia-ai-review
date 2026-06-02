import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseAgentFile } from './discover.js';
import { detectLanguages, buildPrompt } from './context-loader.js';
import { runAgent, realOpencodeRunner } from './run-agent.js';

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
  const adrsPath = join(repoDir, 'docs');
  const adrs = existsSync(adrsPath) ? '(ADRs disponiveis no repo de docs)' : '';
  const prompt = buildPrompt({
    spec,
    repoRules: loadRepoRules(repoDir),
    langPacks: loadLangPacks(changedFiles, central),
    adrs,
    diff,
  });
  const model = process.env.AGENT_MODEL || 'gemini/gemini-flash-lite';
  const res = await runAgent(spec, prompt, model, realOpencodeRunner);
  process.stdout.write(JSON.stringify(res));
}
