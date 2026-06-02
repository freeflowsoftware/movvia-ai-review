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

// --- CLI: post.ts <verdictPath> → posta resumo + check run ---
if (process.argv[1]?.endsWith('post.ts')) {
  const { readFileSync } = await import('node:fs');
  const { createOctokit, emitCheckRun, approveBestEffort } = await import('./github.js');
  // Fallback '' nos argv/split para satisfazer noUncheckedIndexedAccess do tsconfig.
  const { verdict, findings } = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
  const [owner = '', repo = ''] = (process.env.GH_REPO ?? '/').split('/');
  const prNumber = Number(process.env.PR_NUMBER);
  // Auth via GitHub App (REVIEW_APP_ID/REVIEW_APP_PRIVATE_KEY/REVIEW_INSTALLATION_ID)
  // mintando installation token; fallback para REVIEW_PAT. Falha cedo se faltar tudo.
  const octokit = createOctokit({
    appId: process.env.REVIEW_APP_ID,
    privateKey: process.env.REVIEW_APP_PRIVATE_KEY,
    installationId: process.env.REVIEW_INSTALLATION_ID,
    pat: process.env.REVIEW_PAT,
  });
  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const sha = pr.data.head.sha;
  const summary = buildSummary(findings, verdict, sha);
  await emitCheckRun(octokit, { owner, repo, prNumber }, sha, verdict.conclusion, summary);
  await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: summary });
  // O check run (via App) e quem trava o merge; o review formal via PAT do Pablo e
  // best-effort (o App nao pode aprovar o proprio PR de teste -> 422 ignorado).
  if (process.env.REVIEW_PAT) {
    const pat = createOctokit({ pat: process.env.REVIEW_PAT });
    await approveBestEffort(pat, { owner, repo, prNumber }, verdict.event);
  }
  console.log(`Posted: ${verdict.event} (${findings.length} findings)`);
}
