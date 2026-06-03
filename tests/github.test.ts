import { describe, it, expect } from 'vitest';
import { resolveOctokitAuth, approveBestEffort, postReview, listFindingThreads, resolveReviewThreads, changedFilesSince, type GithubCredentials, type ReviewClient, type ReviewEvent, type ReviewPoster, type ReviewInlineComment, type GraphqlClient, type CompareClient } from '../lib/github.js';

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

// Fake nomeado da borda externa: captura reviews e inline individuais. `failBatch`
// simula o 422 "Line could not be resolved" do createReview em lote (inline invalido).
class FakeReviewPoster implements ReviewPoster {
  public reviews: Array<{ commit_id: string; event: ReviewEvent; body: string; comments: ReviewInlineComment[] }> = [];
  public inlineComments: Array<{ path: string; line: number; body: string }> = [];
  constructor(private readonly failBatch = false) {}
  pulls = {
    createReview: async (params: {
      commit_id: string;
      event: ReviewEvent;
      body: string;
      comments: ReviewInlineComment[];
    }): Promise<void> => {
      if (this.failBatch && params.comments.length > 0) {
        throw new Error('Unprocessable Entity: "Line could not be resolved"');
      }
      this.reviews.push(params);
    },
    createReviewComment: async (params: { path: string; line: number; body: string }): Promise<void> => {
      this.inlineComments.push({ path: params.path, line: params.line, body: params.body });
    },
  };
}

describe('postReview', () => {
  it('agrupa resumo (body) + inline comments numa unica review ancorada no sha', async () => {
    const fake = new FakeReviewPoster();
    const inline: ReviewInlineComment[] = [{ path: 'a.ts', line: 12, body: 'corpo' }];
    await postReview(fake, { owner: 'o', repo: 'r', prNumber: 7 }, 'abc1234', 'REQUEST_CHANGES', 'resumo', inline);
    expect(fake.reviews).toHaveLength(1);
    expect(fake.reviews[0]!.commit_id).toBe('abc1234');
    expect(fake.reviews[0]!.event).toBe('REQUEST_CHANGES');
    expect(fake.reviews[0]!.comments).toEqual(inline);
    expect(fake.inlineComments).toHaveLength(0);
  });

  it('fallback: se a review em lote falha (422), posta resumo sem inline + cada inline individual', async () => {
    const fake = new FakeReviewPoster(true); // failBatch
    const inline: ReviewInlineComment[] = [
      { path: 'a.ts', line: 12, body: 'c1' },
      { path: 'b.ts', line: 5, body: 'c2' },
    ];
    await postReview(fake, { owner: 'o', repo: 'r', prNumber: 7 }, 'sha', 'COMMENT', 'resumo', inline);
    // 1 review do resumo SEM inline (comments vazio) — garante check/veredicto.
    expect(fake.reviews).toHaveLength(1);
    expect(fake.reviews[0]!.comments).toEqual([]);
    // e cada inline postado individualmente.
    expect(fake.inlineComments).toEqual(inline);
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
  // line = posicao atual da thread no head (chave da reconciliacao por proximidade).
  // null quando a linha foi removida do diff -> normalizada para -1 (nunca casa).
  line: number | null;
  // isOutdated = a linha que a thread ancora mudou desde que postamos. Gate de resolve:
  // so fechamos se o dev MEXEU na linha, nunca por o modelo ter deixado de re-detectar.
  isOutdated: boolean;
  comments: { nodes: Array<{ body: string }> };
}

// Helper: monta um node de review thread com o body do 1o comentario.
// path default 'a.ts' cobre os casos que nao se importam com o arquivo.
function makeThread(id: string, isResolved: boolean, primeiroBody: string, path = 'a.ts', isOutdated = false, line: number | null = 12): ReviewThreadNode {
  return { id, isResolved, path, line, isOutdated, comments: { nodes: [{ body: primeiroBody }] } };
}

const target = { owner: 'o', repo: 'r', prNumber: 7 };
const MARKER_NOSSO = '<!-- movvia-ai-review:seguranca:abc123def456 -->';

describe('listFindingThreads', () => {
  it('parseia { marker, threadId, path, line, isOutdated } das threads NOSSAS nao resolvidas', async () => {
    const corpoComMarker = `**P0** — Token hardcoded\n\nrationale\n\n${MARKER_NOSSO}`;
    const gql = new FakeGraphqlClient([makeThread('T1', false, corpoComMarker, 'conta.service.ts', true, 42)]);
    const threads = await listFindingThreads(gql, target);
    expect(threads).toEqual([{ marker: MARKER_NOSSO, threadId: 'T1', path: 'conta.service.ts', line: 42, isOutdated: true }]);
  });

  it('line null (linha removida do diff) vira -1 -> thread fica candidata a resolver', async () => {
    const corpo = `**P0** — algo\n${MARKER_NOSSO}`;
    const gql = new FakeGraphqlClient([makeThread('T1', false, corpo, 'a.ts', true, null)]);
    const threads = await listFindingThreads(gql, target);
    expect(threads[0]!.line).toBe(-1);
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
    expect(threads).toEqual([{ marker: MARKER_NOSSO, threadId: 'T1', path: 'mexido.ts', line: 12, isOutdated: false }]);
  });
});

describe('resolveReviewThreads', () => {
  it('chama a mutation resolveReviewThread por threadId e conta as que resolveram', async () => {
    const gql = new FakeGraphqlClient();
    const resolvidas = await resolveReviewThreads(gql, ['T1', 'T2']);
    expect(gql.threadIdsResolvidos).toEqual(['T1', 'T2']);
    // O retorno e quantas REALMENTE resolveram (fulfilled), nao quantas tentou.
    expect(resolvidas).toBe(2);
  });

  it('uma mutation que falha NAO derruba as outras e conta so as que resolveram (allSettled)', async () => {
    // Thread apagada / sem permissao -> uma falha nao pode parar o ciclo de re-review.
    // O motivo real e logado por thread (nao engolido em silencio); o count exclui a falha.
    const gql = new FakeGraphqlClient([], 'T_FALHA');
    const resolvidas = await resolveReviewThreads(gql, ['T1', 'T_FALHA', 'T3']);
    expect(gql.threadIdsResolvidos).toEqual(['T1', 'T_FALHA', 'T3']);
    expect(resolvidas).toBe(2); // T1 + T3 resolveram; T_FALHA falhou
  });

  it('lista vazia e no-op (nada a resolver) -> conta 0', async () => {
    const gql = new FakeGraphqlClient();
    const resolvidas = await resolveReviewThreads(gql, []);
    expect(gql.threadIdsResolvidos).toEqual([]);
    expect(resolvidas).toBe(0);
  });
});

// Fake nomeado da borda externa (repos.compareCommitsWithBasehead): nao toca a rede.
// Captura o basehead pedido e devolve uma lista de arquivos pre-montada — alimenta o
// re-review por delta (so reconciliamos arquivos que o dev mexeu desde o ultimo review).
class FakeCompareClient implements CompareClient {
  public ultimoBasehead?: string;
  constructor(private readonly filenames: string[]) {}
  repos = {
    compareCommitsWithBasehead: async (params: { owner: string; repo: string; basehead: string }) => {
      this.ultimoBasehead = params.basehead;
      return { data: { files: this.filenames.map((filename) => ({ filename })) } };
    },
  };
}

describe('changedFilesSince', () => {
  it('compara baseSha...headSha e devolve os filenames do delta', async () => {
    const fake = new FakeCompareClient(['a.ts', 'b.ts']);
    const files = await changedFilesSince(fake, target, 'base111', 'head222');
    expect(files).toEqual(['a.ts', 'b.ts']);
    // basehead no formato "base...head" exigido pela API de compare do GitHub.
    expect(fake.ultimoBasehead).toBe('base111...head222');
  });

  it('delta vazio (nenhum arquivo mudou) -> lista vazia', async () => {
    const fake = new FakeCompareClient([]);
    expect(await changedFilesSince(fake, target, 'x', 'y')).toEqual([]);
  });
});
