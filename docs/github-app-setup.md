# GitHub App: movvia-ai-review[bot]

1. Org freeflowsoftware → Settings → Developer settings → GitHub Apps → New.
2. Nome: `movvia-ai-review`. Webhook: off.
3. Permissions (repository): Checks: Read & write; Pull requests: Read & write; Contents: Read.
4. Gerar Private Key (.pem). Anotar App ID.
5. Install no org, em todos os repos pe-*. Anotar o Installation ID (numero no fim da URL `.../installations/<ID>`).
6. Org secrets: REVIEW_APP_ID = App ID; REVIEW_APP_PRIVATE_KEY = conteudo do .pem; REVIEW_INSTALLATION_ID = Installation ID do passo 5. Os tres sao obrigatorios juntos — sem REVIEW_INSTALLATION_ID o auth do App cai silenciosamente para o PAT, e o check run `review-bot/verdict` passa a ser emitido pelo usuario do PAT em vez do App[bot], quebrando o gate de merge do Ruleset (passo 8).
7. REVIEW_PAT = PAT do Pablo (scope repo) — usado so para APPROVE best-effort.
8. No Ruleset, em required_status_checks, travar `review-bot/verdict` com o integration_id deste App.

## Credenciais do LLM (obrigatorias)

O opencode roda os agentes de review e a etapa adversarial do gatekeeper. Ele le o
provider OpenAI-compatible de `opencode.json` (na raiz do repo central), que interpola
`{env:LLM_API_KEY}` e `{env:LLM_BASE_URL}`. Configure como **org secrets**:

- `LLM_API_KEY` (obrigatorio): API key do provider OpenAI-compatible (default Gemini
  Flash-Lite). Sem ela, os jobs `review` e o passo adversarial do `gatekeeper` falham
  por falta de credencial.
- `LLM_BASE_URL` (opcional): endpoint OpenAI-compatible. Se ausente, o workflow usa o
  default do Gemini (`https://generativelanguage.googleapis.com/v1beta/openai`).

O model default (`gemini/gemini-flash-lite`) referencia o provider id `gemini` definido
em `opencode.json`. Para trocar de provider, ajuste `base_url`/`model` via secret/env ou
o `model` no frontmatter do agente.
