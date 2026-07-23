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
  /**
   * Argumento textual da dispensa manual por comando (`/ai-review dismiss ... <motivo>`,
   * PED-2728). Opcional: o judge-pushback grava sem motivo (a evidência é a reply na
   * thread). Entradas antigas sem o campo continuam válidas (parse tolerante).
   */
  motivo?: string;
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

/** Casa por findingId exato: atualiza a entry existente em vez de empilhar duplicata. */
function upsertByFindingId(list: Withdrawal[], entry: Withdrawal): Withdrawal[] {
  const semDuplicata = list.filter((w) => w.findingId !== entry.findingId);
  return [...semDuplicata, entry];
}

/**
 * Upsert do JUDGE-PUSHBACK: REJEITA severity P0 incondicionalmente — o store nunca contém
 * P0 por argumento textual (decisão Pablo). Guarda inviolável: mesmo que o judge erre, P0
 * não entra por aqui. A única porta de P0 é upsertDismissal (comando explícito de CODEOWNER).
 */
export function upsertWithdrawal(list: Withdrawal[], entry: Withdrawal): Withdrawal[] {
  if (entry.severity === 'P0') return list;
  return upsertByFindingId(list, entry);
}

/**
 * Upsert da DISPENSA MANUAL por comando (PED-2728, ADR-002). Aceita P0 SOMENTE quando
 * `allowP0` é true — no CLI isso exige, cumulativamente: autor CODEOWNER do arquivo, flag
 * `dismiss.allow_p0_by_codeowner` ligada e ADR-002 Aceito. Fora disso, P0 é rejeitado
 * (comportamento idêntico ao judge). P1/P2 sempre entram.
 */
export function upsertDismissal(list: Withdrawal[], entry: Withdrawal, allowP0: boolean): Withdrawal[] {
  if (entry.severity === 'P0' && !allowP0) return list;
  return upsertByFindingId(list, entry);
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
