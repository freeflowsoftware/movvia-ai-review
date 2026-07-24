import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { buildContextPack, type ContextPackOpts } from './context-pack.js';
import { stripGeneratedFiles } from './diff-filter.js';

/** Fallbacks quando config/defaults.yml nao traz o bloco context_pack (mesmos do blueprint). */
const DEFAULT_OPTS: ContextPackOpts = {
  maxTokens: 100000,
  maxSiblings: 4,
  maxImports: 6,
  maxExemplars: 3,
  skeletonLocThreshold: 400,
};

/** Forma snake_case do bloco context_pack no YAML — mapeada para o camelCase de ContextPackOpts. */
interface ContextPackYaml {
  max_tokens?: number;
  max_siblings?: number;
  max_imports?: number;
  max_exemplars?: number;
  skeleton_loc_threshold?: number;
}

/** Le um numero do YAML, caindo no fallback quando ausente ou de tipo errado. */
function numOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

/**
 * Le `context_pack.*` de config/defaults.yml e devolve as cotas em camelCase. Espelha o
 * padrao de readAdversarialThreshold (gatekeeper): YAML e snake_case, ContextPackOpts e
 * camelCase. Campo ausente cai no fallback do blueprint (degradacao graciosa: pack menor,
 * nunca quebra). I/O injetado via `readText` para o teste exercitar sem tocar o disco real.
 */
export function loadContextPackOpts(
  configPath: string,
  readText: (path: string) => string = (p) => readFileSync(p, 'utf8'),
): ContextPackOpts {
  const parsed = parseYaml(readText(configPath)) as { context_pack?: ContextPackYaml } | null;
  const cp = parsed?.context_pack ?? {};
  return {
    maxTokens: numOr(cp.max_tokens, DEFAULT_OPTS.maxTokens),
    maxSiblings: numOr(cp.max_siblings, DEFAULT_OPTS.maxSiblings),
    maxImports: numOr(cp.max_imports, DEFAULT_OPTS.maxImports),
    maxExemplars: numOr(cp.max_exemplars, DEFAULT_OPTS.maxExemplars),
    skeletonLocThreshold: numOr(cp.skeleton_loc_threshold, DEFAULT_OPTS.skeletonLocThreshold),
  };
}

/**
 * Extrai os arquivos alterados do diff unificado. MESMO regex do agent-runner-cli/gatekeeper
 * (`+++ b/<path>`) para que o pack indexe exatamente os arquivos que o agente vai revisar.
 */
export function changedFilesFromDiff(diff: string): string[] {
  // matchAll devolve grupos string|undefined; o regex casa => m[1] sempre presente.
  return [...diff.matchAll(/^\+\+\+ b\/(.+)$/gm)].map((m) => m[1] ?? '');
}

// CLI: context-pack-cli.ts <repoDir> <diffPath> → ContextPack JSON em stdout.
if (process.argv[1]?.endsWith('context-pack-cli.ts')) {
  // Fallback '' nos argv (mesma convencao de agent-runner-cli/gatekeeper) para satisfazer
  // noUncheckedIndexedAccess do tsconfig — slice() devolve (string|undefined)[].
  const [repoDir = '', diffPath = ''] = process.argv.slice(2);
  // Opcao 1 (PR #863): filtra arquivos gerados antes de derivar changedFiles — sem isso o
  // pack leria o pnpm-lock.yaml INTEIRO como arquivo alterado (camada 1 nunca skeletoniza).
  const diff = stripGeneratedFiles(readFileSync(diffPath, 'utf8'));
  const changedFiles = changedFilesFromDiff(diff);
  const opts = loadContextPackOpts(join(import.meta.dirname, '..', 'config', 'defaults.yml'));
  const pack = buildContextPack(repoDir, changedFiles, opts);
  process.stdout.write(JSON.stringify(pack));
}
