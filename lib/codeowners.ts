import { minimatch } from 'minimatch';

/**
 * Parser + matcher de CODEOWNERS para a dispensa de P0 (PED-2728, ADR-002): P0 só pode ser
 * dispensado por comando se o autor for CODEOWNER do arquivo do finding. Núcleo PURO (sem
 * rede): a resolução de membership de time e a leitura do arquivo ficam na borda (dismiss.ts),
 * fail-closed — na dúvida, NÃO é CODEOWNER e o P0 permanece bloqueado.
 */

/** Uma regra do CODEOWNERS: o glob e os donos (logins `@x` e times `@org/team`). */
export interface CodeownersRule {
  pattern: string;
  owners: string[];
}

/**
 * Parseia o texto do CODEOWNERS em regras, na ORDEM do arquivo. Ignora linhas vazias e
 * comentários (`#`). A precedência (última regra que casa vence) é aplicada em ownersFor.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

/** Converte um padrão de CODEOWNERS num glob que o minimatch entende (path relativo ao repo). */
function toGlob(pattern: string): string {
  // "/src/x" -> ancorado na raiz; "docs/" -> tudo sob docs; "*.ts" -> qualquer diretório.
  let p = pattern.startsWith('/') ? pattern.slice(1) : `**/${pattern}`;
  if (p.endsWith('/')) p += '**';
  return p;
}

/**
 * Donos do arquivo pela semântica do CODEOWNERS: a ÚLTIMA regra que casa vence (não a
 * primeira). Sem regra casando -> [] (ninguém é dono declarado -> fail-closed no chamador).
 */
export function ownersFor(rules: CodeownersRule[], file: string): string[] {
  const normalized = file.replace(/^\.?\//, '');
  let matched: string[] = [];
  for (const rule of rules) {
    if (minimatch(normalized, toGlob(rule.pattern), { dot: true })) matched = rule.owners;
  }
  return matched;
}

/**
 * Decide, a partir dos donos já resolvidos (logins diretos), se `login` é CODEOWNER do
 * arquivo. Times (`@org/team`) NÃO são resolvidos aqui — o chamador injeta essa checagem
 * (borda). Fail-closed: sem match direto e sem confirmação de time -> false.
 */
export function isDirectOwner(owners: string[], login: string): boolean {
  const alvo = `@${login.replace(/^@/, '')}`.toLowerCase();
  return owners.some((o) => o.toLowerCase() === alvo);
}

/** Donos que são times (`@org/team`), para o chamador checar membership via API. */
export function teamOwners(owners: string[]): string[] {
  return owners.filter((o) => o.includes('/'));
}
