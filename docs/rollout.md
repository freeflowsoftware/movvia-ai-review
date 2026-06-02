# Rollout

1. Criar org secrets + GitHub App (docs/github-app-setup.md).
2. Piloto: copiar caller-template para 1 repo pe-* (ex: pe-bff-portal); rodar so em `develop`.
3. Rodar em paralelo ao CodeRabbit por 2 sprints; medir FP rate e overlap.
4. Aplicar Ruleset no piloto (`docs/ruleset.md`), so `review-bot/verdict` + `gates` como required.
5. Calibracao: ativar amostra Sonnet 4.6 em ~5% dos PRs; ajustar threshold do gatekeeper.
6. Expandir caller para todos os pe-*; depois CNL/CSG.
7. Desligar CodeRabbit quando FP rate <= baseline.
8. Promover ADR-001 para `status: approved` e mover para movvia-engineering-docs.
