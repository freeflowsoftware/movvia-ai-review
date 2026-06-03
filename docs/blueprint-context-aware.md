# Blueprint — Review Context-Aware (resolve falso-positivo dando contexto do codebase)

> Gerado por workflow de arquitetura (4 propostas → crítica adversarial → síntese), 2026-06-03.
> Decisão: **determinístico-first GLOBAL + explorador LLM como Fase 2 condicional**. Atende: valor real, ≤$1/run, <5min.

## Problema
Hoje cada agente recebe só `regras + lang-pack + ADRs + US-Jira + DIFF(hunks)`. É **cego ao codebase** → falso-positivo ("validação ausente" num campo que segue o padrão; "teste sem assert" num teste que tem asserts). O valor está em **entender o projeto** (arquivos reais, vizinhos, padrões).

## Por que NÃO explorador agêntico puro
Loop sequencial de tool-calls adiciona ~2,5min no caminho crítico → **estoura os 5min** (crítica: "não cabe", nota 6/10). 90% do valor anti-FP é **determinístico e custa ~$0** de LLM. Explorador LLM vira Fase 2 condicional.

## Constraints (medidos)
- **Custo NÃO é o gargalo:** ~$0.07–0.18/run (Flash-Lite $0.10/$0.40 Mtok; DeepSeek V4 Flash $0.14/$0.28). Folga 5–10× sob $1.
- **Tempo É o gargalo:** baseline ~5min, dominado pelo **setup de cada job** (~50-70s de `npm i -g pnpm + pnpm install`). Só fecha em <5min com a Fase 0.

---

## Fase 0 — Cache de deps (pré-requisito, mergeável sozinho)
Em TODOS os jobs de `ai-review.yml` + `self-test.yml`, trocar `npm i -g pnpm@9 && pnpm install` por:
```yaml
- uses: pnpm/action-setup@v4
  with: { version: 9 }
- uses: actions/setup-node@v4
  with: { node-version: 22, cache: pnpm, cache-dependency-path: <lockfile do job> }
- run: <dir do job> pnpm install --frozen-lockfile --prefer-offline
```
Corta setup de ~50-70s → ~12-18s/job (derruba ~3min do total). `cache-dependency-path` aponta pro `pnpm-lock.yaml` do checkout central (`_review/pnpm-lock.yaml` nos jobs que usam `_review`, `pnpm-lock.yaml` nos que checkout no cwd). Ajustar `tests/workflow-yaml.test.ts` (assert `cache: pnpm`). **Rejeitado:** container pré-buildado (risco operacional com gh/octokit/paths).

## Fase 1 — Context-pack determinístico global (o VALOR)

### `lib/context-pack.ts` (novo, funções puras)
`buildContextPack(repoDir, changedFiles, opts): ContextPack`. Por arquivo alterado, 4 camadas com **cota e corte por prioridade**:

| # | Camada | Como (determinístico, `fs`+regex+`ripgrep`) | Mata qual FP |
|---|--------|----------------------------------------------|--------------|
| 1 | **Arquivo inteiro alterado** | `readFileSync` (não só hunks) — SEMPRE inteiro | "função sem X" quando X está fora do hunk |
| 2 | **Irmãos do diretório** (≤4) | `readdirSync(dirname)` mesma extensão, prioriza mesmo sufixo (`*.service.ts`) | "validação ausente" quando o padrão local não valida |
| 3 | **Imports intra-repo** (≤6, 1 nível) | regex `import…from '…'` (TS), `import x.y.z` (Java), `from x import` (Py); só relativos; resolve `tsconfig.paths` p/ aliases `@pe/*`,`@/*` | "API/método inventado" — vê a assinatura real |
| 4 | **N exemplares do mesmo tipo** (≤3) | glob por sufixo (`*.dto.ts`,`*.spec.ts`); escolhe maior LOC (mais maduros) | "teste sem assert" — vê o `*.spec.ts` exemplar |

- **Cap rígido** (`context_pack.max_tokens` ~100k). Corte por prioridade: alterado > irmãos > imports > exemplos.
- **Skeletonização** (assinaturas via regex) de arquivos >400 LOC, EXCETO o alterado (sempre inteiro).
- **Degradação graciosa:** erro de parse → pack vazio, nunca quebra o pipeline. "Vizinho não resolvido NUNCA vira evidência de ausência" (mitiga falso-negativo).
- Suíte vitest por linguagem (TS/Java/Py).

### Integração
- `lib/context-pack-cli.ts` (novo): `<repoDir> <diffPath>` → `ContextPack` JSON em stdout.
- `lib/context-loader.ts`: `UserPromptParts` ganha `contextPack?: string`; `buildUserPrompt` injeta a seção `## CONTEXTO DO CODEBASE` **entre ADRs e DIFF** (regra documentada acima do padrão observado). `buildSystemPrompt` ganha 1 linha: *"Use o CONTEXTO DO CODEBASE para confirmar se o que parece ausente já segue o padrão do repo ANTES de reportar. Regra documentada vence padrão observado: se uma .claude/rule exige X, reporte mesmo que os vizinhos não façam X."*
- `lib/agent-runner-cli.ts`: 4º argv `packPath`; `loadContextPack` (lê JSON, seleciona seções dos `changedFiles`); passa ao `buildUserPrompt`. Preserva early-return de `agentMatchesPaths`.
- `config/defaults.yml`: `context_pack: { max_tokens: 100000, max_siblings: 4, max_imports: 6, max_exemplars: 3, skeleton_loc_threshold: 400 }`.
- `.github/workflows/ai-review.yml`: job `context-pack` (`needs: discover`, checkout `fetch-depth:0` alvo + central + diff + run CLI + `upload-artifact name=context-pack`). `review` passa a `needs: [discover, context-pack]` + `download-artifact` + 4º argv. Testes do job/needs/download.

## Fase 2 — Refuter context-aware + explorador condicional (incremento)
- `lib/gatekeeper.ts`: `buildRefuteUserPrompt(f, packExcerpt?)` injeta o trecho do pack do `f.file`; entrypoint faz `download-artifact context-pack`. Fecha o ciclo anti-FP (cético refuta com base factual).
- **Explorador (condicional):** se `(arquivo com <2 irmãos E <2 imports resolvidos)`, 1 chamada Flash-Lite que recebe `git ls-files` filtrado + símbolos e **seleciona** 2-3 paths (não lê — o código lê). Instrumentar taxa de disparo.

## Instrumentação (medir os 3 constraints)
- **Custo:** `realChatRunner` parseia `data.usage` (`prompt_tokens`/`completion_tokens`); somar × preço → `$GITHUB_STEP_SUMMARY`. Alerta >$0.30/run.
- **Tempo:** timestamps por job → breakdown no `post`. Alerta total >4min.
- **FP-rate (prova o valor):** A/B via `context_pack.max_tokens: 0` (off) vs ligado no mesmo PR; classificar inline comments resolved/dismissed (FP) vs addressed (TP) via `gh api`.

## Riscos principais
- **Tempo estoura sem Fase 0** → Fase 0 é bloqueante, antes da Fase 1.
- **Anti-padrão normalizado** ("vizinhos têm `any`, agente para de reportar") → pack DEPOIS das regras + persona "regra vence padrão".
- **Resolução de imports frágil** (aliases, Java classpath) → best-effort; não-resolvido ≠ ausência.
