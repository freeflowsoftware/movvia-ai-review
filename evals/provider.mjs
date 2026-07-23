// Provider custom do promptfoo que reusa o CLI real de review (lib/agent-runner-cli.ts).
// Rodar a persona pelo mesmo caminho de producao garante que o eval valide o prompt COMO
// ele roda no gate — nao uma copia. O CLI le o modelo de process.env.AGENT_MODEL
// (agent-runner-cli.ts:158), NAO do frontmatter; por isso lemos o frontmatter aqui e
// exportamos AGENT_MODEL, senao todo agente rodaria no Flash-Lite default.
// Usamos execSync com um comando de shell (em vez de execFileSync + npx.cmd/npx) porque
// execFileSync lanca EINVAL no Windows (Node 22, pos-CVE-2024-27980).
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Le o `model` do frontmatter de agents/<agent>.md (vazio = default do CI). */
function agentModel(agent) {
  const raw = readFileSync(join(ROOT, 'agents', `${agent}.md`), 'utf8');
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  const fm = m ? parseYaml(m[1]) : {};
  return typeof fm?.model === 'string' ? fm.model : '';
}

export default class AgentRunnerProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'agent-runner';
    this.config = options.config || {};
  }

  id() {
    return this.providerId;
  }

  // O `prompt` renderizado (template com {{agent}}:{{diffPath}}) so serve para variar a
  // chave de cache do promptfoo por caso; a entrada real vem de context.vars.
  async callApi(_prompt, context) {
    const vars = (context && context.vars) || {};
    const agent = vars.agent;
    const diffPath = join(ROOT, vars.diffPath);
    const repoDir = join(ROOT, vars.repoDir || 'tests/fixtures/eval/_repo');
    try {
      const env = { ...process.env };
      const model = agentModel(agent);
      if (model) env.AGENT_MODEL = model;
      const cmd = `npx tsx lib/agent-runner-cli.ts ${JSON.stringify(agent)} ${JSON.stringify(repoDir)} ${JSON.stringify(diffPath)}`;
      const stdout = execSync(cmd, {
        cwd: ROOT,
        env,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      });
      return { output: stdout.trim() };
    } catch (err) {
      return { error: `agent-runner falhou (${agent}): ${err.stderr || err.message}` };
    }
  }
}
