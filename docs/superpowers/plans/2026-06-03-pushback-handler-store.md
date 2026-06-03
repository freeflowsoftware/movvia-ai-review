# Pushback Handler + Store de Withdrawals — Plano de Implementação

> **Para workers agênticos:** TDD task-a-task. Teste primeiro (RED) → implementação (GREEN) → `npx vitest run`.

**Goal:** quando o dev RESPONDE (pushback textual) a um comentário inline, um trigger avalia se o argumento procede contra o código. Válido → concorda, fecha a thread (P1/P2) e registra no store para o pipeline não re-postar. Inválido → explica por quê e mantém aberto. **P0 nunca fecha por argumento** (só reply; fecha por correção real ou CODEOWNER).

**Decisão Pablo (2026-06-03):** judge fecha P1/P2 por pushback válido (via store de withdrawals); NUNCA P0.

> ⚠️ **A Fase 0 do plano original do workflow foi DESCARTADA.** O crítico alucinou que o repo não tinha inline/threads/`findingId`-no-marker/idempotência e mandou "reconstruí-los". **Tudo já existe e foi verificado:** `findingMarker` carrega `findingId` (post.ts:34); `postReview` posta inline + cria threads (github.ts:126); `summaryRefFromComments` faz o post idempotente (post.ts); `listFindingThreads`/`changedFilesSince` existem; `LINE_BUCKET=5` (não /3). Versão atual após a Feature #1: **0.7.0**.

**Arquitetura:** novo job `judge-pushback` no reusable (caminho paralelo ao pipeline, isolado por `if: inputs.event=='review_comment'`), trigger `pull_request_review_comment[created]` no caller, modelo de raciocínio (deepseek-v4-flash). Store de withdrawals em comentário-estado top-level (marker `<!-- movvia-ai-review:withdrawals -->`, espelha o summary). Supressão por `findingId` EXATO (não proximidade — `findingId` inclui `category`, então `cred` withdrawn não suprime `perf` na mesma linha). Invalidação por arquivo: se o arquivo mudar entre `acceptedSha` e o head, o withdrawal expira.

---

## Fase 1 — Store de Withdrawals

### Task 1 — `lib/withdrawals.ts` (puro, serialização)
- [ ] Teste primeiro (`tests/withdrawals.test.ts`): (1) `withdrawalsMarker` = `<!-- movvia-ai-review:withdrawals -->`; (2) `parseWithdrawals` extrai o array do fenced JSON sob o marker (espelha `parseSummarySha` post.ts:20-22); (3) `parseWithdrawals` → `[]` em JSON quebrado/ausente (**FAIL-SAFE: na dúvida NÃO suprime** — nunca derruba o job); (4) `buildWithdrawalsComment` serializa marker + ```` ```json {withdrawals:[...]} ``` ````; (5) `upsertWithdrawal` por `findingId` (atualiza `acceptedSha`/`acceptedAt`, NÃO empilha); (6) `upsertWithdrawal` REJEITA severity P0 (no-op/lança) — **store nunca contém P0**. Entry: `{findingId, severity, acceptedSha, acceptedAt, acceptedBy, category, file}`. Sem mock.

### Task 2 — `suppressByWithdrawals` (puro, por `findingId` exato)
- [ ] `suppressByWithdrawals(findings, withdrawn: Set<string>)` = `findings.filter(f => !withdrawn.has(findingId(f)))`. Teste: (1) suprime finding cujo `findingId` está no Set; (2) **NÃO suprime category DIFERENTE** no mesmo arquivo/região (`cred` withdrawn na linha 10, `perf` na 10 sobrevive — `findingId` inclui `category`); (3) MESMA category cruzando fronteira do bucket `/5` (deslocamento ≥5) gera `findingId` novo e re-aparece (documentar trade-off, igual gatekeeper.ts:19-28). Plugar no CLI do post ANTES de `reconcileInline`/`buildInlineComments` (suprime do array `findings`).

### Task 3 — `computeValidWithdrawals` (puro, invalidação por arquivo)
- [ ] Cada entry guarda `acceptedSha`. `computeValidWithdrawals(entries, deltaProvider)` onde `deltaProvider:(file, acceptedSha)=>boolean` (true = arquivo mudou desde o acceptedSha → EXPIRA). Teste: (1) válido (arquivo NÃO no delta) → `findingId` no Set, entry sobrevive; (2) expira (arquivo no delta) → fora do Set + entry removida do store re-escrito; (3) usa `acceptedSha` de CADA entry (não um `previousSha` global) — entries com SHAs distintos + deltas distintos por SHA. No CLI, `deltaProvider` = closure sobre `changedFilesSince` (github.ts:306) por `acceptedSha`.

### Task 4 — Integrar store no job `post` (leitor + invalidador)
- [ ] Extrair a lógica do bloco CLI de post.ts para `postRun(deps)` testável (o `if (process.argv...)` só monta deps reais). Teste de integração leve com bordas fakeadas (`FakeIssueComments`, `FakeGraphql`, `deltaProviderFake`): (1) lê withdrawals via `findWithdrawalsComment` (espelha `findExistingSummaryRef` post.ts:237-243), computa válidos por entry, monta Set, suprime, RE-ESCREVE o comentário via upsert (id reusado); (2) re-run no mesmo SHA sem pushback → delta vazio, nada expira, re-escreve idêntico; (3) store corrompido → `parseWithdrawals=[]` → nada suprime → job NÃO derruba.

## Fase 2 — Judge core

### Task 5 — `lib/judge.ts`: `decideJudge` (puro, GUARDA P0)
- [ ] Teste primeiro (`tests/judge.test.ts`): (1) severity P0 → **early-return `action=REPLY_ONLY`, NUNCA WITHDRAW** mesmo com argumento válido (decisão Pablo); (2) P1/P2 + veredicto LLM válido (com `evidenceCite`) → `action=WITHDRAW`; (3) P1/P2 + inválido → `action=REPLY` (refuta); (4) veredicto ambíguo/erro de parse → `action=REPLY` (**fail-closed: na dúvida NÃO fecha**); (5) `parseJudgeVerdict(raw)` → `{valid, evidenceCite, reason}` tolerante. LLM injetado como `JudgeRunner=(prompt)=>Promise<string>`. `judgeRunnerFake` retorna raw fixo.

### Task 6 — `shouldJudge` (puro, anti-loop + circuit-breaker)
- [ ] Teste: (1) ignora comentário cujo `author.login == BOT_LOGIN` (anti-loop por identidade — não reage ao próprio reply); (2) ignora se a thread já tem `>= JUDGE_MAX_REPLIES` replies do bot (circuit-breaker); (3) ignora se não é reply a thread NOSSA (root sem marker); (4) aceita pushback humano novo em thread nossa abaixo do cap. `shouldJudge(thread, comment, {botLogin, maxReplies})`. Debounce 60-120s é do workflow (concurrency + sleep), não do core.

### Task 7 — `judgeRun` (orquestrador, dossiê determinístico)
- [ ] `judgeRun(deps)` reusa `listFindingThreads`/`replyToReviewThread`/`resolveReviewThread` (já existem após Feature #1 Task 5) + `upsertWithdrawal`. Teste (integração leve, bordas fakeadas): (1) pushback válido P1 → `resolveReviewThread` + upsert (acceptedSha=head, acceptedBy=comment.author, severity≠P0) + reply de confirmação; (2) pushback P0 → reply only, NENHUM resolve, NENHUM upsert; (3) pushback inválido P2 → reply refutando, thread viva, sem upsert; (4) `shouldJudge=false` → no-op. DOSSIÊ: monta do root (nodes[0], `parseInlineBody` → severity/title/rationale) + comments seguintes (pushback do dev) — zero dependência do array de Findings. **Prompt do judge tão rigoroso quanto o refuter:** exigir `evidenceCite` verificável (cite-the-line), senão o dev fecha P1 com argumento fraco.

## Fase 3 — Wiring (YAML)

### Task 8 — `config/defaults.yml`
- [ ] `judge: { model: deepseek/deepseek-v4-flash, max_replies: 3, debounce_seconds: 90, bot_login: 'movvia-ai-review[bot]' }`.

### Task 9 — Reusable + caller + concurrency
- [ ] **Reusable (`ai-review.yml`):** novos inputs `event` (default `pull_request`), `thread_node_id`, `comment_id` (required:false). Novo job `judge-pushback` (`if: inputs.event=='review_comment'`): checkout central@v1 + setup-node + pnpm + `npx tsx lib/judge.ts` com env `REVIEW_APP_*`/`REVIEW_PAT` (resolve/reply EXIGE App ou PAT — GITHUB_TOKEN não resolve), `LLM_*`, `JUDGE_MODEL`, `BOT_LOGIN`, `JUDGE_MAX_REPLIES`, `THREAD_NODE_ID`, `COMMENT_ID`. Jobs do pipeline ganham `if: inputs.event != 'review_comment'`. **CONCURRENCY COMPARTILHADO** (group sem o event): `group: ai-review-${{ github.repository }}-${{ inputs.pr_number }}`, `cancel-in-progress: false` (serializa pipeline×judge, não perde julgamento). Primeiro step do judge: `sleep ${{ JUDGE_DEBOUNCE_SECONDS }}` (coalesce rajadas).
- [ ] **Caller (`caller-template.yml`):** trigger `pull_request_review_comment: { types: [created] }`; novo job `judge` (`if: github.event_name=='pull_request_review_comment'`) chamando o reusable com `event:'review_comment'`, `thread_node_id: github.event.comment.node_id`, `comment_id: github.event.comment.id`. Job `call` existente guardado para NÃO disparar em review_comment.
- [ ] **NOTA:** `pull_request_review_comment` não dispara em fork sem secrets — documentar. `tests/workflow-yaml.test.ts`: asserts do novo job + concurrency compartilhado + triggers.

### Task 10 — Semver + E2E
- [ ] `package.json` 0.7.0 → **0.8.0**. E2E (repo precisa estar PUSHADO em freeflowsoftware com `@v1`): cenários do plano — supressão+store, invalidação, guarda P0, anti-loop+circuit-breaker, concorrência (serialização), fail-safe do store corrompido.

---

## Riscos conhecidos
- **Corrida store×pipeline:** mitigada por concurrency group COMPARTILHADO (sem o event) + read-modify-write sempre re-lendo o corpo antes do upsert. GitHub não tem CAS no updateComment. Validar empiricamente.
- **AUTH:** `resolveReviewThread`/reply exigem App OU REVIEW_PAT (GITHUB_TOKEN nativo não resolve). Confirmar permissão do App antes do E2E.
- **DeepSeek custo/idioma:** debounce + circuit-breaker obrigatórios; prompt PT-BR explícito + parse tolerante (ambíguo=REPLY, nunca WITHDRAW).
- **Granularidade:** supressão por `findingId` exato (protege category diferente); bucket `/5` → MESMA category deslocada ≥5 linhas re-aparece (aceito). Invalidação por arquivo (conservador: expira cedo).
- **Pré-condição E2E:** repo movvia-ai-review precisa estar pushado em freeflowsoftware (hoje local). Sem push, o reusable `@v1` não resolve em PR real.
