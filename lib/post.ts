import type { Finding, Verdict } from './types.js';
import type { ReviewEvent } from './github.js';
import { findingId, type SuppressedByPresence } from './gatekeeper.js';
import { parseCite } from './cite-the-line.js';
import { readVerifyConfig, verifyZombieThreads, type ZombieThread } from './verify-fix.js';

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

/**
 * Suprime findings WITHDRAWN (o dev contestou com argumento válido via judge-pushback).
 * Por `findingId` EXATO (inclui category) — não proximidade: `cred` withdrawn NÃO suprime
 * `perf` na mesma linha/região. Aplicado ANTES da reconciliação: um finding withdrawn
 * nunca vira inline novo (toPost) nem reabre/reconcilia thread no re-review.
 */
export function suppressByWithdrawals(findings: Finding[], withdrawnIds: Set<string>): Finding[] {
  return findings.filter((f) => !withdrawnIds.has(findingId(f)));
}

/** Comentario inline pronto para pulls.createReview (path + linha + corpo). */
export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

/**
 * Um comentario inline NOSSO ja postado no PR: o `findingMarker` extraido do corpo
 * (ancora estavel de dedup) + o id da review thread (para resolver no GraphQL) + o
 * `path` do arquivo onde a thread ancorou. A borda que lista as threads e injetada
 * de fora; reconcileInline so recebe este trio.
 *
 * `path` existe para o re-review por delta: so reconciliamos threads de arquivos que
 * o dev mexeu desde o ultimo review, preservando as demais (sem churn de resolve+repost).
 *
 * `line` (posicao ATUAL da thread no head, re-ancorada pelo GitHub) e a chave da
 * reconciliacao por PROXIMIDADE: casamos finding<->thread por (path + linha +-LINE_PROX)
 * em vez do marker exato. O modelo e nao-deterministico e re-gera markers diferentes a
 * cada run; reconciliar por marker faria todo finding re-detectado virar "novo" e as
 * threads ACUMULARIAM. Proximidade reconhece "e o mesmo problema, na mesma regiao".
 *
 * `isOutdated` (GitHub marca true quando a LINHA que a thread ancora mudou desde que
 * postamos) e o gate de resolucao: so fechamos uma thread se o dev MEXEU na linha do
 * finding — nunca por o modelo ter deixado de re-detectar. Sem isso um P0 fecharia
 * sozinho com o codigo vulneravel intacto.
 *
 * `marker` ainda existe so para o lado de leitura (listFindingThreads reconhece os
 * comentarios NOSSOS pelo marker); a reconciliacao NAO o usa mais.
 */
export interface ExistingThread {
  marker: string;
  threadId: string;
  path: string;
  line: number;
  isOutdated: boolean;
  /**
   * Corpo do 1º comentario da thread (o finding original via buildInlineBody). Opcional:
   * só o verificador de correção (fecha-zumbi) precisa — reconstrói o dossiê com
   * parseInlineBody. A reconciliação por proximidade não o usa.
   */
  rootBody?: string;
}

/** Janela de proximidade (linhas) para casar um finding com uma thread ja postada. */
const LINE_PROX = 5;

/** Arquivo de um finding: o cite JA validado contra o diff vence; file cru e fallback. */
function findingFile(f: Finding): string {
  return parseCite(f.cite)?.file ?? f.file;
}

/** Linha do finding: o fim do range citado (casa com a `line` da thread, ancorada no fim). */
function findingLine(f: Finding): number {
  return parseCite(f.cite)?.end ?? f.endLine;
}

/** Mesmo arquivo E linha dentro da janela LINE_PROX -> tratamos como o MESMO problema. */
function matchesThread(f: Finding, t: ExistingThread): boolean {
  return findingFile(f) === t.path && Math.abs(findingLine(f) - t.line) <= LINE_PROX;
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
 *
 * `changedFiles` (re-review incremental): o modelo nao-deterministico re-gera markers
 * diferentes a cada run, entao reconciliar o PR inteiro causa churn (resolve+repost)
 * em arquivos que o dev nem tocou. Quando presente, restringe a reconciliacao SO aos
 * arquivos do delta — findings/threads fora dele sao PRESERVADOS intactos. undefined
 * (1o review, sem SHA anterior) mantem o comportamento atual: reconcilia tudo.
 */
export function reconcileInline(
  findings: Finding[],
  existing: ExistingThread[],
  changedFiles?: string[],
): { toPost: Finding[]; toResolveThreadIds: string[]; zombieCandidateThreadIds: string[] } {
  // Early return: sem delta conhecido reconcilia o PR inteiro (caminho do 1o review).
  if (changedFiles === undefined) return reconcileScope(findings, existing);
  const delta = new Set(changedFiles);
  const findingsNoDelta = findings.filter((f) => delta.has(findingFile(f)));
  const threadsNoDelta = existing.filter((t) => delta.has(t.path));
  return reconcileScope(findingsNoDelta, threadsNoDelta);
}

/**
 * Reconciliacao por PROXIMIDADE (nao por marker) sobre um escopo ja filtrado:
 *
 * - toPost: finding SEM thread proxima (mesmo arquivo, linha +-LINE_PROX) -> e novo.
 *   Casar por proximidade (e nao por marker exato) impede o ACUMULO: o modelo
 *   nao-deterministico re-detecta o mesmo problema com marker/linha levemente diferente
 *   a cada run; sem proximidade cada re-deteccao viraria um comentario novo.
 * - toResolveThreadIds: thread SEM finding proximo (o problema sumiu do radar) E
 *   isOutdated (o dev mexeu na linha que a originou). As DUAS condicoes: "sumiu" sozinho
 *   nao basta (o modelo pode so nao ter re-detectado) e "outdated" sozinho nao basta
 *   (a linha pode ter mudado por outro motivo). Juntas: o dev tocou a linha E o problema
 *   nao reaparece -> corrigido. Um P0 nunca fecha com o codigo vulneravel intacto.
 * - thread COM finding proximo: persiste (nem re-posta nem resolve).
 */
function reconcileScope(
  findings: Finding[],
  existing: ExistingThread[],
): { toPost: Finding[]; toResolveThreadIds: string[]; zombieCandidateThreadIds: string[] } {
  const toPost = findings.filter((f) => !existing.some((t) => matchesThread(f, t)));
  const toResolveThreadIds = existing
    .filter((t) => t.isOutdated && !findings.some((f) => matchesThread(f, t)))
    .map((t) => t.threadId);
  // ZUMBI: thread cujo problema sumiu do radar (sem finding proximo) MAS a linha nao
  // mudou (!isOutdated) — exatamente as que a heuristica PRESERVA hoje (o gate isOutdated
  // nao fecha). Podem ter sido corrigidas por insercao DISTANTE da linha ancorada. O
  // verificador de codigo (verify-fix) confirma lendo o arquivo se de fato foi corrigido.
  const zombieCandidateThreadIds = existing
    .filter((t) => !t.isOutdated && !findings.some((f) => matchesThread(f, t)))
    .map((t) => t.threadId);
  return { toPost, toResolveThreadIds, zombieCandidateThreadIds };
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

/**
 * Nota de transparência dos findings descartados pelo guard determinístico de presença
 * (regra "no silent caps": nada é cortado em silêncio). Vazia quando não houve supressão,
 * para não poluir o resumo do caso comum.
 */
function suppressedNote(suppressed: SuppressedByPresence[]): string[] {
  if (suppressed.length === 0) return [];
  const itens = suppressed
    .map((s) => `- ~~**${s.finding.severity}** \`${s.finding.file}\` — ${s.finding.title}~~ (${s.reason})`)
    .join('\n');
  return [
    '',
    `<details><summary>🔎 ${suppressed.length} achado(s) descartado(s) por verificação determinística de presença</summary>`,
    '',
    itens,
    '</details>',
  ];
}

/**
 * Nota das dimensões que degradaram (ex: timeout do LLM) e NÃO foram avaliadas nesta run.
 * Transparência: o dev sabe que aquela dimensão não rodou (não é "aprovado sem ressalvas").
 */
function degradedNote(degraded: string[]): string[] {
  if (degraded.length === 0) return [];
  return ['', `⚠️ Dimensão(ões) **${degraded.join(', ')}** não avaliada(s) nesta run (falha/timeout do reviewer).`];
}

export function buildSummary(
  findings: Finding[],
  verdict: Verdict,
  sha: string,
  suppressed: SuppressedByPresence[] = [],
  degraded: string[] = [],
): string {
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
    ...degradedNote(degraded),
    ...suppressedNote(suppressed),
    '',
    summaryMarker(sha),
  ].join('\n');
}

/** Referencia ao resumo NOSSO ja postado: id (para update idempotente) + SHA do ultimo review. */
export interface SummaryRef {
  id: number | null;
  previousSha: string | null;
}

/**
 * Logica PURA: acha o resumo NOSSO entre os comentarios top-level do PR e devolve
 * { id, previousSha }. O `id` reusa o comentario no update idempotente (em vez de
 * empilhar um novo a cada re-run); o `previousSha` (via parseSummarySha do body) e o
 * SHA do ultimo review — base do delta do re-review incremental (changedFilesSince).
 *
 * previousSha pode ser null mesmo com id setado: resumo de formato antigo sem o marker
 * de sha -> reusa o id mas cai no caminho de reconciliar o PR inteiro.
 */
export function summaryRefFromComments(comments: Array<{ id: number; body?: string }>): SummaryRef {
  const previo = comments.find((c) => c.body?.includes('<!-- movvia-ai-review:summary'));
  if (!previo) return { id: null, previousSha: null };
  return { id: previo.id, previousSha: parseSummarySha(previo.body ?? '') };
}

/**
 * Decisao PURA do re-review por delta: so reconcilia restrito aos arquivos do delta
 * quando ha um SHA anterior E ele difere do atual (houve commit novo desde o ultimo
 * review). No 1o review (previousSha null) ou re-run sem commit novo (mesmo SHA) cai no
 * caminho de reconciliar o PR inteiro — comparar um SHA contra ele mesmo daria delta
 * vazio e resolveria todas as threads por engano.
 */
export function shouldReconcileByDelta(previousSha: string | null, sha: string): boolean {
  return previousSha !== null && previousSha !== sha;
}

/**
 * Idempotencia do resumo: reusa o comentario top-level ja existente em vez de
 * acumular um novo a cada re-run. Lista os comentarios do PR e delega a
 * summaryRefFromComments (pura) a escolha do resumo NOSSO + extracao do SHA anterior.
 */
async function findExistingSummaryRef(
  octokit: { issues: { listComments(p: { owner: string; repo: string; issue_number: number }): Promise<{ data: Array<{ id: number; body?: string }> }> } },
  t: { owner: string; repo: string; prNumber: number },
): Promise<SummaryRef> {
  const { data } = await octokit.issues.listComments({ owner: t.owner, repo: t.repo, issue_number: t.prNumber });
  return summaryRefFromComments(data);
}

// --- CLI: post.ts <verdictPath> → posta resumo (idempotente) + inline + check run ---
if (process.argv[1]?.endsWith('post.ts')) {
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { createOctokit, emitCheckRun, approveBestEffort, postReview, listFindingThreads, resolveReviewThreads, replyToReviewThread, getFileAtRef, changedFilesSince } = await import('./github.js');
  const { parseWithdrawals, buildWithdrawalsComment, computeValidWithdrawals, withdrawalsMarker } = await import('./withdrawals.js');
  const { decideVerdict } = await import('./gatekeeper.js');
  // Fallback '' nos argv/split para satisfazer noUncheckedIndexedAccess do tsconfig.
  const { verdict: rawVerdict, findings: rawFindings, suppressed: rawSuppressed, degraded: rawDegraded } = JSON.parse(readFileSync(process.argv[2] ?? '', 'utf8'));
  // `suppressed` (guard de presença) e `degraded` (dimensões que falharam) podem faltar em
  // verdict.json antigos — degradação graciosa para lista vazia.
  const suppressed: SuppressedByPresence[] = Array.isArray(rawSuppressed) ? rawSuppressed : [];
  const degraded: string[] = Array.isArray(rawDegraded) ? rawDegraded : [];
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
  // Octokit dedicado para RESOLVER threads: confirmado em runtime que o GITHUB_TOKEN
  // nativo do bot NAO resolve review threads (a mutation GraphQL nao tem efeito), so um
  // PAT/App resolve. Preferimos um PAT (REVIEW_PAT / AI_REVIEW_REPO_TOKEN) e caimos no
  // App quando configurado; ultimo recurso e o `octokit` ja montado (com GH_TOKEN). `||`
  // (nao `??`) porque secrets ausentes no Actions chegam como STRING VAZIA, nao undefined.
  const resolvePat = process.env.REVIEW_PAT || process.env.AI_REVIEW_REPO_TOKEN;
  const resolveOctokit = resolvePat || process.env.REVIEW_APP_ID
    ? createOctokit({
        appId: process.env.REVIEW_APP_ID,
        privateKey: process.env.REVIEW_APP_PRIVATE_KEY,
        installationId: process.env.REVIEW_INSTALLATION_ID,
        pat: resolvePat,
      })
    : octokit;
  const pr = await octokit.pulls.get({ owner, repo, pull_number: prNumber });
  const sha = pr.data.head.sha;
  // STORE DE WITHDRAWALS: suprime findings que o dev CONTESTOU com argumento valido
  // (judge-pushback). Invalida os withdrawals cujo arquivo mudou desde o acceptedSha (o
  // argumento era sobre o codigo antigo -> o finding volta a valer). Re-escreve o store
  // quando algo expira. O verdict e RECOMPUTADO sobre os findings vivos (um P1 contestado
  // deixa de bloquear). P0 nunca entra no store (upsertWithdrawal rejeita).
  const allComments = (await octokit.issues.listComments({ owner, repo, issue_number: prNumber })).data;
  const wComment = allComments.find((c) => c.body?.includes(withdrawalsMarker));
  const wEntries = wComment ? parseWithdrawals(wComment.body ?? '') : [];
  let withdrawnIds = new Set<string>();
  if (wEntries.length > 0) {
    const deltaPorSha = new Map<string, Set<string> | null>();
    for (const acceptedSha of new Set(wEntries.map((e) => e.acceptedSha))) {
      try {
        deltaPorSha.set(acceptedSha, new Set(await changedFilesSince(octokit, { owner, repo, prNumber }, acceptedSha, sha)));
      } catch {
        deltaPorSha.set(acceptedSha, null); // nao computou -> conservador (expira)
      }
    }
    const fileMudou = (file: string, acceptedSha: string) => {
      const d = deltaPorSha.get(acceptedSha);
      return d ? d.has(file) : true;
    };
    const { validIds, survivors } = computeValidWithdrawals(wEntries, fileMudou);
    withdrawnIds = validIds;
    if (wComment && survivors.length !== wEntries.length) {
      await octokit.issues.updateComment({ owner, repo, comment_id: wComment.id, body: buildWithdrawalsComment(survivors) });
    }
  }
  const findings = suppressByWithdrawals(rawFindings, withdrawnIds);
  // Recompute passa `degraded`: uma dimensão não avaliada mantém o veredito fail-closed mesmo
  // após o dev contestar findings (senão um withdrawal reabriria a porta do "verde" sobre parcial).
  const verdict = withdrawnIds.size > 0 ? decideVerdict(findings, degraded) : rawVerdict;
  const summary = buildSummary(findings, verdict, sha, suppressed, degraded);
  await emitCheckRun(octokit, { owner, repo, prNumber }, sha, verdict.conclusion, summary);
  // Idempotencia: re-run num mesmo PR atualiza o resumo existente em vez de empilhar
  // um novo a cada commit. Ancora no summaryMarker ja embutido por buildSummary.
  // O previousSha (SHA do ultimo review) sai do mesmo comentario e alimenta o delta.
  const { id: existingId, previousSha } = await findExistingSummaryRef(octokit, { owner, repo, prNumber });
  if (existingId !== null) {
    await octokit.issues.updateComment({ owner, repo, comment_id: existingId, body: summary });
  } else {
    await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body: summary });
  }
  // Re-review incremental: se ha SHA anterior diferente do atual, reconcilia SO os
  // arquivos que o dev mexeu desde o ultimo review (preserva threads dos intocados).
  // 1o review (ou re-run sem commit novo) -> changedFiles undefined -> reconcilia tudo.
  const changedFiles = shouldReconcileByDelta(previousSha, sha)
    ? await changedFilesSince(octokit, { owner, repo, prNumber }, previousSha!, sha)
    : undefined;
  // Re-review: reconcilia os findings ATUAIS contra as threads inline que JA postamos.
  // listFindingThreads/resolveReviewThreads usam o resolveOctokit (PAT/App) porque o
  // GITHUB_TOKEN nativo do bot NAO resolve threads (confirmado em runtime).
  const existing = await listFindingThreads(resolveOctokit, { owner, repo, prNumber });
  const { toPost, toResolveThreadIds, zombieCandidateThreadIds } = reconcileInline(findings, existing, changedFiles);
  // Diferencial do prototipo /revisar-pr: comentarios INLINE na linha exata. Posta
  // SO os novos (toPost) numa unica review ancorada no sha; dedup via findingMarker.
  const inlineComments = buildInlineComments(toPost);
  const reviewEvent = decideReviewEvent(verdict.event, hasReviewIdentity);
  // toPost vazio -> NAO chama createReview com comments (GitHub rejeita review inline
  // vazia com 422); o veredicto ja saiu no check run + resumo idempotente acima.
  if (inlineComments.length > 0) {
    await postReview(octokit, { owner, repo, prNumber }, sha, reviewEvent, summary, inlineComments);
  }
  // VERIFICADOR DE CODIGO (fecha-zumbi): as threads zumbi (problema sumiu do radar mas a
  // linha nao mudou -> a heuristica isOutdated NAO fecharia) podem ter sido corrigidas por
  // insercao DISTANTE. Um LLM le o arquivo no head (getFileAtRef no SHA exato — sem risco
  // de estado obsoleto) e CONFIRMA a correcao citando a linha. P0 vira reply, nunca resolve.
  // So roda com candidatos + LLM configurado + identidade que resolve (PAT/App).
  let toResolveExtra: string[] = [];
  const canResolve = Boolean(resolvePat || process.env.REVIEW_APP_ID);
  if (zombieCandidateThreadIds.length > 0 && process.env.LLM_API_KEY && canResolve) {
    const { realChatRunner } = await import('./run-agent.js');
    const cfg = readVerifyConfig(join(import.meta.dirname, '..', 'config', 'defaults.yml'));
    const verifyModel = process.env.VERIFY_MODEL || process.env.DEDUP_MODEL || 'deepseek/deepseek-v4-flash';
    const candidates: ZombieThread[] = existing
      .filter((t) => zombieCandidateThreadIds.includes(t.threadId))
      .map((t) => ({ threadId: t.threadId, path: t.path, rootBody: t.rootBody ?? '' }));
    // resolveOctokit (PAT/App) tambem le o conteudo: em repo privado externo o GH_TOKEN da 403.
    const contentClient = resolveOctokit as unknown as Parameters<typeof getFileAtRef>[0];
    const fileProvider = (path: string) =>
      getFileAtRef(contentClient, { owner, repo, prNumber }, path, sha).then((c) => c ?? '');
    const { toResolveExtra: extra, p0ToReply } = await verifyZombieThreads({
      candidates, fileProvider, run: realChatRunner, model: verifyModel,
      closeThreshold: cfg.closeThreshold, maxThreads: cfg.maxThreads,
    });
    toResolveExtra = extra;
    // Reply P0: so se ainda NAO respondemos nessa thread (anti-loop por hasOurReply).
    const byId = new Map(existing.map((t) => [t.threadId, t]));
    for (const { threadId, correctionLine } of p0ToReply) {
      if (byId.get(threadId)?.hasOurReply) continue;
      const body = `Indicio de correcao na linha ${correctionLine}, mas este e um P0 e NAO fecha automaticamente — confirme e resolva manualmente (CODEOWNER).\n\n<!-- movvia-ai-review:reply:${threadId} -->`;
      await replyToReviewThread(resolveOctokit, threadId, body);
    }
  }
  // Fecha as threads que o dev corrigiu: pela heuristica (isOutdated) UNIAO as confirmadas
  // pelo verificador de codigo (zumbis). Idempotente; allSettled isola falha por thread.
  // resolveOctokit (PAT/App) porque o GITHUB_TOKEN do bot nao resolve threads.
  const allToResolve = [...toResolveThreadIds, ...toResolveExtra];
  const threadsResolvidas = await resolveReviewThreads(resolveOctokit, allToResolve);
  // O check run (via App) e quem trava o merge; o review formal via PAT do Pablo e
  // best-effort (o App nao pode aprovar o proprio PR de teste -> 422 ignorado).
  if (process.env.REVIEW_PAT) {
    const pat = createOctokit({ pat: process.env.REVIEW_PAT });
    await approveBestEffort(pat, { owner, repo, prNumber }, verdict.event);
  }
  // Reporta resolvidas REAIS / tentadas + quantos zumbis o verificador confirmou.
  console.log(
    `Posted: ${verdict.event} (${findings.length} findings, ${inlineComments.length} novos inline, ${threadsResolvidas}/${allToResolve.length} threads resolvidas, ${toResolveExtra.length}/${zombieCandidateThreadIds.length} zumbis confirmados)`,
  );
}
