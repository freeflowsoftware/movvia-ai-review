# Sketch de Spec: validacao de criterios de aceite via Jira no movvia-ai-review

> Status: SKETCH (esboco para revisao do Pablo, nao spec final). Vira plano de implementacao depois do OK.
> Repo alvo: `freeflowsoftware/movvia-ai-review` (clone local em `/Users/pablowinter/projects/movvia-ai-review`).
> Data: 2026-06-10.

## 1. Objetivo e problema

O diferencial de produto do movvia-ai-review na dimensao "requisitos" e confrontar a US do Jira contra o diff e bloquear merge quando um criterio de aceite explicito nao foi entregue. Hoje esse diferencial esta DESLIGADO em producao por dois motivos compostos:

1. **Secrets ausentes.** Os 3 secrets que o codigo le (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN`) nao existem nem org-wide na `freeflowsoftware` (la so ha `LLM_API_KEY` e `LLM_BASE_URL`, ambos de 2026-06-03) nem em nivel de repo (verificado em pe-api-core, pe-processador-concessionaria, gestao-webhooks-api e o proprio movvia-ai-review). Sem os 3, `loadJiraTicket` cai no early return `if (!key || !JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) return undefined` (`lib/agent-runner-cli.ts:116`), `jiraSection(undefined)` retorna `[]` (`lib/context-loader.ts:55`), e a secao `## US do Jira` some do prompt. O agente requisitos roda SEM a US e cai na clausula de no-op da propria persona (`agents/requisitos.md:13`: "Se a US esta ausente do contexto... no maximo um P2... nunca e P0/P1").

2. **Nenhuma validacao item-por-item.** Mesmo com a US presente, hoje a persona so manda "Confronte os criterios de aceite da US com o que o PR realmente implementa" (`agents/requisitos.md:11`) sem exigir uma prova de cobertura por criterio. O modelo pode avaliar 2 de 5 criterios e silenciar os 3 restantes, sem que nada detecte a omissao. Nao ha tabela por-criterio, nem status enumerado (ATENDIDO / PARCIAL / NAO_ATENDIDO / NAO_VERIFICAVEL), nem garantia de que TODO criterio foi confrontado.

Esta feature ataca os dois: ligar os secrets (F0) e transformar a persona de requisitos num checker que emite uma prova de cobertura item-por-item e bloqueia (P1) so os criterios funcionais nao entregues.

## 2. Estado atual (mecanica Jira real + gap de secrets)

### Extracao da chave
- Regex unica em `lib/jira.ts:1`: `/\b(PED|PEG|AR|AN)-\d+\b/`. So 4 prefixos. `extractJiraKey` (`lib/jira.ts:3-5`) retorna o primeiro match ou null.
- `resolveJiraKey` (`lib/agent-runner-cli.ts:103-106`): usa `JIRA_KEY` explicito se setado, senao extrai de `PR_TITLE`. No CI `JIRA_KEY` nao e setado em lugar nenhum, e `PR_TITLE` vem do titulo do PR (`/tmp/pr-title.txt` capturado e exportado em `.github/workflows/ai-review.yml:210,230`). Logo a chave SEMPRE vem do TITULO do PR, nunca do body. Multiplos tickets no titulo => so o primeiro e usado.

### Busca REST v3
- `HttpJiraClient.getIssue` (`lib/jira.ts:48-53`): `GET {baseUrl}/rest/api/3/issue/{key}?fields=...`, auth Basic `email:token` em base64 (`lib/jira.ts:49-51`), padrao Jira Cloud (API token).
- Dois usos: `issueExists` pede `fields=key` (`lib/jira.ts:36`, so checa status 200); `getIssueContext` pede `fields=summary,description` (`lib/jira.ts:40`).
- `getIssueContext` (`lib/jira.ts:39-47`) le `body.fields.summary` e `body.fields.description`, retorna null se status != 200, e achata a description com `adfToText`.
- `adfToText` (`lib/jira.ts:61-68`): trata description como string (instancias antigas) OU arvore ADF (REST v3), recursando em `node.content` e concatenando `node.text` com `.join(' ')`. NAO emite `\n`: bulletList, orderedList, heading, codeBlock e paragraph viram uma unica linha achatada, sem marcador de item. A estrutura de lista/numeracao/Gherkin some.
- A interface `JiraTicket` (`lib/jira.ts:8-11`) so tem `summary` e `description`. Campo custom "Criterios de Aceite" (comum em Jira) NAO esta em `description` e nao e buscado, entao hoje o agente literalmente nao ve criterios que vivam num customfield.

### Injecao no prompt
- `loadJiraTicket` (`lib/agent-runner-cli.ts:113-119`) e chamado por TODOS os agentes da matrix no entrypoint (`lib/agent-runner-cli.ts:139`), retorna `JiraTicket | undefined`.
- `jiraSection` (`lib/context-loader.ts:54-57`) injeta `## US do Jira` (summary + description) no USER prompt de TODOS os agentes. So o agente `requisitos` confronta criterios; os outros recebem como contexto mas sao travados na propria dimensao pelo `exclusivityBlock` (`lib/context-loader.ts:79-88`).

### Gate Jira (job `gates`) e degradacao
- Step `Gate Jira` (`.github/workflows/ai-review.yml:72-77`): roda `npx tsx lib/jira.ts "$TITLE"`. A logica do CLI (`lib/jira.ts:71-87`): sempre valida FORMATO do titulo (`exit 1` se sem chave, `lib/jira.ts:74-77`); so checa EXISTENCIA da issue se os 3 secrets estiverem presentes (`if (JIRA_BASE_URL && JIRA_EMAIL && JIRA_API_TOKEN)`, `lib/jira.ts:79`). SEM secrets (estado atual), degrada para validacao puramente de formato: um PR com `feat: PED-9999999 inexistente` passa o gate.

### Declaracao e gap de secrets
- `workflow_call.secrets` (`.github/workflows/ai-review.yml:22-24`): os 3 com `{ required: false }`. O caller passa `secrets: inherit`, entao herdaria qualquer org/repo secret com esses nomes SEM mudanca de codigo. O problema e puramente de provisionamento: os secrets nao existem.

## 3. Escopo

### In
- Provisionar os 3 secrets Jira org-wide na `freeflowsoftware` com conta de servico dedicada.
- Enriquecer `HttpJiraClient.getIssueContext` para trazer mais campos (no minimo `issuetype`; opcionalmente o customfield de criterios de aceite) e preservar quebras de linha de listas no ADF.
- Evoluir a persona de `agents/requisitos.md` para emitir prova de cobertura item-por-item (tabela com status por criterio) + 1 finding por criterio bloqueante.
- Calibrar o mapeamento status -> severidade e a interacao com o REFUTER (`lib/gatekeeper.ts`) sem mexer no schema `Finding` nem adicionar requisitos a `PROCESS_GATE_AGENTS`.
- Testes e docs.

### Out
- Criar um agente novo (`criterios-aceite.md`). Decisao 4.5 abaixo: evolui-se requisitos.md.
- Mover validacao semantica de criterio para o job `gates` (deve continuar so checando formato + existencia).
- Reescrever o pipeline de findings/post (`lib/post.ts`, `lib/types.ts`) ou o veredito (`decideVerdict`).
- Suporte a OAuth Jira (mantem Basic com API token).
- Buscar US do body do PR (continua so do titulo).
- Garantia DURA mecanica de cobertura total (so e possivel com reescrita do parser ADF; ver 7 e 9).

## 4. Design tecnico

### 4.1 Configuracao dos secrets Jira (org-wide, conta de servico, rotacao)

- **Conta de servico, nao pessoal.** Criar conta Atlassian dedicada (ex: `ai-review@movvia.com.br`) com so permissao de leitura (Browse Projects) nos projetos PED, PEG, AR, AN. Token pessoal herda todas as permissoes do humano e vaza quando ele sai; conta de servico isola o privilegio.
- **Valores dos 3 secrets:**
  - `JIRA_EMAIL` = email da conta de servico (login do Basic auth, `lib/jira.ts:49`).
  - `JIRA_BASE_URL` = URL base do site Jira Cloud da Movvia (`https://<site>.atlassian.net`), SEM barra final, porque o codigo concatena `/rest/api/3/...` (`lib/jira.ts:50`).
  - `JIRA_API_TOKEN` = token gerado em `id.atlassian.com` > Security > API tokens (preferir "Create API token with scopes" limitado a leitura). So aparece uma vez.
- **Registrar org-wide:** `gh secret set JIRA_BASE_URL --org freeflowsoftware --visibility all` (idem para os outros 2), ou via Settings > Secrets and variables > Actions, escopo "All repositories" (mesmo padrao dos `LLM_*` existentes). O `secrets: inherit` do caller repassa automaticamente e as 3 declaracoes `required: false` (`.github/workflows/ai-review.yml:22-24`) passam a receber valor sem mudanca de codigo. Se preferir restringir, usar "Selected repositories".
- **Rotacao:** API token Atlassian nao expira por padrao. Definir rotacao (ex: 90 dias): gerar novo token com a conta de servico, `gh secret set JIRA_API_TOKEN` na org, revogar o antigo. Sendo org-wide, atualiza num lugar so. Se a conta de servico for desativada, rotacionar/remover os 3.
- **Decisao de gate pos-secrets:** com os 3 presentes, o job `gates` passa a checar existencia da issue (`lib/jira.ts:79-84`), nao so formato. Avaliar se isso e desejavel (pode bloquear PR cuja chave esta correta de formato mas digitada errada). Ver questoes em aberto.

### 4.2 Enriquecimento da busca Jira

Hoje `getIssueContext` so pede `summary,description` (`lib/jira.ts:40`). Campos da REST v3 (`GET /rest/api/3/issue/{key}`) que ajudam o checker:

- **`issuetype` (`fields.issuetype.name`):** MINIMO recomendado. Distinguir Story / Bug / Task / Sub-task. Um PR de Bug nao deve ser cobrado por "criterio de aceite de US"; muda a calibracao do agente. Sem isso, o checker trata Bug como Story.
- **Customfield de criterios de aceite (`customfield_NNNNN`):** o id varia por instancia; descobrir via `GET /rest/api/3/field` e configurar. Sem ele, criterios formais que vivam num campo dedicado (nao na description) ficam invisiveis. Forte candidato a incluir, mas exige descoberta do id (ver questao em aberto).
- **Uteis de menor prioridade:** `status` (`fields.status.name`, coerencia com PR aberto), `subtasks`, `parent`, `labels`/`components` (roteamento de dominio), `priority`, `fixVersions`, `comment` (criterios negociados as vezes vivem em comentario via `?fields=comment`).

Mudancas de codigo necessarias (nao so config):
- Ampliar a string de `fields` em `getIssueContext` (`lib/jira.ts:40`).
- Estender a interface `JiraTicket` (`lib/jira.ts:8-11`) com os campos novos (ex: `issuetype`, opcionalmente `acceptanceCriteria`).
- Ajustar `jiraSection` (`lib/context-loader.ts:54-57`) para renderizar os campos novos no prompt (ex: linha `Tipo: {issuetype}` e bloco `## Criterios de Aceite (campo dedicado)` quando o customfield existir).
- **Preservar estrutura do ADF:** mudar `adfToText` (`lib/jira.ts:61-68`) para emitir `\n` quando o node for `bulletList` / `orderedList` / `paragraph`, em vez de `.join(' ')`. Isso preserva a quebra que o LLM usa como pista de item SEM tentar segmentar em codigo. E mudanca cirurgica, nao altera o contrato de `jiraSection`.

### 4.3 Parsing/segmentacao dos criterios de aceite (prompt vs codigo)

Decisao: **segmentar por PROMPT (LLM), com pre-processamento barato no ADF.** Justificativa:

- Parsear por codigo (regex em `lib/jira.ts`) seria fragil porque `adfToText` (`lib/jira.ts:61-68`) ja destruiu os marcadores: "- " de bullet e "1. " de numeracao viraram espacos. Para regex funcionar seria preciso primeiro reescrever `adfToText` para preservar a arvore, e mesmo assim regex nao capta Gherkin-em-prosa nem frase imperativa solta.
- O LLM ja roda com `temperature: 0.1` (`lib/run-agent.ts`), tolera texto achatado, e capta Gherkin e imperativos. O risco (pular criterio silenciosamente) e atacado em 4.7.
- Melhoria hibrida barata: preservar `\n` no ADF (4.2) da ao LLM uma pista estrutural forte de "1 item por linha", elevando o recall sem custo de codigo de parsing.

Heuristicas a instruir no prompt (a persona deve reconhecer):
- Marcadores de secao: "criterios de aceite", "acceptance criteria", "DoD", "definition of done", "regras de negocio", "cenarios".
- Gherkin: trincas Dado/Quando/Entao e Given/When/Then = 1 criterio por cenario.
- Listas/numeracao remanescentes ("1)", "a)", "- ") = 1 candidato por item.
- Fallback por frase imperativa: "o sistema deve", "deve permitir", "nao deve", "ao ... entao".

### 4.4 Output estruturado por-criterio (encaixe no schema Finding sem quebrar o gatekeeper)

**Restricao mestre:** o `Finding` (`lib/types.ts:4-16`) tem campos FIXOS (`agent`, `file`, `startLine`, `endLine`, `severity`, `category`, `title`, `rationale`, `suggestion`, `cite`). O `cite` e validado mecanicamente: `filterByCite` (`lib/gatekeeper.ts:334`) descarta todo finding cuja cite nao cobre ao menos uma linha ADICIONADA do diff. Um "criterio nao verificavel no diff" por construcao nao tem linha `+` para citar, entao morreria antes do post.

Decisao: **NAO estender o schema. Usar 2 canais do `Finding` ja existente.**

1. **Prova de cobertura (tabela completa, 1 linha por criterio) no `rationale` de UM finding-resumo.** O finding-resumo precisa de cite valida para sobreviver ao `filterByCite`: ancore-o numa linha real adicionada do diff (ex: primeira linha do arquivo central da feature). Severidade P2 (nao bloqueia sozinho). O `rationale` e string livre (`lib/types.ts:12`) e renderiza no corpo do comentario inline, entao a tabela markdown fica visivel. `category` distinta (ex: `cobertura-criterios`) para o consolidador (`consolidateFindings`, `lib/gatekeeper.ts:363-365`) nao fundir a tabela com os findings bloqueantes.

2. **Cada criterio BLOQUEANTE (status NAO_ATENDIDO, ou PARCIAL com impacto funcional) vira 1 `Finding` proprio, P1**, ancorado em `[arquivo:linha]` do codigo que deveria satisfazer o criterio (ou da ausencia mais proxima visivel no diff). Reusa o `severity_hints.P1` ja existente em `agents/requisitos.md:7`. `category` distinta da tabela (ex: `criterio-nao-atendido`).

Status enumerado fixo na tabela: `ATENDIDO`, `PARCIAL`, `NAO_ATENDIDO`, `NAO_VERIFICAVEL_NO_DIFF`. Layout da tabela no `rationale`:

```
| Criterio | Status | Evidencia | Justificativa |
|---|---|---|---|
| CA1: cliente recebe PIX | ATENDIDO | src/pix.service.ts:42 | cria cobranca e retorna QR |
| CA2: estorno parcial | NAO_ATENDIDO | - | nenhum handler de estorno no diff |
| CA3: idempotencia | PARCIAL | src/pix.service.ts:88 | grava cache mas nao checa antes |
| CA4: notifica por e-mail | NAO_VERIFICAVEL_NO_DIFF | - | requer pe-api-notification, fora do PR |
```

Vantagem: zero alteracao em `lib/types.ts`, `lib/run-agent.ts`, `lib/gatekeeper.ts`, `lib/post.ts`. So muda o PROMPT (persona .md). Dedup, adversarial, consolidacao e veredito (`lib/gatekeeper.ts:334-371`) seguem funcionando.

### 4.5 Decisao de arquitetura: evoluir requisitos.md vs novo agente

Decisao: **evoluir `agents/requisitos.md`. NAO criar `criterios-aceite.md`.**

- Pelo padrao 1-md=1-job de `discover.ts:41-46` (`.filter((f) => f.endsWith('.md') && !f.startsWith('_'))` -> `toMatrix`, `lib/discover.ts:48-52`), um `.md` novo viraria um SEGUNDO job paralelo.
- `requisitos.md:3` ja declara `dimension: requirements`. Se o agente novo reusasse `dimension: requirements`, o `exclusivityBlock` (`lib/context-loader.ts:79-88`) injetaria a MESMA frase de exclusividade em dois agentes, gerando dois jobs redundantes que confrontam a US e produzem findings sobrepostos. O comentario do exclusivityBlock e explicito: "a sobreposicao entre agentes so adiciona ruido, nunca recall" (`lib/context-loader.ts:77`). O `dedupeByLine` (`lib/gatekeeper.ts:340`) limparia, mas so adiciona custo de LLM e zero recall novo.
- Se o agente novo usasse dimensao nova (ex: `acceptance`), fragmentaria a analise da US em duas personas que precisam do MESMO insumo (a US do `jiraSection`), duplicando tokens e arriscando vereditos divergentes sobre o mesmo criterio. A analise de criterios de aceite E a dimensao de requisitos; nao ha fronteira que justifique separar.
- Coerencia ja codificada: `capProcessGateSeverity` com `PROCESS_GATE_AGENTS = new Set(['adr-guardian'])` (`lib/gatekeeper.ts:299`) NAO inclui requisitos, e o comentario em `lib/gatekeeper.ts:296-298` diz "requisitos NAO entra aqui: um criterio de aceite funcional nao cumprido pode ser bloqueante real". O pipeline JA trata requisitos como dono dos criterios e capaz de bloquear. Agente novo desalinharia.

Acao: estender a persona de `agents/requisitos.md` (hoje 5 linhas, `agents/requisitos.md:10-14`) para incluir a tabela de cobertura por-criterio e o desmembramento finding-resumo + findings-bloqueantes. Mantem 1 job, 1 dimensao, custo igual.

### 4.6 Gating e severidade

Mapeamento status -> severidade (a cravar na persona; nao ha campo "status" no codigo, o agente emite `severity` direta P0/P1/P2):

- **NAO_ATENDIDO de criterio em escopo claro do diff -> P1 (bloqueia).** Ja coberto por `agents/requisitos.md:7`. P1 bloqueia porque `decideVerdict` conta `counts.P0 + counts.P1 > 0` como `blocking` e emite `REQUEST_CHANGES` / `failure` (`lib/gatekeeper.ts:310-313`).
- **P0:** a persona de requisitos NAO declara P0 (so P1/P2 em `agents/requisitos.md:6-8`); a calibracao geral define P0 = bug certo / vulnerabilidade / quebra. Recomendacao: requisitos topa em P1; nunca emite P0 a partir de "criterio nao entregue" puro (P0 fica para dano comprovado). P0 e P1 bloqueiam igual no `decideVerdict`, entao a distincao e so de comunicacao.
- **PARCIAL em ponto menor -> P2 (nao bloqueia).** Coberto por `agents/requisitos.md:8`. PARCIAL que descumpre o criterio (impacto funcional) -> P1.
- **NAO_VERIFICAVEL_NO_DIFF -> finding nao emitido (findings:[]) ou no maximo P2 informativo, NUNCA P1.** Nao ha severidade abaixo de P2 no enum (`lib/types.ts:1`).

`decideVerdict` (`lib/gatekeeper.ts:307-316`) so olha contagem por severidade; nao ha logica especial para requisitos ali. NAO adicionar requisitos a `PROCESS_GATE_AGENTS` (`lib/gatekeeper.ts:299`): isso capparia em P2 todo criterio nao atendido (`capProcessGateSeverity`, `lib/gatekeeper.ts:301-305`) e mataria o diferencial.

**Interacao com o REFUTER:** `runAdversarial` (`lib/gatekeeper.ts:357`) refuta falsos-positivos. A clausula de processo do refuter trata "criterio de aceite vindo como bloqueante" como candidato a refutacao, o que e uma ameaca direta: um NAO_ATENDIDO funcional legitimo pode ser morto se o cetico o ler como gate de processo. Mitigacao na persona: cada finding bloqueante DEVE ancorar numa linha adicionada concreta + transcrever o trecho da US, para cair na regra de "ausencia real" (mantem) e nao na de "processo" (refuta). US sem criterio formal vindo como bloqueante DEVE ser refutada, o que ja casa com a clausula de processo e com o no-op da persona (`agents/requisitos.md:13`). Calibrar o checker = ajustar prompt do agente (e, se necessario, a clausula do refuter), jamais adicionar requisitos a `PROCESS_GATE_AGENTS`.

### 4.7 Anti-alucinacao

Camadas que impedem o checker de inventar criterios:

- **No-op sem US.** A secao US so existe quando ha ticket (`jiraSection`, `lib/context-loader.ts:54-57`), e o ticket so carrega com chave + os 3 secrets (`loadJiraTicket`, `lib/agent-runner-cli.ts:113-118`). "Sem chave" e "sem secrets" ambos => prompt sem US. A persona ja instrui no-op (`agents/requisitos.md:13`). Reforcar: sem secao `## US do Jira`, retorne `findings:[]`, nunca derive criterio de titulo, branch ou nome de arquivo do diff.
- **Cite real obrigatoria.** `filterByCite` (`lib/gatekeeper.ts:334`) descarta finding cuja cite nao cobre linha adicionada do diff. Todo NAO_ATENDIDO/PARCIAL bloqueante precisa ancorar numa linha que o diff de fato adicionou.
- **Transcrever o trecho da US na justificativa.** Na `rationale` de cada finding bloqueante, transcrever o trecho literal do criterio que originou o finding: auditavel pelo humano e da material factual ao refuter para distinguir "ausencia real" de "processo".
- **Tabela completa obrigatoria (prova de cobertura).** A persona deve: (a) listar PRIMEIRO todos os criterios numerados detectados; (b) emitir exatamente uma linha de status por criterio, incluindo ATENDIDO e NAO_VERIFICAVEL_NO_DIFF (proibido omitir; criterio nao avaliavel recebe NAO_VERIFICAVEL_NO_DIFF, nunca ausencia); (c) declarar `N criterios detectados` e produzir N linhas (auto-contagem eleva o custo de pular um criterio). Espelhar a linguagem anti-falso-negativo ja usada no prompt ("Examine CADA ... NAO pare no primeiro").

Limite honesto: sem a US estruturada (texto chega achatado), nao ha como GARANTIR mecanicamente cobertura total. A tabela-completa-obrigatoria e a prova mais forte disponivel sem reescrever `adfToText` para preservar a arvore ADF e contar itens em codigo (ver 7 e 9).

## 5. Casos de borda

- **US sem criterio formal.** No maximo P2 observando a lacuna, nunca bloqueia. Ja garantido por `agents/requisitos.md:13` + clausula de processo do refuter. Manter.
- **US dividida em varios PRs (PR parcial).** Criterio cujo escopo nao esta no diff atual = NAO_VERIFICAVEL_NO_DIFF (nao emite, ou P2 informativo), NUNCA NAO_ATENDIDO. O codigo nao detecta "PR parcial" automaticamente; e responsabilidade da persona. Regra a adicionar: "confronte um criterio apenas se o diff toca a area relevante; se depende de codigo fora deste diff, marque NAO_VERIFICAVEL_NO_DIFF e nao emita P1". O `filterByCite` ajuda indiretamente (sem linha `+` o finding morre), mas a instrucao explicita evita que o agente force uma cite irrelevante so para passar o filtro.
- **US gigante (muitos criterios).** Nao ha cap numerico de findings por agente no codigo; existe so a fusao semantica posterior (`consolidateFindings`, `lib/gatekeeper.ts:363-365`) e o `dedupeByLine`. Recomendacao de persona: a tabela cobre TODOS os criterios, mas emitir 1 finding bloqueante apenas para os de maior impacto e agrupar criterios correlatos, em vez de 1 finding por sub-item. Sem isso, US com 20 criterios gera ruido que o consolidador atenua mas nao zera.
- **PR sem chave Jira no titulo.** Dois caminhos independentes: no job `gates`, `lib/jira.ts:74-77` faz `exit 1` com `::error::PR sem chave Jira no titulo` (gate falha por formato, sem precisar de secret). No agente requisitos (job review), `loadJiraTicket` retorna undefined (`lib/agent-runner-cli.ts:116`), o prompt sai sem US e o agente entra em no-op. Ausencia de chave bloqueia no gate, nao no agente.
- **Issuetype = Bug/Task.** Se o enriquecimento 4.2 trouxer `issuetype`, a persona nao cobra "criterio de aceite de US" de Bug; calibra para "o fix entrega o que o ticket descreve". Sem `issuetype`, o checker trata tudo como Story (degradacao aceitavel, nao bloqueante para a feature).
- **Customfield de criterios nao descoberto/ausente.** Se o id do customfield nao for configurado, o checker opera so com a description achatada (comportamento atual melhorado). Nao quebra; so reduz recall em equipes que usam campo dedicado.

## 6. Plano de implementacao em fases (sketch)

- **F0 (secrets, sem codigo):** criar conta de servico Atlassian, gerar API token, setar os 3 secrets org-wide na `freeflowsoftware` com visibilidade "all". Validar rodando o job `gates` num PR de teste (deve passar a checar existencia) e confirmar que o agente requisitos recebe a US. Definir rotina de rotacao.
- **F1 (enriquecimento Jira):** ampliar `fields` em `getIssueContext` (`lib/jira.ts:40`) com `issuetype` (minimo) e, se decidido, o customfield; estender `JiraTicket` (`lib/jira.ts:8-11`); ajustar `jiraSection` (`lib/context-loader.ts:54-57`); preservar `\n` em `adfToText` (`lib/jira.ts:61-68`). Testes unitarios do parser ADF e do mapeamento de campos com fake `JiraClient` (a interface ja existe em `lib/jira.ts:13-18` para isso).
- **F2 (parsing + output):** evoluir a persona de `agents/requisitos.md` para: detectar/segmentar criterios (heuristicas 4.3), emitir a tabela completa no `rationale` de um finding-resumo P2 (`category: cobertura-criterios`), e 1 finding P1 por criterio bloqueante (`category: criterio-nao-atendido`) com transcricao do trecho da US.
- **F3 (gating):** cravar na persona o mapeamento status -> severidade (4.6); ajustar, se necessario, a clausula de processo do refuter para nao matar NAO_ATENDIDO funcional ancorado em linha; confirmar que requisitos segue fora de `PROCESS_GATE_AGENTS`.
- **F4 (testes + docs):** snapshot/contract tests da persona com US fixture (Story com 5 criterios, US sem criterio, PR parcial); validar fim-a-fim que a tabela aparece no comentario inline e que so criterios funcionais nao atendidos bloqueiam; documentar provisionamento e rotacao dos secrets no README do repo central; bump semver (regra de PR Movvia).

## 7. Riscos e trade-offs

- **Refuter mata finding legitimo.** A clausula de processo do refuter cita "criterio de aceite" generico; um NAO_ATENDIDO real pode ser refutado. Mitigado por ancora em linha + transcricao da US, mas e o ponto mais delicado de calibracao e exige iteracao em PRs reais.
- **Sem garantia dura de cobertura.** A prova e estrutural-no-prompt + auto-contagem, nao mecanica. O modelo poderia, em tese, mentir na contagem E na tabela de forma coerente (improvavel com `temperature: 0.1`, nao impossivel). Garantia dura exigiria reescrever `adfToText` para preservar a arvore e conferir contagem em codigo (trabalho adicional, fora do escopo).
- **Customfield por instancia.** O id do campo de criterios de aceite varia; descobri-lo e mante-lo e custo operacional. Sem ele, recall menor em equipes que usam campo dedicado.
- **ADF achatado degrada precisao.** Mesmo com `\n` preservado, tabelas e estruturas complexas do ADF ainda chegam imperfeitas ao LLM.
- **Ruido em US gigante.** Mitigado por agrupamento na persona + consolidador, nao zerado.
- **Custo de token sobe pouco.** Tabela completa + transcricao aumentam o tamanho da saida do agente requisitos; aceitavel (1 agente, 1 job).
- **Falso-positivo bloqueante e P0 de processo.** Se o checker bloquear PR legitimo por ler errado um criterio, treina o time a ignorar o gate (mesmo risco que motivou `capProcessGateSeverity`). Calibracao conservadora (so criterio funcional claramente ausente vira P1) e o anteparo.

## 8. Criterios de aceite desta feature (verificaveis)

- CA1: os 3 secrets Jira existem org-wide na `freeflowsoftware` e o agente requisitos recebe a secao `## US do Jira` no prompt num PR cujo titulo tem chave valida (verificavel nos logs do job review).
- CA2: `getIssueContext` retorna ao menos `issuetype` alem de `summary` e `description`, e `adfToText` emite `\n` entre itens de lista (verificavel por unit test com fake `JiraClient` e fixture ADF).
- CA3: num PR com US de 5 criterios, o comentario do agente requisitos contem uma tabela com 5 linhas, uma por criterio, com status em {ATENDIDO, PARCIAL, NAO_ATENDIDO, NAO_VERIFICAVEL_NO_DIFF}.
- CA4: um criterio funcional explicitamente nao entregue gera um finding P1 que bloqueia o merge (`decideVerdict` -> REQUEST_CHANGES / failure), ancorado em linha real do diff com o trecho da US transcrito.
- CA5: US ausente do contexto (sem chave ou sem secrets) resulta em `findings:[]` do agente requisitos (no-op), nunca em P1.
- CA6: criterio cujo escopo esta fora do diff (PR parcial) recebe NAO_VERIFICAVEL_NO_DIFF e nao bloqueia.
- CA7: nenhuma mudanca em `lib/types.ts`, `lib/post.ts`, `decideVerdict` nem em `PROCESS_GATE_AGENTS`; requisitos continua fora desse set.
- CA8: bump semver presente no PR (regra Movvia).

## 9. Questoes em aberto

- Incluir o customfield de criterios de aceite ja na F1, ou so a description achatada+`\n` na primeira versao? (Depende de descobrir o id via `GET /rest/api/3/field` e de confirmar que as equipes usam campo dedicado.)
- Reescrever `adfToText` para preservar a arvore ADF (garantia dura de cobertura por contagem) entra nesta feature ou fica como follow-up?
- Com os secrets ligados, o job `gates` passa a bloquear PR cuja chave existe de formato mas nao existe no projeto. Isso e desejavel agora, ou manter o gate so em formato ate estabilizar?
- Qual o nome exato do site Jira Cloud da Movvia para `JIRA_BASE_URL`, e ja existe conta de servico Atlassian ou precisa criar?
- A clausula de processo do refuter (que trata "criterio de aceite como bloqueante" como candidato a refutacao) precisa ser editada nesta feature para nao matar NAO_ATENDIDO funcional, ou a ancora-em-linha + transcricao da US bastam?
- Visibilidade dos secrets: "all repositories" (cobre todos os repos que consomem a Action) ou "selected" (so os que rodam review hoje)?
