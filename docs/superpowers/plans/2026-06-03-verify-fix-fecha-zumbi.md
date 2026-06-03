# Verificador de Correção por Código (fecha-zumbi) — Plano de Implementação

> **Para workers agênticos:** executar via TDD task-a-task. Cada task: teste primeiro (RED), implementação mínima (GREEN), rodar `npx vitest run`. Steps com checkbox `- [ ]`.

**Goal:** antes de fechar uma thread, um agente lê o código no SHA atual e CONFIRMA que o problema sumiu de fato (validação real, não proxy). Ganha poder de fechar threads ZUMBI (corrigidas por inserção distante que `!isOutdated` deixa abertas), com GUARDA P0.

**Arquitetura:** gate de CONFIRMAÇÃO entre `reconcileInline` (post.ts:305) e `resolveReviewThreads` (post.ts:319). `line=-1` (linha deletada) fecha por prova mecânica sem LLM. `line>=1` → LLM lê o context-pack inteiro + exige citação-da-linha validada mecanicamente + fail-closed. **P0 nunca fecha** (vira reply ao CODEOWNER).

**Decisão Pablo (2026-06-03):** "endurece + FECHA threads zumbi". P0 zumbi → reply, nunca resolve.

**Estado verificado contra o código real (não o spec antigo):** `findingMarker` carrega `findingId` (post.ts:34); `findingId = sha1(file:lineAnchor:category).slice(0,12)` com `LINE_BUCKET=5` (gatekeeper.ts:29-40); `reconcileScope`/`reconcileInline`/`listFindingThreads`/`changedFilesSince` existem; versão atual 0.6.0.

---

## Tasks

### Task 0 — Baseline
- [ ] Branch `feat/verify-fix-fecha-zumbi` a partir de `main`. `npx vitest run` → confirmar 215 verdes em 15 arquivos. Bump NÃO entra ainda.

### Task 1 — `lib/verify-fix.ts`: `parseInlineBody` (puro)
- [ ] Teste primeiro (`tests/verify-fix.test.ts`): (a) body bem-formado de `buildInlineBody` (post.ts:149-161, formato `**P0** — titulo\n\nrationale\n\n**Sugestao:** s\n\n<marker>`) → `{severity, title, rationale, suggestion}`; (b) body sem `**Pn** —` → `null` (fail-closed #8: severidade ilegível = não-fechável); (c) round-trip: `parseInlineBody(buildInlineComments([f])[0].body)` recupera os campos do Finding. Sem mock.

### Task 2 — `parseCorrectionVerdict` (puro, fail-closed INVERTIDO)
- [ ] Espelha o molde de `parseRefuteVerdict` (gatekeeper.ts:153-166: `indexOf('{')`/`lastIndexOf('}')`/try `JSON.parse`) **mas com default invertido**. Saída `{fixed:boolean, score:number, correctionLine:number, evidence:string}`. Teste: (a) JSON válido parseia fiel; (b) sem `{`/`}` → `{fixed:FALSE, score:0, correctionLine:-1}` (conservador = MANTÉM, oposto do refuter); (c) `JSON.parse` lança → `{fixed:false}`; (d) `fixed` não-booleano → `false`; (e) comentário no teste citando "conservador AQUI = `fixed:false`, INVERSO do `parseRefuteVerdict` (refuted:true)". **Risco P0 do plano: copiar o default errado fecharia P0.**

### Task 3 — `validateCitation` (puro)
- [ ] Espelha `isCiteValid` (cite-the-line.ts:48): `correctionLine` inteiro `>=1` dentro do range do arquivo do HEAD E a linha NÃO vazia (após trim). Teste: (a) linha existente não-vazia → true; (b) fora do range → false; (c) `-1` → false; (d) só whitespace → false. `fileContent` literal multi-linha (sem I/O).

### Task 4 — `decideVerify` (puro, regra de combinação)
- [ ] `decideVerify(dossie, verdict, fileContent, closeThreshold)` → união discriminada `{action:'resolve'} | {action:'reply', correctionLine} | {action:'preserve'}`. Teste: (a) P0 + fixed:true + score 10 + citação válida → `reply` (**NUNCA resolve** — p0CloseRule, decisão Pablo); (b) P1 + fixed:true + score 0.95 + citação válida → `resolve`; (c) P1 + fixed:true + score 0.85 (<0.9) → `preserve`; (d) P2 + fixed:true + citação inválida → `preserve`; (e) P1 + fixed:false → `preserve`; (f) severity null → `preserve`. Threshold é parâmetro (vem do YAML, Task 8).

### Task 5 — `github.ts`: `replyToReviewThread` (borda) + anti-loop
- [ ] Mutation `addPullRequestReviewThreadReply` via `GraphqlClient` (FakeGraphqlClient em github.test.ts:116). ANTES de responder, verificar se já há reply NOSSO (FINDING_MARKER_PATTERN, github.ts:209) — subir `REVIEW_THREADS_QUERY` de `comments(first:1)` → `first:5` (github.ts:191) e expor os bodies. Teste: (a) sem reply nosso → chama mutation 1x; (b) com reply nosso já presente → NÃO responde (idempotente); (c) mutation falha → não lança (best-effort, espelha `resolveOneThread`).

### Task 6 — `listFindingThreads` carrega `rootBody`
- [ ] `parseFindingThread` (github.ts:239-246) e o retorno de `listFindingThreads` passam a carregar `rootBody: string` (o `comments.nodes[0].body`, hoje descartado). `ExistingThread` (post.ts) ganha `rootBody?: string`. Teste: assert que `listFindingThreads` devolve `rootBody`. Motivo: o dossiê do zumbi (severity/rationale) sai de `parseInlineBody(rootBody)`.

### Task 7 — `reconcileScope` ganha `zombieCandidateThreadIds`
- [ ] `reconcileScope` (post.ts:138-147) retorna 3º campo: `existing.filter(t => !t.isOutdated && !findings.some(f => matchesThread(f,t))).map(t=>t.threadId)`. `reconcileInline` repassa (filtra por delta nos dois caminhos; `undefined` no 1º review → vazio). **Os 2 campos existentes (`toPost`, `toResolveThreadIds`) ficam BYTE-IDÊNTICOS.** Teste (estende post.test.ts): (a) caso c2 (linha 188) agora aparece em `zombieCandidateThreadIds` E continua fora de `toResolveThreadIds`; (b) caso #475 (linha 273-284): T-VIVO entra em zombie, T-CORRIGIDO continua em toResolve; (c) thread com finding próximo nunca vira candidata; (d) regressão: todos os asserts atuais idênticos.

### Task 8 — `config/defaults.yml`: seção `verify`
- [ ] `readVerifyConfig(configPath)` lê `verify: { close_threshold: 0.9, max_threads_per_run: 10 }` — espelha `readAdversarialThreshold` (gatekeeper.ts:249-255). Teste: (a) lê 0.9 e 10; (b) seção ausente → defaults embutidos. Mock: YAML temporário.

### Task 9 — `verifyZombieThreads` (orquestrador, bordas injetadas via DIP)
- [ ] `verifyZombieThreads({threads, candidateIds, packPath, run, model, closeThreshold, maxThreads})` → `{toResolveExtra:string[], p0ToReply:{threadId,correctionLine}[]}`. 3 cortes de custo: (1) delta-only (candidateIds já restritos ao delta); (2) CAP: ordena por severidade (P2→P1→P0) e corta em `maxThreads`, excedente preserva; (3) 1 LLM/thread via `Promise.allSettled` (espelha `runAdversarial` gatekeeper.ts:204) → rejeição = preserva. Por candidata: `parseInlineBody(rootBody)` → null preserva; `buildVerifyUserPrompt(rationale + arquivo inteiro via loadContextPack)` → `run` → `parseCorrectionVerdict` → `validateCitation` → `decideVerify`. Teste com `VerificadorFake` (ChatRunner nomeado): (a) P1 corrigido → toResolveExtra; (b) P0 corrigido → p0ToReply (nunca toResolveExtra); (c) acima do cap → preserva + conta calls ≤ maxThreads; (d) LLM rejeita → preserva; (e) loadContextPack '' → preserva; (f) threshold respeitado.

### Task 10 — Integração no CLI do post + guarda de SHA
- [ ] Entre `reconcileInline` (post.ts:305) e `resolveReviewThreads` (post.ts:319): ler verify config; usar `CONTEXT_PACK_PATH`; **validar `pack.sha == pr.data.head.sha`** antes de fechar (se divergir, PULA o gate, preserva tudo); chamar `verifyZombieThreads` com `realChatRunner` + `DEDUP_MODEL` (deepseek-v4-flash) + `LLM_*`; `const allToResolve = [...toResolveThreadIds, ...toResolveExtra]` → `resolveReviewThreads` (inalterada); para cada `p0ToReply` chamar `replyToReviewThread`. Sem unit test direto (borda); cobertura nas puras. Log: `confirmados/candidatos`.

### Task 11 — YAML (`ai-review.yml`)
- [ ] Job `post` (257-296): `actions/download-artifact@v4` do `context-pack` (hoje NÃO baixa — gap real); no `env`: `LLM_API_KEY`, `LLM_BASE_URL` (default igual review/gatekeeper), `DEDUP_MODEL: deepseek/deepseek-v4-flash`, `CONTEXT_PACK_PATH: /tmp/context-pack/context-pack.json`, `VERIFY_MAX: '10'`. **CONCURRENCY top-level** (hoje inexistente — gap real): `group: movvia-ai-review-pr-${{ inputs.pr_number }}`, `cancel-in-progress: true`. `tests/workflow-yaml.test.ts`: novos asserts (download artifact, env, concurrency); manter 32 verdes.

### Task 12 — Verificação final + E2E
- [ ] `npx vitest run` (>215). Regressão de reconcile idêntica. E2E no #475 (cenários A–E do plano). Só então:

### Task 13 — Semver
- [ ] `package.json` 0.6.0 → **0.7.0** (MINOR: adiciona comportamento sem quebrar contrato; `reconcileScope` ganha campo novo, os 2 retornos atuais byte-idênticos).

---

## Validação E2E (PR #475)
- **A (P0 zumbi NÃO fecha):** T-VIVO cross-tenant P0 → mesmo se LLM disser fixed:true, `reply` (não resolve); thread segue não-resolvida; 1 reply mesmo após 2 pushes; check run segue failure.
- **B (P1/P2 corrigido por inserção distante FECHA):** lock inserido longe da linha ancorada → verificador acha, citação válida → `resolve`.
- **C (fail-closed):** commit cosmético → fixed:false ou score<0.9 → preserve.
- **D (custo/delta-only):** mesmo SHA → 0 candidatas → 0 calls.
- **E (guarda SHA):** 2 pushes rápidos → concurrency cancela; sobrevivente valida `pack.sha==head.sha`.

## Riscos conhecidos
- Inversão do fail-closed (P0 do plano): mitigado por Task 2 + teste explícito + comentário no código.
- Prova de ausência por LLM é falível p/ P1/P2: por isso P0 nunca fecha; P1/P2 residual aceitável (fechar não apaga o código; reaparece como thread nova).
- Granularidade de arquivo na prova: se a correção migrou para outro arquivo, LLM pode dizer fixed:true sem ver o helper. Documentar; expandir para imports (camada 3 do pack) se virar reclamação.
