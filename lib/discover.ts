import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentSpec } from './types.js';

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export function parseAgentFile(raw: string, file: string): AgentSpec {
  const m = FRONTMATTER.exec(raw);
  // Sob noUncheckedIndexedAccess (tsconfig), os grupos do match sao string | undefined.
  // Guardamos o grupo 1 (YAML) explicitamente; grupo 2 (persona) tem fallback ''.
  const frontmatterYaml = m?.[1];
  if (frontmatterYaml === undefined) {
    throw new Error(`Agente sem frontmatter YAML (esperado "---\\n...\\n---"): ${file}`);
  }
  const fm = parseYaml(frontmatterYaml) as Record<string, unknown>;
  const persona = (m?.[2] ?? '').trim();
  return buildAgentSpec(fm, persona, file);
}

function buildAgentSpec(
  fm: Record<string, unknown>,
  persona: string,
  file: string,
): AgentSpec {
  const name = fm.name;
  if (typeof name !== 'string' || !name) {
    throw new Error(`Agente ${file}: campo "name" ausente ou vazio (esperado string kebab-case)`);
  }
  return {
    name,
    dimension: typeof fm.dimension === 'string' ? fm.dimension : name,
    model: typeof fm.model === 'string' ? fm.model : '',
    paths: Array.isArray(fm.paths) && fm.paths.length ? (fm.paths as string[]) : ['**/*'],
    severityHints: (fm.severity_hints as Record<string, string>) ?? {},
    persona,
    file,
  };
}

export function discoverAgents(dir: string): AgentSpec[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && !f.startsWith('_'))
    .sort()
    .map((f) => parseAgentFile(readFileSync(join(dir, f), 'utf8'), `${dir}/${basename(f)}`));
}

export function toMatrix(specs: AgentSpec[]): { include: Array<Record<string, unknown>> } {
  return {
    include: specs.map((s) => ({ name: s.name, model: s.model, file: s.file, paths: s.paths })),
  };
}

// CLI: `tsx lib/discover.ts agents` imprime a matrix JSON em uma linha.
if (process.argv[1]?.endsWith('discover.ts')) {
  const dir = process.argv[2] ?? 'agents';
  process.stdout.write(JSON.stringify(toMatrix(discoverAgents(dir))));
}
