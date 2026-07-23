# Plano — PED-2728: dismiss de finding por comando + issue de feedback

> Brainstorm superpowers, 2026-07-22. Refina e implementa a história PED-2728
> (candidato #18 da auditoria) com o escopo adicional pedido pelo Antonio.

## Contexto

O `movvia-ai-review` trava o merge via o check run `review-bot/verdict` sempre que
sobra qualquer P0/P1 vivo (`decideVerdict`, `lib/gatekeeper.ts:307`). Quando o finding
que bloqueia é **falso-positivo**, hoje só há três saídas: corrigir código, convencer o
judge (LLM) com evidência verificável numa reply inline, ou editar à mão o JSON do
comentário de withdrawals. Falta uma via **explícita, autorizada, determinística e
auditável** para um humano declarar "isto é falso-positivo, libere".

O gancho de desbloqueio já existe: o `post.ts:316-342` lê o store de withdrawals,
suprime os findings dispensados por `findingId` e **recomputa** o verdict, re-emitindo o
check. Só falta a via de entrada por comando — e, no refinamento de 2026-07-22, dois
requisitos novos: (1) **argumentação obrigatória** no dismiss e (2) **abrir uma issue de
feedback** no próprio movvia-ai-review a cada dismiss, para fechar o loop de calibração.

## Decisões do brainstorm (2026-07-22)

1. **P0**: dispensável **só por CODEOWNER**, com ADR (`ADR-002`, status Proposta até o
   Pablo aceitar) e flag `dismiss.allow_p0_by_codeowner` (default `false`).
2. **Issue de feedback**: aberta em **todo** dismiss.
3. **Corpo da issue**: redigido por **LLM** (best-effort), separado do write determinístico.
4. **Escopo da sessão**: refinar + atualizar Jira + plano + implementar.

## Arquitetura da solução

### Fluxo do comando (race-free, reusa o recompute existente)

`/ai-review dismiss <findingId> <motivo>` chega como `issue_comment` top-level. Como já
casa com `startsWith('/ai-review')`, evitamos double-trigger assim:

- **Caller** (`pr-review.yml` + `caller-template.yml`): novo job `dismiss` que dispara o
  reusable com `event: dismiss` + `comment_id`, sob o **mesmo** `author_association`
  allowlist. O job `call` (pipeline) ganha `&& !startsWith(body,'/ai-review dismiss') &&
  !startsWith(body,'/ai-review undismiss')` para não rodar em duplicidade.
- **Reusable** (`ai-review.yml`): `event: dismiss` roda o pipeline completo (os jobs
  `if: inputs.event != 'review_comment'` já cobrem `dismiss`). No job `post`, **antes** do
  `lib/post.ts`, roda um passo `if: inputs.event == 'dismiss'` que executa `lib/dismiss.ts`.
  Sequencial no mesmo job → sem corrida no read-modify-write do store. O `post.ts` então
  relê o store atualizado, suprime e recomputa o verdict, re-emitindo `review-bot/verdict`.

Trade-off consciente: re-roda os agentes (custo/LLM + findings não-determinísticos). É o
caminho de **máxima corretude e mínimo código novo** (o recompute autoritativo é o do
pipeline). Otimização futura: persistir o último `verdict.json` num comentário e recomputar
sem re-rodar agentes.

### `lib/dismiss.ts` (novo) — núcleo puro + bordas injetadas (padrão do judge)

Puro (testável sem rede):

- `parseDismissCommand(body)`: reconhece `/ai-review dismiss <findingId|marker> <motivo>` e
  `/ai-review undismiss <findingId|marker>`. Retorna união discriminada
  `{kind:'dismiss', findingId, motivo}` | `{kind:'undismiss', findingId}` |
  `{kind:'invalid', reason}` | `null` (não é comando de dismiss). Extrai o `findingId` de 12
  hex ou de um marker colado. **Motivo obrigatório**: vazio/curto → `invalid`.
- `decideDismiss(severity, isCodeowner, allowP0Policy)`: gate de política. P0 → `write` só
  se `allowP0Policy && isCodeowner`, senão `reject`. P1/P2 → `write`. Espelha `decideJudge`.

Bordas (`DismissDeps`, injetadas): `fetchComment`, `findFindingById` (lookup do inline pelo
marker → severity/title/rationale/file/agent via `parseInlineBody`), `isCodeowner`,
`readWithdrawals`/`writeWithdrawals`, `resolveThread`/`reply`, `fileProvider`,
`openFeedbackIssue`, `run` (LLM), `now`, `headSha`.

`dismissRun(input, deps, cfg)`:
1. `parseDismissCommand` → se `invalid`, reply de uso; se `null`, no-op.
2. `findFindingById` (lookup do inline). Sem finding → reply "não encontrei esse findingId".
3. Se P0: `isCodeowner(file, author)`; `decideDismiss`. `reject` → reply e para.
4. `undismiss`: remove do store e reply. `dismiss`: `upsertDismissal` com `motivo`.
5. **Write do store PRIMEIRO** (durável) → resolve a thread → reply de auditoria.
6. **Depois**, best-effort em try/catch: `openFeedbackIssue` (issue no movvia-ai-review).

### `lib/withdrawals.ts` (alterado)

- `Withdrawal.motivo?: string` (opcional — o judge não preenche).
- Extrai `upsertByFindingId` interno; `upsertWithdrawal` continua **rejeitando P0**
  (caminho do judge, guarda inviolável); nova `upsertDismissal(list, entry, allowP0)`
  aceita P0 só quando `allowP0`.

### `lib/codeowners.ts` (novo)

- `parseCodeowners(text)`: linhas → `{pattern, owners[]}`.
- `ownersFor(rules, file)`: última regra que casa (semântica CODEOWNERS), via `minimatch`.
- CLI/borda resolve `isCodeowner` fail-closed: match direto de `@login`; time `@org/team`
  via API best-effort; erro/indeterminado → `false`.

### `lib/post.ts` (alterado)

`buildInlineBody` ganha uma linha com o comando pronto para copiar:
`` `/ai-review dismiss <findingId> <motivo>` `` (o `findingId` vem do `findingMarker`).

### Issue de feedback

`openFeedbackIssue` cria em `freeflowsoftware/movvia-ai-review` via octokit dedicado
(App/`AI_REVIEW_REPO_TOKEN`). Título `dismiss falso-positivo: <agente>/<categoria> — <arquivo>`,
labels `dismiss-feedback`, `false-positive`, corpo LLM (análise + como corrigir) com fallback
template, marker de idempotência `<!-- movvia-ai-review:dismiss-feedback:<findingId> -->`.
Interface fina `IssueOpener { issues: { create(...); listForRepo(...) } }` + fake nomeado.

### `config/defaults.yml`

```yaml
dismiss:
  allow_p0_by_codeowner: false   # ADR-002 Aceito flippa para true
  min_motivo_len: 15
  feedback_repo: "freeflowsoftware/movvia-ai-review"
  feedback_model: "deepseek/deepseek-v4-flash"
```

## Invariantes de segurança (não violar)

- `upsertWithdrawal` do judge segue rejeitando P0.
- P0 por comando: só CODEOWNER **E** flag on **E** ADR-002 Aceito. Default bloqueado.
- Fork guard `author_association` intacto em todos os branches novos.
- Write do store antes do side-effect externo (issue); issue em try/catch.
- Fail-closed no CODEOWNER e no lookup do finding.

## Verificação

- `npx vitest run` (todos verdes). Novos: `tests/dismiss.test.ts`,
  `tests/codeowners.test.ts`; extensões em `tests/withdrawals.test.ts` (motivo +
  upsertDismissal) e `tests/workflow-yaml.test.ts` (job/step dismiss + guard).
- Casos-chave: motivo ausente → no-op+reply; P1 autorizado → store+resolve+reply+issue;
  P0 sem CODEOWNER → reject; P0 CODEOWNER com flag off → reject; undismiss → remove;
  issue idempotente por findingId; write do store sobrevive a falha na issue.
- Bump semver no `package.json` (MINOR: feature retrocompatível) no PR.

## Pendências humanas

- **ADR-002 → Aceita** pelo Pablo antes de habilitar P0 em produção (flag).
- Confirmar labels/repo da issue de feedback e o modelo LLM do corpo.
