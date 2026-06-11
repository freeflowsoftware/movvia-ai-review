# AGENTS.md

This file provides guidance to Claude Code (claude.ai/code) and other AI coding agents when working with code in this repository.

`movvia-ai-review` e um PR reviewer multi-agente in-house da Movvia. E um repo CENTRAL: cada repo alvo (pe-*) importa este reusable workflow via referencia `@v1` e ganha review automatico nos PRs. O conceito nuclear: cada arquivo `agents/*.md` vira um agente, uma dimensao e um job paralelo de review. Versao `0.9.5` (`package.json:3`), `"private": true`, ESM puro (`"type": "module"`), Node `>=22` (`package.json:6-7`). Nao ha build de producao: os CLIs rodam direto via `tsx` em runtime, sem `tsc`.

## Comandos

Gerenciador canonico: pnpm (lockfile `pnpm-lock.yaml`, sem `package-lock.json`/`yarn.lock`). Apenas 5 npm scripts existem (`package.json:9-16`); nao ha `build` nem `lint`.

- Instalar deps: `pnpm install` (ou `npm install`).
- Rodar TODOS os testes: `npm test` = `vitest run` (`package.json:10`). Roda `tests/**/*.test.ts` (`vitest.config.ts:4`), ambiente `node`. 18 arquivos de teste, um por modulo de `lib/`, mais `workflow-yaml.test.ts` (valida o YAML do workflow) e `validate-agents.test.ts`.
- Rodar UM arquivo de teste: `npx vitest run tests/gatekeeper.test.ts`.
- Filtrar por nome (substring do `describe`/`it`): `npx vitest run -t "deve fechar thread"`.
- Watch: `npm run test:watch` = `vitest` (`package.json:11`).
- Validar agentes: `npm run validate:agents` = `tsx scripts/validate-agents.ts` (`package.json:15`). O script usa `process.argv[2] ?? 'agents'`, entao ja aponta para `agents/` por default. Checa nome duplicado, persona vazia e `name` kebab-case via `/^[a-z0-9-]+$/` (`scripts/validate-agents.ts:8-12`); emite `::error::` + `exit(1)` se houver erro (`scripts/validate-agents.ts:18-21`). NAO valida `model`, `paths` nem `severity_hints`.

CLIs locais via `tsx` (todos sem passo de transpilacao):

- `npm run discover` = `tsx lib/discover.ts [agents]` (default `'agents'`, `lib/discover.ts:56`). Imprime a matrix JSON dos agentes em UMA linha (`lib/discover.ts:55-58`).
- `npm run gatekeeper` = `tsx lib/gatekeeper.ts <findingsDir> <diffPath> [packPath]`. Le os `*.json` de findings do dir, aplica o pipeline de consolidacao e escreve `{verdict, findings}` em stdout. `packPath` tambem aceito via env `CONTEXT_PACK_PATH`.
- `npm run post` = `tsx lib/post.ts <verdictPath>` (`post.ts:270`).
- Sem alias npm, so via `tsx`: `tsx lib/context-pack-cli.ts <repoDir> <diffPath>` e `tsx lib/agent-runner-cli.ts <agentName> <repoDir> <diffPath> [packPath]`.

Rodar UM agente isolado localmente:

```
tsx lib/agent-runner-cli.ts <agentName> <repoDir> <diffPath> [packPath]
```

- `<agentName>`: nome do arquivo em `agents/` sem `.md` (le `agents/<name>.md` relativo ao repo central, `agent-runner-cli.ts:127-128`). Os 7 ativos: `seguranca`, `arquitetura`, `performance`, `regressao`, `requisitos`, `testes`, `adr-guardian`.
- `<repoDir>`: repo alvo (le `.claude/rules/*.md`, `CLAUDE.md`/`AGENTS.md` via `loadRepoRules`, ADRs via `loadAdrs`).
- `<diffPath>`: diff unificado do PR; `changedFiles` extraido por `/^\+\+\+ b\/(.+)$/gm` (`agent-runner-cli.ts:129-131`).
- `[packPath]`: JSON do context-pack opcional; vazio = prompt sem contexto (degradacao graciosa).

Se o diff nao casar nenhum glob `paths` do agente, ele emite `{"agent":...,"findings":[]}` e sai com exit 0 SEM chamar o LLM (`agent-runner-cli.ts:135-138`). Para a chamada real ao LLM (`realChatRunner`, `run-agent.ts:112-136`) o ambiente exige `LLM_BASE_URL` e `LLM_API_KEY`; o modelo vem de `AGENT_MODEL > DEFAULT_MODEL > fallback hardcoded google/gemini-2.5-flash-lite` (`agent-runner-cli.ts:158`), temperatura fixa 0.1. Jira e opcional (so o agente de requisitos enxerga a US).

## Arquitetura

### Pipeline do CI e a matriz 1-md=1-job

O reusable workflow central e `.github/workflows/ai-review.yml` (invocado via `workflow_call`, `ai-review.yml:3`). No evento `pull_request` encadeia 6 jobs mais 2 isolados de pushback:

1. `gates` (`ai-review.yml:43`): roda Gate Jira (`lib/jira.ts`) e Gate ADR (`lib/adr.ts`). So roda se `event != 'review_comment'`.
2. `discover` (`ai-review.yml:84`): roda `lib/discover.ts` e emite a matriz dinamica como output `matrix`.
3. `context-pack` (`ai-review.yml:114`, `needs: discover`): gera o context-pack determinístico UMA vez por PR via `lib/context-pack-cli.ts` e publica o artefato `context-pack`, para os N agentes nao recalcularem o mesmo pack.
4. `review` (`ai-review.yml:158`, `needs: [discover, context-pack]`): job em matrix `${{ fromJson(needs.discover.outputs.matrix) }}` com `fail-fast: false` (`ai-review.yml:161-163`); cada celula roda um agente via `lib/agent-runner-cli.ts` e sobe `findings-<name>`.
5. `gatekeeper` (`ai-review.yml:222`, `needs: review`): baixa todos os `findings-*` mais o pack e consolida via `lib/gatekeeper.ts`, produzindo `verdict.json`.
6. `post` (`ai-review.yml:274`, `needs: gatekeeper`): posta inline comments mais check run via `lib/post.ts` e reconcilia threads contra o head atual.

A matriz nasce em `lib/discover.ts`: `discoverAgents` filtra `f.endsWith('.md') && !f.startsWith('_')` (`discover.ts:43`), ordena e parseia cada arquivo. O prefixo `_` e o mecanismo de ignore (`agents/_SCHEMA.md` nao vira job). `buildAgentSpec` (`discover.ts:21-39`) exige `name` (erro se ausente) e usa defaults `dimension = name`, `model = ''`, `paths = ['**/*']`. `toMatrix` (`discover.ts:48-52`) emite `{ include: [{ name, model, file, paths }, ...] }`: cada item e uma celula, ou seja, um job paralelo. Hoje sao 7 agentes ativos = 7 jobs. Adicionar um `.md` adiciona um job sem tocar no workflow; renomear para `_x.md` o desativa.

Concorrencia por PR via `movvia-ai-review-pr-${{ inputs.pr_number }}` com `cancel-in-progress: false` (`ai-review.yml:39-41`), serializando pipeline e judge-pushback do mesmo PR sem matar um julgamento em curso.

### Triggers do caller e guards de seguranca

O caller (`.github/caller-template.yml`, distribuido aos repos; `pr-review.yml` e a versao dogfooding local) ouve 3 eventos: `pull_request` (pipeline completo), `issue_comment` (comando `/ai-review` para re-rodar, `--full` forca review completo) e `pull_request_review_comment` (dev responde thread inline, aciona judge). Guards:

- Job `call`: roda se `pull_request`, OU se o comentario comeca com `/ai-review` E e PR (`github.event.issue.pull_request`) E o autor e membro (`author_association` em `["OWNER","MEMBER","COLLABORATOR"]`). Esse author guard e o fix P0 contra fork: como `issue_comment` roda com `secrets: inherit`, sem ele qualquer um de fork dispararia o pipeline com os secrets reais.
- Job `judge`: roda se `pull_request_review_comment` E `in_reply_to_id` presente (reply a thread, nao comentario raiz) E mesmo author guard E `!contains(comment.body, 'movvia-ai-review:')` (anti-loop: ignora replies com o marker do proprio bot).

Diferenca dos callers: `caller-template.yml:26` usa `freeflowsoftware/movvia-ai-review/.github/workflows/ai-review.yml@v1` (cross-repo `@v1`); `pr-review.yml:23` usa `./.github/workflows/ai-review.yml` (local, para o dogfooding evitar startup_failure de reuso cross-repo em repo privado).

### Gatekeeper e fluxo de findings

Schema `Finding` em `lib/types.ts:4-16`: `agent`, `file`, `startLine`, `endLine`, `severity` (`Severity = 'P0' | 'P1' | 'P2'`, `types.ts:1`), `category`, `title`, `rationale`, `suggestion`, `cite` (ancora `"file:start-end"`). Atencao: `agent` e injetado por `parseFindings` (`run-agent.ts:84`) a partir do nome do agente, sobrescrevendo o que o LLM puser; `dimension` NAO e campo de `Finding` (vive em `AgentSpec`). Shape validado por `isValidFinding` (`run-agent.ts:50-62`); `normalizeKeys` tolera `start_line`/`end_line` snake_case.

O entrypoint do gatekeeper (`lib/gatekeeper.ts:319-372`) aplica, em ordem:

1. Carga: concatena `.findings` de todos os `*.json`; `added` vem de `parseAddedLines(diff)`.
2. `filterByCite` (`gatekeeper.ts:334`): mantem so findings cujo `cite` cobre ao menos UMA linha ADICIONADA do diff (descarta finding fora do diff ou alucinado).
3. `dedupe` (`gatekeeper.ts:335`): chave EXATA `file + category + lineAnchor(startLine)` com `lineAnchor = floor(startLine / 5)` (`LINE_BUCKET=5`); em colisao mantem maior severidade (`SEVERITY_RANK` P0=3/P1=2/P2=1). Bucket FIXO de proposito para manter `findingId` consistente.
4. `dedupeByLine` (`gatekeeper.ts:340`): dedup CROSS-agente e CROSS-categoria, agrupa por `file` e funde vizinhos por `endLine` com janela DESLIZANTE de +-1 linha. Pega o mesmo problema apontado por agentes diferentes em categorias diferentes. Roda ANTES do adversarial para nao gastar refutador em duplicatas.
5. `runAdversarial` (`gatekeeper.ts:357`): o refuter cetico. `threshold` lido de `config/defaults.yml` em `gatekeeper.adversarial_threshold` (default `0.8`). Modelo `REFUTER_MODEL || DEDUP_MODEL || 'deepseek/deepseek-v4-flash'` (raciocinio, nao Flash-Lite). Mantem finding so se `!refuted && score/10 >= threshold`.
6. `consolidateFindings` (`gatekeeper.ts:365`): fusao SEMANTICA via LLM (DeepSeek, `DEDUP_MODEL`). `CONSOLIDADOR_SYSTEM` instrui fundir duplicatas semanticas, detectar contradicoes (descartar ambos os findings contraditorios) e remover findings fora da dimensao. Protecoes: `length <= 1` pula o LLM; LLM vazio com entrada nao-vazia retorna os originais (nunca descarta achado real por falha de modelo); try/catch mantem `kept` se a infra falhar.
7. `capProcessGateSeverity` (`gatekeeper.ts:370`): rebaixa para P2 qualquer finding cujo `agent` esteja em `PROCESS_GATE_AGENTS = new Set(['adr-guardian'])` (`gatekeeper.ts:299-304`). Determinístico. Motivacao: no PR #475, 5 de 6 P1 eram gate de processo, o que treina o time a ignorar P1. `requisitos` NAO entra aqui (criterio de aceite nao cumprido pode ser bloqueante real).
8. `decideVerdict` (`gatekeeper.ts:307-316`): `blocking = counts.P0 + counts.P1 > 0`; qualquer P0 OU P1 vira `event: REQUEST_CHANGES` + `conclusion: failure`; P2 nunca bloqueia. Como o cap roda antes, gate de processo nunca produz REQUEST_CHANGES.

Refuter cetico (`gatekeeper.ts:113-244`), postura "na duvida, mantem". Refuta (refuted=true) so em 3 casos: (a) o problema ja esta tratado no contexto (filtro/lock/validacao/guard presente, ou padrao segue os arquivos irmaos); (b) o finding cita codigo que NAO existe (alucinacao, deve transcrever em `evidence` a linha real que contradiz); (c) e puramente especulativo ou de processo. Em TODOS os outros casos `refuted=false`: ausencia real visivel no codigo E o problema. Falha de PARSE do JSON do cetico descarta conservadoramente (`{refuted:true,score:0}`); falha de INFRA (timeout/rede) MANTEM o finding (`{refuted:false,score:10}`, via `Promise.allSettled`). Anti-alucinacao do proprio cetico: `evidenceHallucinated` forca refuted=true se ele mantem o finding mas a `evidence` transcrita nao existe no excerpt. O excerpt factual vem do context-pack via `excerptFor`/`loadContextPack`.

### Agentes e selecao de modelo

Um agente e um `.md` com frontmatter YAML mais persona PT-BR (contrato em `agents/_SCHEMA.md`). Campos do frontmatter, parseados em `lib/discover.ts`:

- `name` (obrigatorio, kebab-case): vira o nome do job e o `agent` na saida. Erro se ausente (`discover.ts:26-29`).
- `dimension` (fallback = `name`): controla o bloco de EXCLUSIVIDADE no system prompt (`exclusivityBlock`, `context-loader.ts:79-88`), travando o agente a reportar so problemas dessa dimensao.
- `model` (fallback `''`): vazio = default do CI; ou id puro do provider. Injetado por job como env `AGENT_MODEL` (`ai-review.yml:208`).
- `paths` (default `['**/*']`): globs; o agente so roda se o PR tocar algum (via `agentMatchesPaths`/`minimatch`, `context-loader.ts:148-150`).
- `severity_hints`: mapa P0/P1/P2 renderizado na secao "Calibracao de severidade" do system prompt (`context-loader.ts:98-107`).

A persona (texto apos o segundo `---`) vira o `role:'system'` via `buildSystemPrompt`, junto da exclusividade, calibracao, blocos precisao/recall e o schema JSON obrigatorio. Saida obrigatoria: unico objeto `{"agent","findings":[...]}` em camelCase.

Selecao de modelo por dimensao. Default Gemini Flash-Lite (barato/rapido) para `model: ""` (`performance`, `requisitos`, `testes`, `adr-guardian`): `config/defaults.yml:10-13` define `default_model: gemini/gemini-flash-lite`, com fallback hardcoded `google/gemini-2.5-flash-lite` (`agent-runner-cli.ts:158`). So as dimensoes de raciocinio sobem para DeepSeek: `seguranca.md:7` (`deepseek/deepseek-v4-flash`, vazamento cross-tenant por omissao de filtro), `arquitetura.md:6` (camadas/SRP/KISS/lock sem finally), `regressao.md:3` (delecao nao-relacionada/dead code/import fantasma). A chamada e chat-completion direta via fetch nativo (`realChatRunner`); o README ainda menciona "via opencode", mas o codigo ja migrou para fetch direto sem opencode.

Montagem do prompt (`context-loader.ts`): SYSTEM = exclusividade + persona + calibracao + precisao/cobertura + schema. USER nesta ordem: secao US do Jira (so se houver ticket), org-rules, repoRules, lang-packs, ADRs, context-pack, e por fim o DIFF DO PR. Ordem deliberada: org-rules ANTES das do repo (base compartilhada vem primeiro, repo alvo refina depois) e o context-pack abaixo das regras porque "regra documentada vence padrao observado" (`context-loader.ts:135,159-160,173`).

### Gates Jira e ADR

Gate Jira (`lib/jira.ts`): regex `JIRA_KEY = /\b(PED|PEG|AR|AN|SEO)-\d+\b/` (`jira.ts:1`) extrai a primeira chave do titulo do PR. `issueExists` e o gate puro (REST v3, `res.status === 200`); `getIssueContext` traz `summary,description` (com `adfToText` achatando o ADF) para o agente de requisitos. Degradacao sem secrets (`jira.ts:71-87`): SEM chave no titulo = `::error::` + `exit(1)` sempre (gate duro, independe de credencial); COM chave mas SEM `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` = valida so o FORMATO e segue (`Jira OK`); COM os 3 secrets = se a issue nao existe, falha. Chave malformada sempre falha; chave inexistente so falha quando ha credencial.

Gate ADR (`lib/adr.ts`), sem dependencia de secrets, puro glob + regex sobre lista de arquivos e corpo do PR. `ARCH_GLOBS` define o que EXIGE ADR: `pe-migrations/**`, `**/schema.prisma`, `**/Dockerfile`, `pe-infra/**`, `**/application*.yml`, `**/domain/**` (`adr.ts:3-10`). `hasAdr` (`adr.ts:24-27`) e satisfeito se algum arquivo alterado casa `ADR_GLOBS` (`**/adr/**`, `**/ADR-*.md`, `docs/**/ADR-*.md`) OU o corpo do PR cita `ADR-\d+` (`ADR_REF = /\bADR-\d+\b/i`). Bloqueio: `needsAdr && !hasAdr` dispara `::error::Mudanca arquitetural sem ADR` + `exit(1)`. `adr.ts` so detecta PRESENCA de arquivo/referencia, nao le nem parseia ADRs externos.

### Ciclo de vida do comentario: verify-fix e judge/pushback

Marcador e idempotencia. Cada inline carrega `findingMarker(f) = '<!-- movvia-ai-review:${f.agent}:${findingId(f)} -->'` (`post.ts:34-36`), com `findingId(f) = sha1('${f.file}:${lineAnchor(f.startLine)}:${f.category}').slice(0,12)` (`gatekeeper.ts:35-40`). Ancorar no bucket (nao na linha crua, e sem `endLine`) faz um commit que empurra o codigo 1 linha NAO gerar marker novo. A reconciliacao (`reconcileScope`, `post.ts:155-171`) NAO usa o marker: casa finding x thread por PROXIMIDADE (mesmo arquivo E `|findingLine - t.line| <= LINE_PROX` com `LINE_PROX=5`), porque o modelo nao-determinístico re-gera marker/linha a cada run. Saida em 3 conjuntos: `toPost` (sem thread proxima = novo); `toResolveThreadIds` (thread `isOutdated` E sem finding proximo = corrigido, as DUAS condicoes juntas, garante que P0 nunca fecha com codigo vulneravel intacto); `zombieCandidateThreadIds` (thread `!isOutdated` E sem finding proximo, vai para o verificador de codigo). `reconcileInline` restringe ao delta de arquivos quando ha `previousSha != sha` (`post.ts:128-139,355-357`).

verify-fix (`lib/verify-fix.ts`) confirma, ANTES de fechar uma thread zumbi, que o problema sumiu de fato lendo o arquivo no head, em vez da heuristica fraca `isOutdated`. Fail-closed INVERTIDO em relacao ao refuter: na duvida PRESERVA. Reconstroi o dossiê do finding lendo o cabecalho `**Pn**` no topo do 1o comentario (`parseInlineBody`, `verify-fix.ts:43`); sem esse cabecalho, severity null = nao-fechavel. `parseCorrectionVerdict` ilegivel => `fixed:false` (mantem; o oposto do refuter). `validateCitation` exige `correctionLine` inteiro `>= 1`, dentro do arquivo e nao-vazia. `decideVerify` (`verify-fix.ts:112-124`): fecha SO com `fixed` + citacao valida + `score/10 >= close_threshold` (default `0.9`); P0 NUNCA resolve, vira `{ action: 'reply' }`; so P1/P2 resolvem. `verifyZombieThreads` cap por `max_threads_per_run` (default `10`) priorizando P2/P1 (P0 por ultimo, ja que so responde), 1 LLM por thread via `Promise.allSettled` (rejeicao preserva, nao fecha as cegas).

judge/pushback (`lib/judge.ts`). Quando o dev RESPONDE uma thread (evento `pull_request_review_comment`), o `judge-pushback` (`ai-review.yml:325`, `sleep 90` de debounce) avalia o ARGUMENTO TEXTUAL, nao o codigo. `shouldJudge` (`judge.ts:61-66`): nao reage ao proprio reply do bot (identidade e a guarda PRIMARIA, nao o marker), so threads nossas, circuit-breaker apos `max_replies` (default `3`). `decideJudge` (`judge.ts:44-48`): P0 retorna `reply_only` ANTES de olhar o veredito (nenhum argumento textual fecha P0); P1/P2 so `withdraw` com `valid && evidenceCite`. `JUDGE_SYSTEM` rejeita autoridade ("confia", "o PO aprovou"), probabilidade, promessa futura, urgencia; sem evidencia verificavel `evidenceCite=null` e `valid=false`.

Store de withdrawals (`lib/withdrawals.ts`). Como o codigo NAO muda (so o argumento), sem store o re-review re-postaria o finding a cada push em loop. Vive num comentario top-level com `withdrawalsMarker = '<!-- movvia-ai-review:withdrawals -->'`. `parseWithdrawals` e fail-SAFE (na duvida nao suprime). `upsertWithdrawal` REJEITA `severity === 'P0'` (o store nunca contem P0) e faz upsert por `findingId` exato (inclui `category`, entao `cred` withdrawn nao suprime `perf` na mesma linha). `computeValidWithdrawals` invalida entries cujo ARQUIVO mudou desde o `acceptedSha` da propria entry (o argumento era sobre o codigo antigo). No `post.ts`, `suppressByWithdrawals` filtra ANTES da reconciliacao e o verdict e recomputado quando ha withdrawals validos (um P1 contestado deixa de bloquear).

Resolver threads exige identidade dedicada: o `GITHUB_TOKEN` nativo do bot NAO resolve review threads, so PAT/App resolve. `resolveOctokit` prefere `REVIEW_PAT || AI_REVIEW_REPO_TOKEN`, depois App, e por ultimo o token nativo (usa `||` porque secrets ausentes chegam como string vazia). Sem identidade de review (App ou `REVIEW_PAT`), `decideReviewEvent` cai para `COMMENT` e o gate real e o check run `review-bot/verdict`.

### Release via @v1

`auto-tag-v1.yml` mantem a tag `v1` sempre no HEAD da main: dispara em `push` na `main` e roda `git tag -f v1` mais `git push -f origin v1` (`auto-tag-v1.yml:23-26`), com `concurrency` `cancel-in-progress: true`. Todos os callers nos repos pe-* referenciam `@v1`, entao a cada merge na main os PROXIMOS PRs de todos os repos alvo puxam a versao nova automaticamente: rolling release central, sem mover tag a mao. A indirecao `v1` e preservada de proposito: para travar numa versao estavel ou introduzir um `v2` breaking, basta desligar este workflow ou apontar para outra tag. Como o reusable tambem usa `ref: v1` nos checkouts cross-repo, um pipeline em execucao continua lendo a `v1` vigente no momento do checkout.

Secrets (`ai-review.yml:12-29`). Required: `LLM_API_KEY`. Optional: `LLM_BASE_URL` (endpoint OpenAI-compat); `REVIEW_APP_ID`/`REVIEW_APP_PRIVATE_KEY`/`REVIEW_INSTALLATION_ID` (GitHub App; sem ele o post cai no `GITHUB_TOKEN` e o review vira COMMENT, veredicto so no check run); `REVIEW_PAT` (resolve threads, ja que o token nativo nao resolve); `JIRA_BASE_URL`/`JIRA_EMAIL`/`JIRA_API_TOKEN` (Gate Jira e agente de requisitos); `AI_REVIEW_REPO_TOKEN` (Contents:read para checkouts cross-repo a partir de um pe-*, aparece como `secrets.AI_REVIEW_REPO_TOKEN || github.token`). Todos chegam via `secrets: inherit` no caller. Setup do GitHub App documentado em `RUNBOOK_APP.md` e `docs/github-app-setup.md`; Ruleset em `docs/ruleset.md`.

## Convencoes ao adicionar/editar um agente

Fluxo (de `CONTRIBUTING.md`):

1. Copie `agents/_SCHEMA.md` para `agents/<minha-dimensao>.md`.
2. Preencha o frontmatter: `name` kebab-case unico, `dimension`, `model` opcional, `paths` opcional, `severity_hints` (mapa P0/P1/P2). Preserve a granularidade dos hints: eles viram a calibracao de severidade no prompt.
3. Escreva a persona em PT-BR: o que avaliar, exigir cite `[arquivo:linha]`, "nao inventar API". A persona vira o system prompt; o agente so reporta a propria `dimension`.
4. Rode local: `npx tsx scripts/validate-agents.ts agents` e `npx vitest run`.
5. Abra PR. O `self-test` valida frontmatter, tipos e testes.
6. Apos merge e a tag flutuante `@v1` mover, todos os repos ganham o agente no proximo PR, sem editar YAML.

Trocar o modelo de um agente = campo `model:` (vazio = default Gemini Flash-Lite; suba para `deepseek/deepseek-v4-flash` so se a dimensao exigir raciocinio sutil). O `model` deve ser id puro do provider; um prefixo `llm/` legado e strippado por retrocompat (`run-agent.ts:104-106`). Use `paths` para restringir o agente a arquivos relevantes (ex.: `adr-guardian` so roda em migrations/schema/dominio/Dockerfile/infra/`application*.yml`): isso economiza tokens e evita findings off-dimension. Se o agente e gate de PROCESSO (nunca bloqueia merge), adicione-o a `PROCESS_GATE_AGENTS` em `lib/gatekeeper.ts` para ter a severidade rebaixada a P2 deterministicamente, e na persona deixe explicito P2-only (como `adr-guardian`).

## Contexto por repo-alvo (CLAUDE.md/AGENTS.md/.claude rules, lang-packs, org-rules)

org-rules (`org-rules/`, 16 arquivos): regras org-wide da Movvia (lock financeiro, sem CREATE TYPE ENUM, skeleton, padroes de teste, etc.). Vivem no repo CENTRAL e viajam com a Action, ao contrario das `.claude/rules` do super-repo nao-versionado. Roteamento por stack via frontmatter `appliesTo` (`lib/org-rules.ts`): sem `appliesTo` = transversal, aplica a qualquer diff (ex.: `hardcoded-credentials.md`); com `appliesTo`, so entra se algum arquivo alterado casa algum glob (ex.: `processador-clean-arch.md` em `**/*.java`, `distributed-locks-financial.md` em `**/*.ts`, `flyway-migrations.md` em `**/*.sql`/`**/migrations/**`/`**/flyway/**`, `prisma-schema-rules.md` em `**/schema.prisma`/`**/*.prisma`). `selectOrgRules` devolve so os corpos aplicaveis sem frontmatter. `scripts/sync-org-rules.mjs` sincroniza essas regras.

Regras do repo alvo entram via `loadRepoRules(repoDir)` (`agent-runner-cli.ts:17-29`): le todos os `.md` de `<repoAlvo>/.claude/rules/` e concatena `CLAUDE.md` e `AGENTS.md` da raiz do repo alvo se existirem. O repo alvo e o checkout em `$GITHUB_WORKSPACE`. Por isso este proprio `AGENTS.md` e injetado quando o bot revisa PRs deste repo.

lang-packs (`lang-packs/`: `java.md`, `javascript-typescript.md`, `python.md`): convencao por linguagem, injetada conforme a linguagem de cada arquivo do diff (`detectLanguages` por extensao, `context-loader.ts:5-20`). Exemplo de contraste relevante para o agente de performance: `javascript-typescript.md:3` trata `arr.map().filter().reduce()` encadeados como EAGER (N passagens materializadas), enquanto `java.md:3` trata `stream().map().filter()` como LAZY/single-pass (NAO deve ser tratado como N passagens).

context-pack (`lib/context-pack.ts`, gerado uma vez por PR no CI): empacota, por arquivo alterado, 4 camadas para reduzir falsos positivos. Camada 1 = arquivo alterado INTEIRO (nunca skeletonizado, nunca cortado por budget). Camada 2 = irmaos do diretorio com mesma extensao (mata FP "validacao ausente", cota `max_siblings` 4). Camada 3 = imports intra-repo 1 nivel resolvidos para assinaturas reais (mata FP "API/metodo inventado", cota `max_imports` 6; import nao-resolvido e omitido, nunca vira evidencia de ausencia). Camada 4 = exemplares maduros de mesmo sufixo composto, os de maior LOC (mata FP "teste sem assert", cota `max_exemplars` 3). Aliases do repo via `loadTsconfigAliases` (le `compilerOptions.paths` por regex, expande `@pe/*`). `enforceTokenBudget` corta por PRIORIDADE alterado > irmaos > imports > exemplos com `max_tokens` 100000; camadas 2-4 acima de `skeleton_loc_threshold` (400) sao reduzidas a assinaturas. Degradacao graciosa: cada camada isolada por `safe(fn, fallback)`, erro de I/O vira secao vazia, nunca lanca. O context-pack NAO injeta `.claude/rules`/`CLAUDE.md` (isso entra no prompt por outra parte do pipeline); aqui "regras do repo" sao os exemplares/irmaos idiomaticos e os aliases do tsconfig.
