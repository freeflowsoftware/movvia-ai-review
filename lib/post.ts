import type { Finding, Verdict } from './types.js';
import type { ReviewEvent } from './github.js';
import { findingId } from './gatekeeper.js';
import { parseCite } from './cite-the-line.js';

/**
 * O review formal (APPROVE/REQUEST_CHANGES) so e submetido quando ha identidade que
 * conta para branch protection (GitHub App ou PAT humano). Sem ela (piloto rodando
 * com o GITHUB_TOKEN nativo), cai para COMMENT: o veredicto real fica no check run
 * review-bot/verdict, que e o gate de merge — evita 422 e approve-de-bot inutil.
 */
export function decideReviewEvent(verdictEvent: 'APPROVE' | 'REQUEST_CHANGES', hasReviewIdentity: boolean): ReviewEvent {
  return hasReviewIdentity ? verdictEvent : 'COMMENT';
}

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

/** Comentario inline pronto para pulls.createReview (path + linha + corpo). */
export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Um comentario inline NOSSO ja postado no PR: o `findingMarker` extraido do corpo
 * (ancora estavel de dedup) + o id da review thread (para resolver no GraphQL). A
 * borda que lista as threads e injetada de fora; reconcileInline so recebe este par.
 */
export interface ExistingThread {
  marker: string;
  threadId: string;
}

/**
 * Reconciliacao PURA do re-review (sem I/O): decide o que postar e o que fechar a
 * partir dos findings ATUAIS e das threads que JA postamos. Sem ela o post duplica
 * inline a cada run e nunca resolve o que o dev corrigiu (TODO de post.ts).
 *
 * - toPost: findings cujo marker NAO existe em nenhuma thread -> sao novos.
 * - toResolveThreadIds: threads cujo marker SUMIU dos findings -> o dev corrigiu.
 * - finding que persiste (marker em ambos): nem re-posta nem resolve (segue pendente).
 *
 * Ancora no findingMarker (e nao na linha crua) para sobreviver a deslocamento de
 * linha — mesma garantia de idempotencia documentada em findingMarker/findingId.
 */
export function reconcileInline(
  findings: Finding[],
  existing: ExistingThread[],
): { toPost: Finding[]; toResolveThreadIds: string[] } {
  const markersExistentes = new Set(existing.map((t) => t.marker));
  const markersAtuais = new Set(findings.map(findingMarker));
  const toPost = findings.filter((f) => !markersExistentes.has(findingMarker(f)));
  const toResolveThreadIds = existing
    .filter((t) => !markersAtuais.has(t.marker))
    .map((t) => t.threadId);
  return { toPost, toResolveThreadIds };
}

function buildInlineBody(f: Finding): string {
  // Carrega tudo que o autor humano precisa para agir e termina com o marker
  // invisivel — ancora estavel de dedup idempotente entre re-runs (findingMarker).
  return [
    `**${f.severity}** — ${f.title}`,
    '',
    f.rationale,
    '',
    `**Sugestao:** ${f.suggestion}`,
    '',
    findingMarker(f),
  ].join('\n');
}

/**
 * Diferencial do prototipo /revisar-pr: comentario NA linha exata da ofensa.
 *
 * line = endLine (nao startLine) porque o GitHub exige que a linha ancore na
 * ultima linha do trecho dentro do diff; usar o fim casa a thread com o range
 * inteiro citado em `cite`. Funcao PURA: o post real fica em postReview (borda).
 */
export function buildInlineComments(findings: Finding[]): InlineComment[] {
  // path/line vem do `cite` JA VALIDADO contra o diff (relativo ao repo), nao do
  // `file`/`endLine` crus — alguns modelos emitem caminho absoluto (ex: do checkout
  // _review), o que faz o GitHub rejeitar a review inteira com 422 "Path could not
  // be resolved". Fallback para file/endLine se o cite nao parsear.
  return findings.map((f) => {
    const cite = parseCite(f.cite);
    return { path: cite?.file ?? f.file, line: cite?.end ?? f.endLine, body: buildInlineBody(f) };
  });
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

/**
 * Idempotencia do resumo: reusa o comentario top-level ja existente em vez de
 * acumular um novo a cada re-run. Lista os comentarios do PR e devolve o id do
 * primeiro que carrega o summaryMarker (marker invisivel cravado por buildSummary).
 */
async function findExistingSummaryId(
  octokit: { issues: { listComments(p: { owner: string; repo: string; issue_number: number }): Promise<{ data: Array<{ id: number; body?: string }> }> } },
  t: { owner: string; repo: string; prNumber: number },
): Promise<number | null> {
  const { data } = await octokit.issues.listComments({ owner: t.owner, repo: t.repo, issue_number: t.prNumber });
  const previo = data.find((c) => c.body?.includes('<!-- movvia-ai-review:summary'));
  return previo?.id ?? null;
}

// --- CLI: post.ts <verdictPath> → posta resumo (idempotente) + inline + check run ---
if (process.argv[1]?.endsWith('post.ts')) {
  const { readFileSync } = await import('node:fs');
  const { createOctokit, emitCheckRun, approveBestEffort, postReview } = await import('./github.js');
  // Fallback '' nos argv/split para satisfazer noUncheckedIndexedAccess do tsconfig.
  const { verdict, findings } = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
  const [owner = '', repo = ''] = (process.env.GH_REPO ?? '/').split('/');
  const prNumber = Number(process.env.PR_NUMBER);
  // Auth via GitHub App (REVIEW_APP_ID/REVIEW_APP_PRIVATE_KEY/REVIEW_INSTALLATION_ID)
  // mintando installation token; fallback para REVIEW_PAT. Falha cedo se faltar tudo.
  // Fallback para o GITHUB_TOKEN nativo do Actions quando nao ha App nem PAT (piloto):
  // permite postar comentario/inline/check run com as permissions do workflow.
  const octokit = createOctokit({
    appId: process.env.REVIEW_APP_ID,
    privateKey: process.env.REVIEW_APP_PRIVATE_KEY,
    installationId: process.env.REVIEW_INSTALLATION_ID,
    // `||` (nao `??`): secrets ausentes no Actions chegam como STRING VAZIA, nao
    // undefined; com `??` o REVIEW_PAT='' venceria e o GH_TOKEN nunca seria usado.
    pat: process.env.REVIEW_PAT || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  });
  // Identidade forte = App ou PAT humano (conta para branch protection). Só GITHUB_TOKEN
  // não conta, então o review vira COMMENT e o veredicto real fica no check run.
  const hasReviewIdentity = Boolean(process.env.REVIEW_APP_ID || process.env.REVIEW_PAT);
  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const sha = pr.data.head.sha;
  const summary = buildSummary(findings, verdict, sha);
  await emitCheckRun(octokit, { owner, repo, prNumber }, sha, verdict.conclusion, summary);
  // Idempotencia: re-run num mesmo PR atualiza o resumo existente em vez de empilhar
  // um novo a cada commit. Ancora no summaryMarker ja embutido por buildSummary.
  const existingId = await findExistingSummaryId(octokit, { owner, repo, prNumber });
  if (existingId !== null) {
    await octokit.issues.updateComment({ owner, repo, comment_id: existingId, body: summary });
  } else {
    await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: summary });
  }
  // Diferencial do prototipo /revisar-pr: comentarios INLINE na linha exata. Postados
  // junto do veredicto numa unica review (resumo no body) ancorada no sha revisado.
  // TODO pos-piloto: dedup inline via findingMarker + resolveReviewThread.
  const inlineComments = buildInlineComments(findings);
  const reviewEvent = decideReviewEvent(verdict.event, hasReviewIdentity);
  await postReview(octokit, { owner, repo, prNumber }, sha, reviewEvent, summary, inlineComments);
  // O check run (via App) e quem trava o merge; o review formal via PAT do Pablo e
  // best-effort (o App nao pode aprovar o proprio PR de teste -> 422 ignorado).
  if (process.env.REVIEW_PAT) {
    const pat = createOctokit({ pat: process.env.REVIEW_PAT });
    await approveBestEffort(pat, { owner, repo, prNumber }, verdict.event);
  }
  console.log(`Posted: ${verdict.event} (${findings.length} findings, ${inlineComments.length} inline)`);
}
