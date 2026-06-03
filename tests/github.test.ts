import { describe, it, expect } from 'vitest';
import { resolveOctokitAuth, approveBestEffort, postReview, listFindingThreads, resolveReviewThreads, type GithubCredentials, type ReviewClient, type ReviewEvent, type ReviewPoster, type ReviewInlineComment, type GraphqlClient } from '../lib/github.js';

// resolveOctokitAuth e logica pura de SELECAO de auth (qual credencial usar), sem
// tocar a rede. A montagem do Octokit (I/O / borda externa) fica em createOctokit,
// que delega a esta funcao — entao testamos a decisao aqui sem stub de rede.
describe('resolveOctokitAuth', () => {
  it('prefere App auth quando appId + privateKey + installationId estao presentes', () => {
    const creds: GithubCredentials = {
      appId: '123', privateKey: '-----BEGIN-----', installationId: '456', pat: 'ghp_x',
    };
    const auth = resolveOctokitAuth(creds);
    expect(auth.kind).toBe('app');
    if (auth.kind !== 'app') throw new Error('esperado app');
    expect(auth.options.appId).toBe(123);
    expect(auth.options.installationId).toBe(456);
  });

  it('cai para PAT quando faltam credenciais do App', () => {
    const auth = resolveOctokitAuth({ pat: 'ghp_only' });
    expect(auth.kind).toBe('pat');
    if (auth.kind !== 'pat') throw new Error('esperado pat');
    expect(auth.token).toBe('ghp_only');
  });

  it('lanca erro claro quando nenhuma credencial valida foi fornecida', () => {
    // Antes o codigo montava `new Octokit({ auth: undefined })` em silencio e so
    // falhava em runtime com 401/403 no primeiro request. Falhar cedo e explicito.
    expect(() => resolveOctokitAuth({})).toThrow(/REVIEW_APP_ID.*REVIEW_PAT|credencial/i);
  });
});

// Fake nomeado da borda externa (pulls.createReview): nao toca a rede. O App do
// bot nao consegue aprovar o proprio PR de teste (422), entao o APPROVE formal sai
// pelo PAT do Pablo e e best-effort — uma falha 422 em self-PR nao pode derrubar o post.
class FakeReviewClient implements ReviewClient {
  public chamadas: Array<{ event: ReviewEvent }> = [];
  constructor(private readonly erro?: Error) {}
  pulls = {
    createReview: async (params: { event: ReviewEvent }): Promise<void> => {
      if (this.erro) throw this.erro;
      this.chamadas.push({ event: params.event });
    },
  };
}

// Fake nomeado da borda externa (pulls.createReview com inline comments): captura
// os parametros para asserir que postReview agrupa resumo + inline numa unica review.
class FakeReviewPoster implements ReviewPoster {
  public ultimaChamada?: {
    commit_id: string;
    event: ReviewEvent;
    body: string;
    comments: ReviewInlineComment[];
  };
  pulls = {
    createReview: async (params: {
      commit_id: string;
      event: ReviewEvent;
      body: string;
      comments: ReviewInlineComment[];
    }): Promise<void> => {
      this.ultimaChamada = params;
    },
  };
}

describe('postReview', () => {
  it('agrupa resumo (body) + inline comments numa unica review ancorada no sha', async () => {
    const fake = new FakeReviewPoster();
    const inline: ReviewInlineComment[] = [{ path: 'a.ts', line: 12, body: 'corpo' }];
    await postReview(fake, { owner: 'o', repo: 'r', prNumber: 7 }, 'abc1234', 'REQUEST_CHANGES', 'resumo', inline);
    expect(fake.ultimaChamada?.commit_id).toBe('abc1234');
    expect(fake.ultimaChamada?.event).toBe('REQUEST_CHANGES');
    expect(fake.ultimaChamada?.body).toBe('resumo');
    expect(fake.ultimaChamada?.comments).toEqual(inline);
  });
});

describe('approveBestEffort', () => {
  it('encaminha o event do veredicto para createReview', async () => {
    const fake = new FakeReviewClient();
    await approveBestEffort(fake, { owner: 'o', repo: 'r', prNumber: 7 }, 'APPROVE');
    expect(fake.chamadas).toEqual([{ event: 'APPROVE' }]);
  });

  it('engole erro do GitHub (ex: 422 em self-PR) sem propagar', async () => {
    const fake = new FakeReviewClient(new Error('Review cannot be requested by author (422)'));
    await expect(
      approveBestEffort(fake, { owner: 'o', repo: 'r', prNumber: 7 }, 'APPROVE'),
    ).resolves.toBeUndefined();
  });
});

// Fake nomeado da borda GraphQL (Octokit.graphql): nao toca a rede. Devolve um
// payload de reviewThreads pre-montado para a query e captura os ids resolvidos
// para a mutation; opcionalmente falha em um threadId especifico (testa allSettled).
class FakeGraphqlClient implements GraphqlClient {
  public threadIdsResolvidos: string[] = [];
  constructor(
    private readonly threadsPayload: ReviewThreadNode[] = [],
    private readonly threadIdQueFalha?: string,
  ) {}

  graphql<T = unknown>(query: string, vars: Record<string, unknown>): Promise<T> {
    if (query.includes('reviewThreads')) {
      const payload = {
        repository: { pullRequest: { reviewThreads: { nodes: this.threadsPayload } } },
      };
      return Promise.resolve(payload as T);
    }
    const threadId = vars.threadId as string;
    this.threadIdsResolvidos.push(threadId);
    if (threadId === this.threadIdQueFalha) {
      return Promise.reject(new Error(`thread ${threadId} ja apagada (mutation falhou)`));
    }
    return Promise.resolve({} as T);
  }
}

interface ReviewThreadNode {
  id: string;
  isResolved: boolean;
  // path do arquivo onde a thread ancorou — alimenta o re-review por delta.
  path: string;
  comments: { nodes: Array<{ body: string }> };
}

// Helper: monta um node de review thread com o body do 1o comentario.
// path default 'a.ts' cobre os casos que nao se importam com o arquivo.
function makeThread(id: string, isResolved: boolean, primeiroBody: string, path = 'a.ts'): ReviewThreadNode {
  return { id, isResolved, path, comments: { nodes: [{ body: primeiroBody }] } };
}

const target = { owner: 'o', repo: 'r', prNumber: 7 };
const MARKER_NOSSO = '<!-- movvia-ai-review:seguranca:abc123def456 -->';

describe('listFindingThreads', () => {
  it('parseia { marker, threadId, path } das threads NOSSAS nao resolvidas', async () => {
    const corpoComMarker = `**P0** — Token hardcoded\n\nrationale\n\n${MARKER_NOSSO}`;
    const gql = new FakeGraphqlClient([makeThread('T1', false, corpoComMarker, 'conta.service.ts')]);
    const threads = await listFindingThreads(gql, target);
    expect(threads).toEqual([{ marker: MARKER_NOSSO, threadId: 'T1', path: 'conta.service.ts' }]);
  });

  it('descarta threads ja resolvidas (nao voltam para o ciclo de dedup)', async () => {
    const gql = new FakeGraphqlClient([makeThread('T2', true, `corpo\n${MARKER_NOSSO}`)]);
    expect(await listFindingThreads(gql, target)).toEqual([]);
  });

  it('descarta threads sem o nosso marker (comentario de humano / outro bot)', async () => {
    const gql = new FakeGraphqlClient([makeThread('T3', false, 'comentario solto de um dev')]);
    expect(await listFindingThreads(gql, target)).toEqual([]);
  });

  it('mistura: retorna so a thread nossa nao resolvida entre varias', async () => {
    const gql = new FakeGraphqlClient([
      makeThread('T1', false, `${MARKER_NOSSO}`, 'mexido.ts'),
      makeThread('T2', true, `resolvida\n${MARKER_NOSSO}`),
      makeThread('T3', false, 'sem marker'),
    ]);
    const threads = await listFindingThreads(gql, target);
    expect(threads).toEqual([{ marker: MARKER_NOSSO, threadId: 'T1', path: 'mexido.ts' }]);
  });
});

describe('resolveReviewThreads', () => {
  it('chama a mutation resolveReviewThread por threadId', async () => {
    const gql = new FakeGraphqlClient();
    await resolveReviewThreads(gql, ['T1', 'T2']);
    expect(gql.threadIdsResolvidos).toEqual(['T1', 'T2']);
  });

  it('uma mutation que falha NAO derruba as outras (Promise.allSettled)', async () => {
    // Thread apagada / sem permissao -> uma falha nao pode parar o ciclo de re-review.
    const gql = new FakeGraphqlClient([], 'T_FALHA');
    await expect(resolveReviewThreads(gql, ['T1', 'T_FALHA', 'T3'])).resolves.toBeUndefined();
    expect(gql.threadIdsResolvidos).toEqual(['T1', 'T_FALHA', 'T3']);
  });

  it('lista vazia e no-op (nada a resolver)', async () => {
    const gql = new FakeGraphqlClient();
    await resolveReviewThreads(gql, []);
    expect(gql.threadIdsResolvidos).toEqual([]);
  });
});
