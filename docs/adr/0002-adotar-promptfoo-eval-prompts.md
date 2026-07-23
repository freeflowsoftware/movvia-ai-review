---
title: "Adotar promptfoo como esteira de eval de prompts (gate bloqueante)"
category: adr
status: Proposta
product: pe
owner: antoniosrt
created: 2026-07-20
updated: 2026-07-20
supersedes: []
related: ["docs/ADR-001-ai-review-inhouse.md"]
confidence: medium
---

# ADR-0002: Esteira de eval de prompts com promptfoo

## Contexto

O `movvia-ai-review` bloqueia merges com base no julgamento de agentes LLM (`agents/*.md`).
Hoje o CI valida só a **estrutura** dos agentes (`scripts/validate-agents.ts`) e lógica
determinística (vitest). **Não há avaliação da qualidade dos prompts**: editar uma persona
ou a montagem do prompt (`lib/context-loader.ts`) pode degradar recall/precisão do gate sem
que nada acuse. Como o produto é um gate de review de código fintech, uma regressão de prompt
silenciosa vira falso-negativo (deixa passar problema real) ou falso-positivo (trava merge bom).

O candidato #01 da auditoria (`docs/auditoria-review-ia/01-esteira-eval-prompts.md`) propôs um
harness caseiro de record/replay. Esta ADR decide usar uma ferramenta consolidada no lugar.

## Decisão

Adotar o [promptfoo](https://www.promptfoo.dev/) como esteira de eval de prompts, com:

- **Provider** que reusa o CLI existente `lib/agent-runner-cli.ts` (roda a persona real sobre
  um diff e devolve `{agent, findings[]}`), exportando `AGENT_MODEL` a partir do frontmatter.
- **Fixtures** de diff rotuladas (`tests/fixtures/eval/<caso>/`: `diff.patch` + `expected.json`),
  com casos positivos e negativos (anti falso-positivo).
- **Assertions** determinísticas (recall/precisão/severidade sobre o JSON de findings) **e**
  `llm-rubric` (grader `deepseek/deepseek-v4-flash`) para "o rationale/cita faz sentido?".
- **Gate bloqueante desde já**: um novo workflow (`.github/workflows/prompt-eval.yml`) roda
  em todo PR (para poder ser required check sem o deadlock de path-filter) e, por um step de
  detecção, só executa o eval quando o PR altera arquivos que compõem o prompt (personas,
  `org-rules/**`, `lang-packs/**`, a montagem em `lib/*`, `config/defaults.yml`,
  `promptfooconfig.yaml`, `evals/**`, fixtures). Abaixo do limiar, reprova o CI. Escopo v1 = as 7 personas atuais.

Os modelos são os já configurados (`LLM_BASE_URL`/`LLM_API_KEY`; `google/gemini-2.5-flash-lite`
default e `deepseek/deepseek-v4-flash` para raciocínio) — promptfoo não introduz modelo novo.

## Alternativas consideradas

- **Harness caseiro de record/replay (candidato #01):** controle total, sem dependência
  externa; porém reimplementa matriz de casos, cache, relatório e grading que o promptfoo já
  entrega. Mais código para manter.
- **Só `llm-rubric` (LLM julga tudo):** flexível, mas caro e não-determinístico; asserts sobre
  o JSON estruturado de findings são mais estáveis e baratos para recall/precisão.
- **Eval offline puro (replay/cache sem rede):** determinístico e grátis, mas não valida um
  prompt *novo* — o objetivo é revalidar exatamente quando o prompt muda, o que exige executá-lo.

## Por que não manter só o self-test atual

O `self-test.yml` prova que o código não quebrou, não que o **comportamento do prompt**
continua bom. São garantias ortogonais; falta a de qualidade.

## Consequências

- Nova devDependency (`promptfoo`) e um workflow que consome tokens do LLM em PRs que tocam
  prompt (limitado por gatilho de path + cache do promptfoo).
- PR de fork que toque prompt e não receba o secret **falha o gate** (decisão explícita do time).
- Depende de model IDs válidos (candidatos 07/08): `config/defaults.yml` ainda tem o ID legado
  morto `gemini/gemini-flash-lite`; o default de runtime real é `google/gemini-2.5-flash-lite`.
- O limiar bloqueante deve ser calibrado a partir de um baseline medido antes de exigir o check.

> Status `Proposta`: promover para `Aceita` só com confirmação humana. Mudança de rumo cria um
> novo ADR com `supersedes`.
