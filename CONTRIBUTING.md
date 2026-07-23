# Contribuindo com agentes de review

Para adicionar um novo agente paralelo:

1. Copie `agents/_SCHEMA.md` para `agents/<minha-dimensao>.md`.
2. Preencha o frontmatter (`name` kebab-case unico, `dimension`, `model` opcional, `paths` opcional, `severity_hints`).
3. Escreva a persona em PT-BR: o que avaliar, exigir cite `[arquivo:linha]`, "nao inventar API".
4. Rode local: `npx tsx scripts/validate-agents.ts agents` e `npx vitest run`.
5. Abra PR. O `self-test` valida frontmatter + tipos + testes.
6. Apos merge e tag `@v1.x`, todos os repos ganham o agente no proximo PR — sem editar YAML.

Trocar o modelo de um agente: campo `model:` (ex.: `deepseek/deepseek-chat`). Vazio = default do CI (Gemini Flash-Lite).

## Como adicionar um caso de eval (promptfoo)

A esteira de eval (`promptfooconfig.yaml`) roda cada persona pelo CLI real de review sobre
diffs rotulados e afere recall (positivos)/precisao (negativos) + "faz sentido" (llm-rubric).
O workflow `prompt-eval` roda em todo PR (para poder ser required check sem travar), mas so
executa o eval de fato quando o PR altera algum arquivo que compoe o prompt — personas
(`agents/**`), regras compartilhadas (`org-rules/**`, `lang-packs/**`), a montagem
(`lib/context-loader.ts`, `lib/agent-runner-cli.ts`, `lib/run-agent.ts`, `lib/discover.ts` e
afins), `config/defaults.yml`, `promptfooconfig.yaml`, `evals/**` ou as proprias fixtures.

Para adicionar um caso, crie uma pasta em `tests/fixtures/eval/<caso>/` com dois arquivos:

1. `diff.patch` — um unified diff git (linhas `+++ b/<caminho>`) com o codigo a revisar.
2. `expected.json`:
   - Positivo: `{ "agent": "seguranca", "positive": true, "expected": [{ "file": "...", "severity": "P0" }], "note": "..." }` — o match e por arquivo (a dimensao ja e implicita pelo agente); `severity` fica como nota.
   - Negativo (anti falso-positivo): `{ "agent": "testes", "positive": false, "expected": [], "note": "..." }` — o agente nao pode levantar finding P0/P1 (severidades bloqueantes); P2 informativo e tolerado.

Nenhum registro extra e necessario: `evals/tests.mjs` varre a pasta e gera um teste por caso.

Rodar local (exige `LLM_BASE_URL` e `LLM_API_KEY` no ambiente):

```bash
pnpm eval          # matriz pass/fail + relatorio
pnpm eval:ci       # sem barra de progresso (usado no CI)
```
