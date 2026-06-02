import { describe, it, expect } from 'vitest';
import { resolveOctokitAuth, approveBestEffort, postReview, type GithubCredentials, type ReviewClient, type ReviewEvent, type ReviewPoster, type ReviewInlineComment } from '../lib/github.js';

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
