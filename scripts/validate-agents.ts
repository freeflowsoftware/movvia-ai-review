import type { AgentSpec } from '../lib/types.js';
import { discoverAgents } from '../lib/discover.js';

export function validateSpecs(specs: AgentSpec[]): string[] {
  const erros: string[] = [];
  const vistos = new Set<string>();
  for (const s of specs) {
    if (vistos.has(s.name)) erros.push(`Nome de agente duplicado: "${s.name}" (${s.file})`);
    vistos.add(s.name);
    if (!s.persona.trim()) erros.push(`Agente ${s.file}: persona (corpo) vazia`);
    if (!/^[a-z0-9-]+$/.test(s.name)) erros.push(`Agente ${s.file}: name deve ser kebab-case`);
  }
  return erros;
}

if (process.argv[1]?.endsWith('validate-agents.ts')) {
  const erros = validateSpecs(discoverAgents(process.argv[2] ?? 'agents'));
  if (erros.length) {
    for (const e of erros) console.error(`::error::${e}`);
    process.exit(1);
  }
  console.log('Agentes validos.');
}
