import { Octokit } from '@octokit/rest';
import { createAppAuth } from '@octokit/auth-app';

export interface PostTarget { owner: string; repo: string; prNumber: number; }

/** Credenciais cruas vindas das env vars do job `post` do workflow. */
export interface GithubCredentials {
  appId?: string;
  privateKey?: string;
  installationId?: string;
  pat?: string;
}

/** App auth (mintar installation token) tem prioridade; PAT e fallback. */
export type OctokitAuth =
  | { kind: 'app'; options: { appId: number; privateKey: string; installationId: number } }
  | { kind: 'pat'; token: string };

/**
 * Decide qual credencial usar SEM tocar a rede. O workflow declara REVIEW_APP_ID /
 * REVIEW_APP_PRIVATE_KEY como required e REVIEW_PAT como optional; logo o caminho
 * primario e o GitHub App. Falha cedo e explicito quando nada e fornecido — antes
 * o codigo montava `new Octokit({ auth: undefined })` e so quebrava com 401/403 no
 * primeiro request (checks:write / pull-requests:write).
 */
export function resolveOctokitAuth(creds: GithubCredentials): OctokitAuth {
  const { appId, privateKey, installationId, pat } = creds;
  if (appId && privateKey && installationId) {
    return {
      kind: 'app',
      options: { appId: Number(appId), privateKey, installationId: Number(installationId) },
    };
  }
  if (pat) return { kind: 'pat', token: pat };
  throw new Error(
    'Credenciais do GitHub ausentes: defina REVIEW_APP_ID + REVIEW_APP_PRIVATE_KEY ' +
      '(+ REVIEW_INSTALLATION_ID) ou REVIEW_PAT.',
  );
}

/** Borda externa: monta o Octokit autenticado a partir das credenciais resolvidas. */
export function createOctokit(creds: GithubCredentials): Octokit {
  const auth = resolveOctokitAuth(creds);
  if (auth.kind === 'app') {
    return new Octokit({ authStrategy: createAppAuth, auth: auth.options });
  }
  return new Octokit({ auth: auth.token });
}

/** Evento aceito por pulls.createReview no fluxo de veredicto (subset do union do Octokit). */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES';

/** Subconjunto do Octokit que approveBestEffort consome (permite fake nos testes). */
export interface ReviewClient {
  pulls: { createReview(params: { owner: string; repo: string; pull_number: number; event: ReviewEvent }): Promise<unknown> };
}

/**
 * Posta o APPROVE/REQUEST_CHANGES formal via PAT — best-effort.
 *
 * O check run `review-bot/verdict` (via App) e quem trava o merge no Ruleset; o
 * review formal e so cortesia na UI. O App nao pode aprovar o proprio PR de teste
 * (GitHub responde 422 "author"), entao engolimos o erro: uma falha aqui nao pode
 * derrubar o post que ja emitiu o check run e o comentario.
 */
export async function approveBestEffort(
  client: ReviewClient,
  t: PostTarget,
  event: ReviewEvent,
): Promise<void> {
  try {
    await client.pulls.createReview({ owner: t.owner, repo: t.repo, pull_number: t.prNumber, event });
  } catch (e) {
    console.log(`Approve via PAT pulado: ${(e as Error).message}`);
  }
}

/** Um comentario inline ancorado em path + linha do diff (corpo ja montado). */
export interface ReviewInlineComment {
  path: string;
  line: number;
  body: string;
}

/** Subconjunto do Octokit que postReview consome (permite fake nomeado nos testes). */
export interface ReviewPoster {
  pulls: {
    createReview(params: {
      owner: string;
      repo: string;
      pull_number: number;
      commit_id: string;
      event: ReviewEvent;
      body: string;
      comments: ReviewInlineComment[];
    }): Promise<unknown>;
  };
}

/**
 * Borda externa: posta UMA review formal carregando o resumo (body) + os
 * comentarios inline ancorados na linha. Diferencial do prototipo /revisar-pr.
 *
 * Um unico createReview agrupa todos os inline numa thread de review (em vez de N
 * createReviewComment soltos), e o `event` (APPROVE/REQUEST_CHANGES) carrega o
 * veredicto junto. commit_id fixa as ancoras no SHA exato revisado.
 */
export async function postReview(
  poster: ReviewPoster,
  t: PostTarget,
  sha: string,
  event: ReviewEvent,
  summaryBody: string,
  inlineComments: ReviewInlineComment[],
): Promise<void> {
  await poster.pulls.createReview({
    owner: t.owner,
    repo: t.repo,
    pull_number: t.prNumber,
    commit_id: sha,
    event,
    body: summaryBody,
    comments: inlineComments,
  });
}

/** Cria um check run review-bot/verdict. Borda externa: nao coberto por unit test. */
export async function emitCheckRun(
  octokit: Octokit,
  t: PostTarget,
  headSha: string,
  conclusion: 'success' | 'failure',
  summary: string,
): Promise<void> {
  await octokit.checks.create({
    owner: t.owner,
    repo: t.repo,
    name: 'review-bot/verdict',
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output: { title: 'movvia-ai-review', summary },
  });
}
