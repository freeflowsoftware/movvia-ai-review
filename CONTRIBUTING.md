# Contribuindo com agentes de review

Para adicionar um novo agente paralelo:

1. Copie `agents/_SCHEMA.md` para `agents/<minha-dimensao>.md`.
2. Preencha o frontmatter (`name` kebab-case unico, `dimension`, `model` opcional, `paths` opcional, `severity_hints`).
3. Escreva a persona em PT-BR: o que avaliar, exigir cite `[arquivo:linha]`, "nao inventar API".
4. Rode local: `npx tsx scripts/validate-agents.ts agents` e `npx vitest run`.
5. Abra PR. O `self-test` valida frontmatter + tipos + testes.
6. Apos merge e tag `@v1.x`, todos os repos ganham o agente no proximo PR — sem editar YAML.

Trocar o modelo de um agente: campo `model:` (ex.: `deepseek/deepseek-chat`). Vazio = default do CI (Gemini Flash-Lite).
