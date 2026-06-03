import type { Severity } from './types.js';

/**
 * Store de withdrawals: findings que o dev CONTESTOU com argumento válido (via
 * judge-pushback). Diferente do verificador de código (onde o código MUDA e o finding
 * some sozinho), aqui o código NÃO muda — só o argumento. Sem o store, o re-review
 * re-detectaria e re-postaria o finding a cada push (loop). O store vive num comentário
 * top-level dedicado no PR (espelha o summary), e o pipeline o consulta para suprimir.
 *
 * Casamento por `findingId` EXATO (sha1(file:lineAnchor:category)), não proximidade:
 * findingId inclui `category`, então `cred` withdrawn não suprime `perf` na mesma linha.
 * Invalidação: se o ARQUIVO mudar desde o acceptedSha, o argumento (sobre o código antigo)
 * expira e o finding volta a valer.
 */

export interface Withdrawal {
  findingId: string;
  severity: Severity;
  acceptedSha: string;
  acceptedAt: string;
  acceptedBy: string;
  category: string;
  file: string;
}

export const withdrawalsMarker = '<!-- movvia-ai-review:withdrawals -->';

const JSON_BLOCK = /```json\s*([\s\S]*?)```/;

/**
 * Lê as entries do bloco JSON sob o marker. FAIL-SAFE: marker/bloco ausente ou JSON
 * quebrado => []. Na dúvida o store NÃO suprime (oposto do fail-closed do judge, que na
 * dúvida NÃO fecha) e o job NUNCA derruba por causa de um comentário corrompido.
 */
export function parseWithdrawals(body: string): Withdrawal[] {
  if (!body.includes(withdrawalsMarker)) return [];
  const block = JSON_BLOCK.exec(body);
  if (!block || block[1] === undefined) return [];
  try {
    const parsed = JSON.parse(block[1]) as { withdrawals?: unknown };
    return Array.isArray(parsed.withdrawals) ? (parsed.withdrawals as Withdrawal[]) : [];
  } catch {
    return [];
  }
}

/** Serializa o comentário-estado: marker + bloco json (parse simétrico de parseWithdrawals). */
export function buildWithdrawalsComment(withdrawals: Withdrawal[]): string {
  return [withdrawalsMarker, '```json', JSON.stringify({ withdrawals }), '```'].join('\n');
}

/**
 * Upsert por findingId (atualiza acceptedSha/acceptedAt em vez de empilhar duplicata).
 * REJEITA severity P0: o store NUNCA contém P0 — um P0 jamais é suprimido por argumento
 * textual (decisão Pablo). Guarda inviolável: mesmo que o judge erre, P0 não entra aqui.
 */
export function upsertWithdrawal(list: Withdrawal[], entry: Withdrawal): Withdrawal[] {
  if (entry.severity === 'P0') return list;
  const semDuplicata = list.filter((w) => w.findingId !== entry.findingId);
  return [...semDuplicata, entry];
}

/**
 * Provider injetado: true se o ARQUIVO mudou desde o acceptedSha (→ o withdrawal expira).
 * No CLI é uma closure sobre changedFilesSince(acceptedSha, head) por entry.
 */
export type WithdrawalDeltaProvider = (file: string, acceptedSha: string) => boolean;

/**
 * Decide quais withdrawals ainda valem: os de arquivo INTOCADO desde o acceptedSha. Os de
 * arquivo modificado EXPIRAM (o argumento era sobre o código antigo) e somem do store
 * re-escrito. Usa o acceptedSha de CADA entry — não um previousSha global (entries têm
 * SHAs distintos). Granularidade de arquivo: conservador (expira cedo, nunca tarde demais).
 */
export function computeValidWithdrawals(
  entries: Withdrawal[],
  fileMudou: WithdrawalDeltaProvider,
): { validIds: Set<string>; survivors: Withdrawal[] } {
  const survivors = entries.filter((e) => !fileMudou(e.file, e.acceptedSha));
  return { validIds: new Set(survivors.map((e) => e.findingId)), survivors };
}
