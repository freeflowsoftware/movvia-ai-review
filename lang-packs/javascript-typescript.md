# Convencoes JavaScript / TypeScript

- `arr.map().filter().reduce()` encadeados sao EAGER: cada chamada materializa um novo array e percorre a colecao inteira. N operacoes encadeadas = N passagens. Em hot path com arrays grandes, considere um unico `reduce`/`for`.
- `await` dentro de `for` sequencializa I/O; use `Promise.all` quando as iteracoes sao independentes.
- Evite `: any` em codigo de producao; sem `console.log` (use Logger).
- Decimais financeiros: nunca `Number(decimal)`; manter Decimal.
- `$transaction` (Prisma) sempre com timeout explicito.
