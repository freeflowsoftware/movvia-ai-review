import type { Severity } from './types.js';
import type { ChatRunner } from './run-agent.js';
import { upsertDismissal, type Withdrawal } from './withdrawals.js';

/**
 * Dispensa MANUAL de finding por comando (PED-2728). Diferente do judge-pushback (LLM
 * julga um argumento numa reply inline), aqui um humano autorizado declara o finding
 * falso-positivo por comando top-level `/ai-review dismiss <findingId> <motivo>`, com
 * MOTIVO OBRIGATÓRIO, gravação DETERMINÍSTICA no store (sem LLM) e trilha de auditoria.
 * P0 só sai por CODEOWNER + flag (ADR-002); default bloqueado. Todo dismiss abre uma issue
 * de feedback no movvia-ai-review (best-effort, DEPOIS do write durável do store).
 * Núcleo PURO + bordas injetadas (DIP), como o judge — nenhum teste toca a rede.
 */

/** Resultado do parse do comando. `null` (fora do parse) = não é comando de dismiss. */
export type ParsedDismiss =
  | { kind: 'dismiss'; findingId: string; motivo: string }
  | { kind: 'undismiss'; findingId: string }
  | { kind: 'invalid'; reason: string };

// findingId = 12 hex (gatekeeper.findingId). Aceita colar o marker inteiro ou só o id.
const MARKER_ID = /<!--\s*movvia-ai-review:[a-z-]+:([0-9a-f]{6,40})\s*-->/i;
const BARE_ID = /^([0-9a-f]{12})\b/;
const COMMAND = /^\/ai-review\s+(dismiss|undismiss)\b([\s\S]*)$/i;

/** Extrai o findingId (marker colado ou 12 hex) e o que sobra (candidato a motivo). */
function extractId(rest: string): { findingId: string; remainder: string } | null {
  const trimmed = rest.trim();
  const marker = MARKER_ID.exec(trimmed);
  if (marker && marker[1]) {
    const remainder = (trimmed.slice(0, marker.index) + trimmed.slice(marker.index + marker[0].length)).trim();
    return { findingId: marker[1], remainder };
  }
  const bare = BARE_ID.exec(trimmed);
  if (bare && bare[1]) return { findingId: bare[1], remainder: trimmed.slice(bare[0].length).trim() };
  return null;
}

/**
 * Parseia o comando. Motivo OBRIGATÓRIO no dismiss (mínimo `minMotivoLen`): sem ele o
 * comando é `invalid` (no-op + reply de uso no orquestrador). `undismiss` não exige motivo.
 */
export function parseDismissCommand(body: string, minMotivoLen: number): ParsedDismiss | null {
  const cmd = COMMAND.exec(body.trim());
  if (!cmd || !cmd[1]) return null;
  const extracted = extractId(cmd[2] ?? '');
  if (!extracted) return { kind: 'invalid', reason: 'findingId ausente ou invalido (esperado 12 hex ou o marker colado inteiro)' };
  if (cmd[1].toLowerCase() === 'undismiss') return { kind: 'undismiss', findingId: extracted.findingId };
  const motivo = extracted.remainder;
  if (motivo.length < minMotivoLen) {
    return { kind: 'invalid', reason: `motivo obrigatorio (minimo ${minMotivoLen} caracteres). Uso: /ai-review dismiss <findingId> <motivo>` };
  }
  return { kind: 'dismiss', findingId: extracted.findingId, motivo };
}

/** Decisão de política. Espelha decideJudge: P0 só passa por CODEOWNER + flag (ADR-002). */
export type DismissDecision = { action: 'write' } | { action: 'reject'; reason: string };

export function decideDismiss(severity: Severity, isCodeowner: boolean, allowP0Policy: boolean): DismissDecision {
  if (severity !== 'P0') return { action: 'write' };
  if (!allowP0Policy) return { action: 'reject', reason: 'P0 nao e dispensavel por comando (politica atual; ADR-002 nao aceito).' };
  if (!isCodeowner) return { action: 'reject', reason: 'P0 so pode ser dispensado por CODEOWNER do arquivo do finding.' };
  return { action: 'write' };
}

/** O finding reconstruído do comentário inline (marker + buildInlineBody). category='' (hash irreversível). */
export interface DismissedFinding {
  findingId: string;
  severity: Severity;
  file: string;
  agent: string;
  category: string;
  title: string;
  rationale: string;
  suggestion: string;
}

/** Issue de feedback pronta para criar (idempotente por findingId via marker no corpo). */
export interface FeedbackIssue {
  title: string;
  body: string;
  labels: string[];
  findingId: string;
}

export const FEEDBACK_SYSTEM =
  'Voce analisa um FALSO-POSITIVO do movvia-ai-review (bot de code review). Um humano ' +
  'dispensou o finding abaixo por comando, com um motivo. Explique de forma objetiva (PT-BR) ' +
  'por que provavelmente foi falso-positivo e, sobretudo, COMO CORRIGIR O BOT para nao ' +
  'reincidir: qual agente/prompt (agents/<nome>.md), regra do refuter (gatekeeper) ou ' +
  'threshold (config/defaults.yml) ajustar. Seja concreto e curto. Responda em markdown com ' +
  'as secoes "Por que foi falso-positivo" e "Como corrigir para nao reincidir".';

export function buildFeedbackPrompt(finding: DismissedFinding, motivo: string, fileExcerpt: string): string {
  return [
    `Agente: ${finding.agent} | Severidade: ${finding.severity} | Arquivo: ${finding.file}`,
    `Titulo do finding: ${finding.title}`,
    `Justificativa do bot: ${finding.rationale}`,
    `Sugestao do bot: ${finding.suggestion}`,
    '',
    `Motivo humano da dispensa: ${motivo}`,
    '',
    'Trecho do arquivo no head (para embasar a analise):',
    fileExcerpt.slice(0, 8000),
  ].join('\n');
}

/** Marker de idempotência: uma issue de feedback por findingId. */
export function feedbackIssueMarker(findingId: string): string {
  return `<!-- movvia-ai-review:dismiss-feedback:${findingId} -->`;
}

/** Monta a issue de feedback (título + corpo com a análise do LLM + auditoria + marker). */
export function buildFeedbackIssue(
  finding: DismissedFinding,
  motivo: string,
  acceptedBy: string,
  prUrl: string,
  analysis: string,
): FeedbackIssue {
  const title = `dismiss falso-positivo: ${finding.agent}/${finding.category || 's/categoria'} — ${finding.file}`;
  const body = [
    `**Finding dispensado** \`${finding.findingId}\` (${finding.severity}) por @${acceptedBy}.`,
    `- Arquivo: \`${finding.file}\``,
    `- Agente: \`${finding.agent}\``,
    `- Título: ${finding.title}`,
    `- PR: ${prUrl}`,
    '',
    `**Motivo informado:** ${motivo}`,
    '',
    '---',
    analysis.trim() || '_Sem análise do LLM (fallback). Triar manualmente qual agente/threshold ajustar._',
    '',
    feedbackIssueMarker(finding.findingId),
  ].join('\n');
  return { title, body, labels: ['dismiss-feedback', 'false-positive'], findingId: finding.findingId };
}

/** Bordas injetadas (DIP): nenhuma toca a rede nos testes (FakeDismissDeps). */
export interface DismissDeps {
  findFindingById: (findingId: string) => Promise<DismissedFinding | null>;
  isCodeowner: (file: string, login: string) => Promise<boolean>;
  readWithdrawals: () => Promise<Withdrawal[]>;
  writeWithdrawals: (list: Withdrawal[]) => Promise<void>;
  resolveThreadFor: (findingId: string) => Promise<void>;
  reply: (body: string) => Promise<void>;
  fileProvider: (file: string) => Promise<string>;
  run: ChatRunner;
  createFeedbackIssue: (issue: FeedbackIssue) => Promise<string | null>;
}

export interface DismissInput {
  commentBody: string;
  author: string;
  headSha: string;
  now: string;
  prUrl: string;
}

export interface DismissConfig {
  minMotivoLen: number;
  allowP0Policy: boolean;
  feedbackModel: string;
  feedbackRepo: string;
}

/**
 * Orquestrador. parse -> lookup do finding -> política (P0 só CODEOWNER) -> WRITE do store
 * PRIMEIRO (durável) -> resolve thread + reply de auditoria -> DEPOIS issue de feedback
 * (best-effort em try/catch: falha aqui NUNCA desfaz o dismiss). Qualquer guarda que falhe
 * responde com reply e para (nunca grava). Segue backend-patterns (audit/write antes de
 * side-effect externo).
 */
export async function dismissRun(input: DismissInput, deps: DismissDeps, cfg: DismissConfig): Promise<void> {
  const parsed = parseDismissCommand(input.commentBody, cfg.minMotivoLen);
  if (!parsed) return;
  if (parsed.kind === 'invalid') {
    await deps.reply(`movvia-ai-review: ${parsed.reason}`);
    return;
  }
  const finding = await deps.findFindingById(parsed.findingId);
  if (!finding) {
    await deps.reply(`movvia-ai-review: findingId \`${parsed.findingId}\` nao encontrado nos comentarios inline deste PR.`);
    return;
  }
  if (parsed.kind === 'undismiss') {
    const list = await deps.readWithdrawals();
    await deps.writeWithdrawals(list.filter((w) => w.findingId !== parsed.findingId));
    await deps.reply(`movvia-ai-review: dispensa de \`${finding.findingId}\` revertida por @${input.author}. O finding volta a valer no proximo verdict.`);
    return;
  }
  await applyDismiss(finding, parsed.motivo, input, deps, cfg);
}

/** Caminho do dismiss (já parseado e com finding resolvido): política -> write -> feedback. */
async function applyDismiss(
  finding: DismissedFinding,
  motivo: string,
  input: DismissInput,
  deps: DismissDeps,
  cfg: DismissConfig,
): Promise<void> {
  const isOwner = finding.severity === 'P0' ? await deps.isCodeowner(finding.file, input.author) : false;
  const decision = decideDismiss(finding.severity, isOwner, cfg.allowP0Policy);
  if (decision.action === 'reject') {
    await deps.reply(`movvia-ai-review: dispensa recusada para \`${finding.findingId}\` (${finding.severity}). ${decision.reason}`);
    return;
  }
  const entry: Withdrawal = {
    findingId: finding.findingId, severity: finding.severity, acceptedSha: input.headSha,
    acceptedAt: input.now, acceptedBy: input.author, category: finding.category, file: finding.file, motivo,
  };
  const list = await deps.readWithdrawals();
  // allowP0 = autorização REAL (política + CODEOWNER), não "é P0?" — preserva a
  // defesa-em-profundidade do upsertDismissal (para P1/P2 isOwner é false e o arg é ignorado).
  await deps.writeWithdrawals(upsertDismissal(list, entry, cfg.allowP0Policy && isOwner));
  // Pós-write best-effort: o store já está durável. Nada aqui pode FALHAR o step (senão o
  // post.ts seguinte não roda e o check não recomputa) nem desfazer o dismiss.
  try {
    await deps.resolveThreadFor(finding.findingId);
    await deps.reply(
      `movvia-ai-review: finding \`${finding.findingId}\` (${finding.severity}) dispensado por @${input.author}.\nMotivo: ${motivo}\nO verdict sera recomputado; expira se \`${finding.file}\` mudar.`,
    );
  } catch (e) {
    console.log(`pos-dismiss (resolve/reply) pulado: ${(e as Error).message}`);
  }
  await openFeedback(finding, motivo, input, deps, cfg);
}

/** Side-effect externo best-effort: issue de feedback no movvia-ai-review. Nunca desfaz o dismiss. */
async function openFeedback(
  finding: DismissedFinding,
  motivo: string,
  input: DismissInput,
  deps: DismissDeps,
  cfg: DismissConfig,
): Promise<void> {
  try {
    const excerpt = await deps.fileProvider(finding.file);
    const analysis = await deps.run(cfg.feedbackModel, FEEDBACK_SYSTEM, buildFeedbackPrompt(finding, motivo, excerpt));
    const url = await deps.createFeedbackIssue(buildFeedbackIssue(finding, motivo, input.author, input.prUrl, analysis));
    if (url) await deps.reply(`movvia-ai-review: issue de feedback aberta para calibrar o bot: ${url}`);
  } catch (e) {
    console.log(`Issue de feedback pulada (dismiss ja aplicado): ${(e as Error).message}`);
  }
}

// --- CLI: dismiss.ts → aplica o comando ANTES do post.ts no mesmo job (event=dismiss) ---
if (process.argv[1]?.endsWith('dismiss.ts')) {
  const { createOctokit, getFileAtRef, listFindingThreads, resolveReviewThreads } = await import('./github.js');
  const { realChatRunner } = await import('./run-agent.js');
  const { parseWithdrawals, buildWithdrawalsComment, withdrawalsMarker } = await import('./withdrawals.js');
  const { parseInlineBody } = await import('./verify-fix.js');
  const { parseFindingMarker } = await import('./judge.js');
  const { parseCodeowners, ownersFor, isDirectOwner, teamOwners } = await import('./codeowners.js');
  const { readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { parse: parseYaml } = await import('yaml');

  const [owner = '', repo = ''] = (process.env.GH_REPO ?? '/').split('/');
  const prNumber = Number(process.env.PR_NUMBER);
  const commentId = Number(process.env.COMMENT_ID);
  const target = { owner, repo, prNumber };
  const octokit = createOctokit({
    appId: process.env.REVIEW_APP_ID,
    privateKey: process.env.REVIEW_APP_PRIVATE_KEY,
    installationId: process.env.REVIEW_INSTALLATION_ID,
    pat: process.env.REVIEW_PAT || process.env.AI_REVIEW_REPO_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN,
  });
  // Identidade que RESOLVE threads e cria a issue no repo central: PAT/App (o GITHUB_TOKEN
  // nativo nao resolve thread nem tem acesso ao repo privado central). Fallback: o octokit acima.
  const centralPat = process.env.REVIEW_PAT || process.env.AI_REVIEW_REPO_TOKEN;
  const centralOctokit = centralPat || process.env.REVIEW_APP_ID
    ? createOctokit({ appId: process.env.REVIEW_APP_ID, privateKey: process.env.REVIEW_APP_PRIVATE_KEY, installationId: process.env.REVIEW_INSTALLATION_ID, pat: centralPat })
    : octokit;

  const cfg = readDismissConfig(join(import.meta.dirname, '..', 'config', 'defaults.yml'));
  // Independentes -> em paralelo (uma ida de rede em vez de duas).
  const [pr, comment] = await Promise.all([
    octokit.pulls.get({ owner, repo, pull_number: prNumber }),
    octokit.issues.getComment({ owner, repo, comment_id: commentId }),
  ]);
  const headSha = pr.data.head.sha;
  const commentBody = comment.data.body ?? '';
  const author = comment.data.user?.login ?? '';

  const input: DismissInput = { commentBody, author, headSha, now: new Date().toISOString(), prUrl: pr.data.html_url };
  const deps: DismissDeps = buildCliDeps();
  await dismissRun(input, deps, cfg);
  console.log(`Dismiss: comando do comentario ${commentId} processado (autor ${author}).`);

  function readDismissConfig(path: string): DismissConfig {
    try {
      const raw = parseYaml(readFileSync(path, 'utf8')) as { dismiss?: Record<string, unknown> };
      const d = raw.dismiss ?? {};
      return {
        minMotivoLen: Number(d.min_motivo_len ?? 15),
        allowP0Policy: d.allow_p0_by_codeowner === true,
        feedbackModel: String(process.env.FEEDBACK_MODEL || d.feedback_model || 'deepseek/deepseek-v4-flash'),
        feedbackRepo: String(process.env.FEEDBACK_REPO || d.feedback_repo || 'freeflowsoftware/movvia-ai-review'),
      };
    } catch {
      return { minMotivoLen: 15, allowP0Policy: false, feedbackModel: 'deepseek/deepseek-v4-flash', feedbackRepo: 'freeflowsoftware/movvia-ai-review' };
    }
  }

  function buildCliDeps(): DismissDeps {
    const contentClient = centralOctokit as unknown as Parameters<typeof getFileAtRef>[0];
    return {
      findFindingById: async (findingId) => {
        const comments = (await octokit.pulls.listReviewComments({ owner, repo, pull_number: prNumber, per_page: 100 })).data;
        const hit = comments.find((c) => (c.body ?? '').includes(`:${findingId} -->`));
        if (!hit) return null;
        const dossie = parseInlineBody(hit.body ?? '');
        const marker = parseFindingMarker(hit.body ?? '');
        if (!dossie || !marker) return null;
        return { findingId, severity: dossie.severity, file: hit.path, agent: marker.agent, category: '', title: dossie.title, rationale: dossie.rationale, suggestion: dossie.suggestion };
      },
      isCodeowner: async (file, login) => {
        const text = await getFileAtRef(contentClient, target, '.github/CODEOWNERS', headSha)
          ?? await getFileAtRef(contentClient, target, 'CODEOWNERS', headSha);
        if (!text) return false; // fail-closed: sem CODEOWNERS legivel, ninguem e owner
        const owners = ownersFor(parseCodeowners(text), file);
        if (isDirectOwner(owners, login)) return true;
        for (const team of teamOwners(owners)) {
          const [org = '', slug = ''] = team.replace(/^@/, '').split('/');
          try {
            const m = await centralOctokit.teams.getMembershipForUserInOrg({ org, team_slug: slug, username: login });
            // 200 tambem cobre state='pending' (convite nao aceito) — so 'active' e membro real.
            if (m.data.state === 'active') return true;
          } catch { /* nao e membro / sem permissao -> fail-closed */ }
        }
        return false;
      },
      readWithdrawals: async () => {
        const comments = (await octokit.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 })).data;
        const w = comments.find((c) => c.body?.includes(withdrawalsMarker));
        return w ? parseWithdrawals(w.body ?? '') : [];
      },
      writeWithdrawals: async (list) => {
        const comments = (await octokit.issues.listComments({ owner, repo, issue_number: prNumber, per_page: 100 })).data;
        const w = comments.find((c) => c.body?.includes(withdrawalsMarker));
        const body = buildWithdrawalsComment(list);
        if (w) await octokit.issues.updateComment({ owner, repo, comment_id: w.id, body });
        else await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
      },
      resolveThreadFor: async (findingId) => {
        try {
          const threads = await listFindingThreads(centralOctokit, target);
          const t = threads.find((x) => x.marker.includes(`:${findingId} -->`));
          if (t) await resolveReviewThreads(centralOctokit, [t.threadId]);
        } catch (e) { console.log(`resolve thread pulado: ${(e as Error).message}`); }
      },
      reply: async (body) => { await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body }); },
      fileProvider: (file) => getFileAtRef(contentClient, target, file, headSha).then((c) => c ?? ''),
      run: realChatRunner,
      createFeedbackIssue: async (issue) => {
        const [fbOwner = 'freeflowsoftware', fbRepo = 'movvia-ai-review'] = cfg.feedbackRepo.split('/');
        // state:'all' (nao 'open'): uma issue ja FECHADA (triada) do mesmo findingId ainda
        // conta como existente — evita reabrir duplicata a cada re-dismiss.
        const existentes = (await centralOctokit.issues.listForRepo({ owner: fbOwner, repo: fbRepo, state: 'all', labels: 'dismiss-feedback', per_page: 100 })).data;
        const jaExiste = existentes.find((i) => (i.body ?? '').includes(feedbackIssueMarker(issue.findingId)));
        if (jaExiste) return jaExiste.html_url;
        const criada = await centralOctokit.issues.create({ owner: fbOwner, repo: fbRepo, title: issue.title, body: issue.body, labels: issue.labels });
        return criada.data.html_url;
      },
    };
  }
}
