#!/usr/bin/env node
/**
 * Sincroniza as regras COMPARTILHADAS da Movvia (super-repo .claude/rules) para org-rules/
 * deste repo central, prependendo o frontmatter `appliesTo` (roteamento por stack que
 * lib/org-rules.ts consome). As org-rules COMMITADAS aqui sao a fonte que o CI injeta —
 * o super-repo nao viaja com o checkout do repo alvo.
 *
 * Uso: node scripts/sync-org-rules.mjs [SOURCE_DIR]
 *   SOURCE_DIR default: ~/projects/movvia/.claude/rules
 *
 * O MAP abaixo e a fonte de verdade do roteamento: nome -> globs (array) | null (transversal,
 * aplica a qualquer diff) | 'SKIP' (nao e regra de review de codigo).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const MAP = {
  'deploy-cicd-patterns.md': ['**/*.yml', '**/*.yaml', '**/Dockerfile', '**/kustomization*.yaml', '**/k8s/**', '**/.github/workflows/**'],
  'distributed-locks-financial.md': ['**/*.ts'],
  'docker-rules.md': ['**/Dockerfile', '**/docker-compose*.yml', '**/.dockerignore'],
  'flyway-migrations.md': ['**/*.sql', '**/migrations/**', '**/flyway/**'],
  'hardcoded-credentials.md': null, // transversal: seguranca de credenciais aplica a qualquer stack
  'java-testing-patterns.md': ['**/*.java'],
  'movvia-docs-framework.md': 'SKIP', // processo de docs corporativos, nao review de codigo
  'nestjs-api-patterns.md': ['**/*.ts'],
  'nestjs-testing-patterns.md': ['**/*.ts'],
  'pe-portais-design-system.md': ['**/*.tsx', '**/pe-portais/**'],
  'portal-skeleton-loading.md': ['**/*.tsx'],
  'pr-conventions.md': null, // transversal: convencao de titulo/escopo do PR
  'prisma-schema-rules.md': ['**/schema.prisma', '**/*.prisma'],
  'processador-clean-arch.md': ['**/*.java'],
  'solid-kiss-refactoring-nestjs.md': ['**/*.ts'],
  'spring-config-rules.md': ['**/*.java', '**/application*.yml', '**/application*.yaml', '**/*.properties'],
  'terraform-rules.md': ['**/*.tf', '**/*.tfvars'],
};

const central = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = process.argv[2] || join(homedir(), 'projects', 'movvia', '.claude', 'rules');
const dest = join(central, 'org-rules');

if (!existsSync(source)) {
  console.error(`SOURCE nao encontrado: ${source}\nPasse o caminho das .claude/rules como argumento.`);
  process.exit(1);
}
mkdirSync(dest, { recursive: true });

function frontmatter(appliesTo) {
  if (appliesTo === null) {
    return '---\n# Transversal: aplica a qualquer diff (sem appliesTo).\n---\n\n';
  }
  return `---\nappliesTo:\n${appliesTo.map((g) => `  - "${g}"`).join('\n')}\n---\n\n`;
}

let synced = 0;
let skipped = 0;
for (const [name, appliesTo] of Object.entries(MAP)) {
  if (appliesTo === 'SKIP') { skipped++; continue; }
  const src = join(source, name);
  if (!existsSync(src)) { console.warn(`AVISO: ${name} ausente no source, pulando`); continue; }
  const body = readFileSync(src, 'utf8').replace(/^﻿/, '');
  writeFileSync(join(dest, name), frontmatter(appliesTo) + body);
  synced++;
}
console.log(`org-rules sincronizadas: ${synced} | puladas (SKIP): ${skipped} | dest: ${dest}`);
