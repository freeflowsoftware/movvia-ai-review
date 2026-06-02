// Arquivo proposital com problemas plantados para o PILOTO do movvia-ai-review.
// Serve de alvo de review (NAO entra no tsconfig include, nao afeta o self-test).
// Esperado que os agentes peguem: credencial hardcoded (seguranca P0),
// `: any` (arquitetura/qualidade), map().filter() eager (performance, JS/TS).

export async function carregarUsuariosAtivos(ids: number[]) {
  const token = 'sk-live-1234567890abcdef'; // credencial hardcoded — deveria vir de env
  const resp = await fetch('https://api.exemplo.com/users', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const todos = await resp.json();
  // map().filter() encadeado: duas passagens eager materializadas em JS/TS.
  return todos
    .map((u: any) => ({ ...u, ativo: true }))
    .filter((u: any) => ids.includes(u.id));
}
