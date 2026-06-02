# GitHub App: movvia-ai-review[bot]

1. Org freeflowsoftware → Settings → Developer settings → GitHub Apps → New.
2. Nome: `movvia-ai-review`. Webhook: off.
3. Permissions (repository): Checks: Read & write; Pull requests: Read & write; Contents: Read.
4. Gerar Private Key (.pem). Anotar App ID.
5. Install no org, em todos os repos pe-*. Anotar o Installation ID (numero no fim da URL `.../installations/<ID>`).
6. Org secrets: REVIEW_APP_ID = App ID; REVIEW_APP_PRIVATE_KEY = conteudo do .pem; REVIEW_INSTALLATION_ID = Installation ID do passo 5. Os tres sao obrigatorios juntos — sem REVIEW_INSTALLATION_ID o auth do App cai silenciosamente para o PAT, e o check run `review-bot/verdict` passa a ser emitido pelo usuario do PAT em vez do App[bot], quebrando o gate de merge do Ruleset (passo 8).
7. REVIEW_PAT = PAT do Pablo (scope repo) — usado so para APPROVE best-effort.
8. No Ruleset, em required_status_checks, travar `review-bot/verdict` com o integration_id deste App.
