# movvia-ai-review

PR reviewer multi-agente in-house da Movvia. Repo central importado pelos CI/CDs via reusable workflow.

- **1 `agents/*.md` = 1 agente = 1 job paralelo** (matrix dinamica).
- Gatekeeper: cite-the-line (anti-alucinacao) + verificacao adversarial + scoring → veredicto P0/P1/P2.
- Gates de dominio Movvia: Jira (US obrigatoria) + ADR + `.claude/rules`.
- Bloqueio: check run `review-bot/verdict` (GitHub App) + CODEOWNERS + approve PAT best-effort.
- Multi-modelo barato via opencode (default Gemini Flash-Lite, trocavel por agente).

## Usar num repo
Copie `.github/caller-template.yml` para `.github/workflows/ai-review.yml`. Configure os org secrets (ver `docs/github-app-setup.md`). Aplique o Ruleset (`docs/ruleset.md`).

## Contribuir
Ver `CONTRIBUTING.md`. Re-rodar review num PR: comente `/ai-review` (ou `/ai-review --full`).
