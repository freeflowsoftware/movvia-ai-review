// ---------------------------------------------------------------------------
// Padrões de classificação textual de "AUSÊNCIA" — usados só pelo guard
// determinístico de PRESENÇA em gatekeeper.ts (refuteByPresence).
// ---------------------------------------------------------------------------
//
// Por que isolado: `lib/gatekeeper.ts` mistura orquestração (dedupe, refuter
// adversarial, verdict, CLI) com uma taxonomia textual densa de "o que conta
// como ausência". Extrair só a taxonomia + o classificador `presenceHit` deixa
// o gatekeeper enxuto (sob 500 linhas) e permite testar a heurística de forma
// isolada, sem instanciar o pipeline inteiro.

import { basename } from 'node:path';
import type { Finding } from './types.js';

/** Um finding descartado pelo guard, com a evidência de presença que o refuta. */
export interface SuppressedByPresence {
  finding: Finding;
  reason: string;
}

// Ausência COMPORTAMENTAL (não de existência): "não usa lock", "não filtra por cliente",
// "não valida", "componente não é renderizado" (símbolo existe mas não é chamado no fluxo).
// O símbolo pode existir mas o COMPORTAMENTO falta — NUNCA suprimir (protege P0 de
// lock/validação/multi-tenant e o caso SEO-153 de componente existente porém não montado).
// Verificado ANTES da classificação: vence tudo.
//
// Quebrado em 3 constantes por gramática distinta (era uma mega-regex de 616 chars):
//   VERB    — "não <verbo>" direto (não usa lock, não chama X, não filtra...).
//   COPULA  — "não é/está/foi <particípio>" (não é renderizado, não foi montado).
//             O "é" cobre acentuado E o "e" desacentuado (caso comum em finding de LLM
//             sem locale PT-BR — sem esse alternativo o texto SEO-153 combinado "nao foi
//             encontrado / nao e renderizado" caía em EXISTENCE_ABSENCE e era suprimido).
//   KEYWORD — palavras-chave inequívocas (sem lock, race, idempot, multi-tenant, does not use,
//             is not rendered, without lock/filter/validation).
const BEHAVIORAL_VERB_ABSENCE =
  /n[aã]o\s+(usa|utiliza|chama|invoca|filtra|valida|trata|verifica|aplica|adquire|libera|protege|considera|renderiza|monta|inclui|importa|referencia)/i;
const BEHAVIORAL_COPULA_ABSENCE =
  /n[aã]o\s+(é|e|esta|est[aá]|foi|sera|ser[aá])\s+(renderizad|montad|incluid|importad|referenciad|chamad|invocad|utilizad|usad)/i;
const BEHAVIORAL_KEYWORD_ABSENCE =
  /sem\s+(lock|filtro|valida|controle|isolamento|idempot|trava)|does\s+not\s+(use|call|filter|validate|acquire|check|consider|render|mount|include|import|reference)|is\s+not\s+(rendered|mounted|included|imported|referenced|called|invoked|used)|without\s+(a\s+)?(lock|filter|validation)|\brace\b|idempot|multi-?tenant|clienteid|correlation/i;

function isBehavioralAbsence(text: string): boolean {
  return BEHAVIORAL_VERB_ABSENCE.test(text) || BEHAVIORAL_COPULA_ABSENCE.test(text) || BEHAVIORAL_KEYWORD_ABSENCE.test(text);
}

// Alegação de EXISTÊNCIA ausente: o artefato NÃO está no codebase.
// Nota: "renderizad"/"rendered" NÃO entra aqui — renderização é comportamento (usar o
// componente no fluxo), não existência do símbolo. Vive em BEHAVIORAL_ABSENCE.
const EXISTENCE_ABSENCE =
  /ausente|inexistente|n[aã]o\s+existe|n[aã]o\s+(foi\s+)?(implementad|criad|adicionad|declarad|definid|encontrad)|does\s+not\s+exist|doesn'?t\s+exist|is\s+not\s+(defined|declared|implemented)|not\s+(defined|declared|implemented|found)/i;

// Alegação de TESTE ausente.
const TEST_ABSENCE =
  /sem\s+(testes?|cobertura)|n[aã]o\s+(possui|tem|h[aá])\s+testes?|falta[m]?\s+testes?|missing\s+(unit\s+)?tests?|no\s+(unit\s+)?tests?|without\s+tests?/i;

// Menção a arquivo .env*.example (classe de env).
const ENV_MENTION = /\.env[\w.]*\b|env\.example/i;
// Ausência genérica (usada só na classe env, junto de ENV_MENTION).
const GENERIC_ABSENCE = /ausente|falta|n[aã]o\s+est|not\s+(in|present)|missing/i;

/** Identificadores citados no finding: entre crases/aspas, PascalCase/camelCase, UPPER_SNAKE. */
function candidateSymbols(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/[`'"]([A-Za-z_$][\w$]*)[`'"]/g)) if (m[1]) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Za-z][a-z0-9]*[A-Z][A-Za-z0-9]{2,})\b/g)) if (m[1]) out.add(m[1]);
  for (const m of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)) if (m[1]) out.add(m[1]);
  return [...out];
}

/** "Sujeito" do arquivo citado: `useIsAndroid.ts` -> `useIsAndroid` (nome antes do 1º ponto). */
function fileSubjectOf(file: string): string {
  const name = basename(file);
  const dot = name.indexOf('.');
  return dot === -1 ? name : name.slice(0, dot);
}

/** Retorna a razão da supressão se o finding é uma ausência REFUTADA pela presença, senão null. */
export function presenceHit(f: Finding, symbols: Set<string>, tests: Set<string>, envs: Set<string>): string | null {
  const text = `${f.title}\n${f.rationale}`;
  if (isBehavioralAbsence(text)) return null; // ausência de comportamento: jamais suprime
  const cands = candidateSymbols(text);
  if (TEST_ABSENCE.test(text)) {
    const hit = [fileSubjectOf(f.file), ...cands].find((c) => c && tests.has(c));
    return hit ? `teste de ${hit} existe no repositório` : null;
  }
  if (ENV_MENTION.test(text) && GENERIC_ABSENCE.test(text)) {
    const hit = cands.find((c) => envs.has(c));
    return hit ? `env ${hit} presente em .env.example` : null;
  }
  if (EXISTENCE_ABSENCE.test(text)) {
    const hit = cands.find((c) => symbols.has(c));
    return hit ? `símbolo ${hit} declarado no repositório` : null;
  }
  return null;
}
