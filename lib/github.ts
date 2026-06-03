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

/**
 * Evento aceito por pulls.createReview no fluxo de veredicto (subset do union do Octokit).
 * COMMENT e usado quando nao ha identidade que conte para branch protection (so
 * GITHUB_TOKEN nativo, ex: piloto sem GitHub App) — posta inline + resumo sem tentar
 * aprovar/reprovar formalmente; o veredicto real fica no check run review-bot/verdict.
 */
export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

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

/**
 * Subconjunto do Octokit que os wrappers GraphQL consomem (o Octokit expoe `.graphql`).
 * Borda externa injetada -> permite FakeGraphqlClient nomeado nos testes (nunca stub
 * inline) sem tocar a rede.
 */
export interface GraphqlClient {
  graphql<T = unknown>(query: string, vars: Record<string, unknown>): Promise<T>;
}

/** Shape minimo do payload de reviewThreads que listFindingThreads le. */
interface ReviewThreadsResponse {
  repository: {
    pullRequest: {
      reviewThreads: {
        nodes: Array<{
          id: string;
          isResolved: boolean;
          // path do arquivo onde a thread ancorou — usado pelo re-review por delta
          // (reconciliar so os arquivos que o dev mexeu, preservando os demais).
          path: string;
          comments: { nodes: Array<{ body: string }> };
        }>;
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `
  query($owner: String!, $repo: String!, $pr: Int!) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $pr) {
        reviewThreads(first: 100) {
          nodes { id isResolved path comments(first: 1) { nodes { body } } }
        }
      }
    }
  }`;

const RESOLVE_THREAD_MUTATION = `
  mutation($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) {
      thread { id isResolved }
    }
  }`;

/**
 * Casa o findingMarker invisivel cravado em buildInlineBody (post.ts). Mesmo formato
 * `<!-- movvia-ai-review:<agente>:<findingId> -->`; usado para reconhecer comentarios
 * NOSSOS entre os de humanos/outros bots na review thread.
 */
const FINDING_MARKER_PATTERN = /<!-- movvia-ai-review:[^>]+ -->/;

/**
 * Borda externa: lista as review threads NAO resolvidas do PR e extrai o par
 * { marker, threadId } so das que sao NOSSAS (1o comentario carrega o findingMarker).
 *
 * E o lado de leitura do re-review: alimenta reconcileInline com o que ja postamos
 * para decidir o que duplicar (toPost) e o que fechar (toResolveThreadIds). Filtra
 * isResolved aqui porque thread ja resolvida nao volta para o ciclo de dedup.
 */
export async function listFindingThreads(
  gql: GraphqlClient,
  t: PostTarget,
): Promise<Array<{ marker: string; threadId: string; path: string }>> {
  const data = await gql.graphql<ReviewThreadsResponse>(REVIEW_THREADS_QUERY, {
    owner: t.owner,
    repo: t.repo,
    pr: t.prNumber,
  });
  const threads = data.repository.pullRequest.reviewThreads.nodes;
  const naoResolvidas = threads.filter((thread) => !thread.isResolved);
  return naoResolvidas.flatMap(parseFindingThread);
}

/** Extrai marker + path do 1o comentario; lista vazia descarta threads sem marker nosso. */
function parseFindingThread(
  thread: { id: string; path: string; comments: { nodes: Array<{ body: string }> } },
): Array<{ marker: string; threadId: string; path: string }> {
  const primeiroComentario = thread.comments.nodes[0]?.body ?? '';
  const marker = FINDING_MARKER_PATTERN.exec(primeiroComentario)?.[0];
  if (!marker) return [];
  return [{ marker, threadId: thread.id, path: thread.path }];
}

/**
 * Borda externa: resolve (fecha) as review threads cujos findings o dev ja corrigiu.
 * Devolve quantas REALMENTE resolveram (fulfilled) — nao quantas tentou, para o log do
 * post reportar o numero verdadeiro.
 *
 * IDEMPOTENTE: resolver uma thread ja resolvida e no-op seguro no GitHub, entao re-run
 * num mesmo PR nao quebra. Promise.allSettled para que UMA mutation que falhe (ex:
 * thread apagada, permissao) nao derrube as outras — o ciclo de re-review nao deve
 * parar por causa de uma thread problematica.
 *
 * Confirmado em runtime: o GITHUB_TOKEN nativo do bot NAO resolve threads (a mutation
 * falha silenciosamente), so o PAT/App resolve. Por isso NAO engolimos o reason no
 * allSettled: logamos o erro real por thread para diagnosticar identidade/permissao.
 */
export async function resolveReviewThreads(gql: GraphqlClient, threadIds: string[]): Promise<number> {
  const resultados = await Promise.allSettled(
    threadIds.map((threadId) => resolveOneThread(gql, threadId)),
  );
  return resultados.filter((r) => r.status === 'fulfilled').length;
}

/** Resolve UMA thread, logando sucesso/erro real (nunca engolido em silencio). */
async function resolveOneThread(gql: GraphqlClient, threadId: string): Promise<void> {
  try {
    await gql.graphql(RESOLVE_THREAD_MUTATION, { threadId });
    console.log(`Thread resolvida: ${threadId}`);
  } catch (e) {
    // Propaga para o allSettled contar como rejected; o log expoe a causa (ex: token
    // sem permissao de resolver) em vez de sumir dentro do allSettled.
    console.error(`Thread NAO resolvida ${threadId}: ${(e as Error).message}`);
    throw e;
  }
}

/** Shape minimo do payload de compareCommitsWithBasehead que changedFilesSince le. */
interface CompareResponse {
  data: { files?: Array<{ filename: string }> };
}

/**
 * Subconjunto do Octokit que changedFilesSince consome (permite fake nomeado nos testes).
 * compareCommitsWithBasehead recebe basehead no formato "base...head".
 */
export interface CompareClient {
  repos: {
    compareCommitsWithBasehead(params: {
      owner: string;
      repo: string;
      basehead: string;
    }): Promise<CompareResponse>;
  };
}

/**
 * Borda externa: arquivos que mudaram entre baseSha e headSha (o delta do re-review).
 * Alimenta reconcileInline.changedFiles para reconciliar SO os arquivos tocados desde o
 * ultimo review — preservando as threads dos arquivos intocados (sem churn resolve+repost).
 */
export async function changedFilesSince(
  octokit: CompareClient,
  t: PostTarget,
  baseSha: string,
  headSha: string,
): Promise<string[]> {
  const { data } = await octokit.repos.compareCommitsWithBasehead({
    owner: t.owner,
    repo: t.repo,
    basehead: `${baseSha}...${headSha}`,
  });
  return (data.files ?? []).map((f) => f.filename);
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
