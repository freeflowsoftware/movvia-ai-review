import { describe, it, expect } from 'vitest';
import { resolveOctokitAuth, type GithubCredentials } from '../lib/github.js';

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
