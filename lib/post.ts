import type { Finding, Verdict } from './types.js';
import { findingId } from './gatekeeper.js';

export function summaryMarker(sha: string): string {
  return `<!-- movvia-ai-review:summary sha=${sha} -->`;
}

export function parseSummarySha(body: string): string | null {
  return /<!-- movvia-ai-review:summary sha=([0-9a-f]+) -->/.exec(body)?.[1] ?? null;
}

/**
 * Marker invisivel por finding: dedup idempotente entre re-runs.
 *
 * Ancora no `findingId` do gatekeeper (hash de file:lineAnchor:category) em vez
 * de `startLine` cru. Motivo: o dedup-contra-threads-existentes da spec
 * ("mesmo marker + path + line ±3 -> responde na thread") so funciona se um
 * commit que empurra o codigo 1 linha NAO gerar marker novo. Linha crua
 * geraria, reabrindo o bug que o gatekeeper (LINE_BUCKET=5) ja resolveu.
 */
export function findingMarker(f: Finding): string {
  return `<!-- movvia-ai-review:${f.agent}:${findingId(f)} -->`;
}

export function buildSummary(findings: Finding[], verdict: Verdict, sha: string): string {
  const { P0, P1, P2 } = verdict.counts;
  const titulo = verdict.event === 'REQUEST_CHANGES' ? '🔴 Mudancas necessarias' : '🟢 Aprovado';
  const linhas = findings
    .slice()
    .sort((a, b) => a.severity.localeCompare(b.severity))
    .map((f) => `- **${f.severity}** \`${f.file}:${f.startLine}\` — ${f.title}`)
    .join('\n');
  return [
    `## 🤖 movvia-ai-review — ${titulo}`,
    '',
    `Severidades: **${P0} P0 · ${P1} P1 · ${P2} P2**`,
    '',
    linhas || '_Nenhum problema bloqueante encontrado._',
    '',
    summaryMarker(sha),
  ].join('\n');
}
