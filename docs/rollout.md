# Rollout

1. Criar org secrets + GitHub App (docs/github-app-setup.md).
2. Piloto: copiar caller-template para 1 repo pe-* (ex: pe-bff-portal); rodar so em `develop`.
3. Rodar em paralelo ao CodeRabbit por 2 sprints; medir FP rate e overlap.
4. Aplicar Ruleset no piloto (`docs/ruleset.md`), so `review-bot/verdict` + `gates` como required.
5. Calibracao: ativar amostra Sonnet 4.6 em ~5% dos PRs; ajustar threshold do gatekeeper.
6. Expandir caller para todos os pe-*; depois CNL/CSG.
7. Desligar CodeRabbit quando FP rate <= baseline.
8. Promover ADR-001 para `status: approved` e mover para movvia-engineering-docs.

## Seguranca de forks (obrigatorio antes do piloto)

O caller (`caller-template.yml`) usa `secrets: inherit` para repassar os org secrets
(LLM_API_KEY, REVIEW_APP_PRIVATE_KEY, REVIEW_PAT, JIRA_API_TOKEN) ao workflow reutilizavel.
O branch `issue_comment` ja exige PR + autor membro (`author_association` em
OWNER/MEMBER/COLLABORATOR), mas isso por si so nao protege o branch `pull_request` de
forks. Para defesa em profundidade, **desligar na org `freeflowsoftware`** a opcao
"Send write tokens to workflows from fork pull requests" e "Send secrets to workflows
from fork pull requests" (Settings > Actions > General > Fork pull request workflows from
outside collaborators). Sem isso, um PR de fork ainda receberia o `GITHUB_TOKEN` de escrita
e poderia, dependendo da config, alcancar secrets.
