# RUNBOOK — Configurar o GitHub App `movvia-ai-review[bot]`

Passo a passo para criar e ligar o GitHub App que dá identidade própria ao bot. Hoje o piloto roda com o `GITHUB_TOKEN` nativo (review sai como `COMMENT`, gate via check run já funciona). O App é necessário para:

- o **review formal** `REQUEST_CHANGES`/`APPROVE` **contar** no branch protection;
- **travar** o check `review-bot/verdict` a esta origem via `integration_id` no Ruleset (ninguém forja);
- identidade própria (`movvia-ai-review[bot]`) em vez de `github-actions[bot]`/`pablowinck`.

---

## Dá para fazer tudo via `gh` CLI?

**Quase.** A única parte que **não** é CLI é a **criação do App** (não existe `gh app create`) e a **geração da private key** — exigem 1 passo no browser (UI) ou o *App Manifest flow* (que ainda abre uma URL para autorizar). Tudo o resto é `gh`/API:

| Etapa | Via |
|---|---|
| Criar o App | **Browser** (UI) ou Manifest flow (semi-browser) |
| Gerar private key (.pem) | **Browser** (botão na página do App) |
| Instalar o App nos repos | Browser ou API |
| Pegar App ID / Installation ID | `gh api` |
| Setar secrets (`REVIEW_APP_*`) | `gh secret set` |
| Ruleset travando o check | `gh api` |

---

## Passo 1 — Criar o App (browser, ~2 min)

Abra: `https://github.com/organizations/freeflowsoftware/settings/apps/new`

Preencha:
- **GitHub App name:** `movvia-ai-review`
- **Homepage URL:** `https://github.com/freeflowsoftware/movvia-ai-review`
- **Webhook → Active:** **DESMARQUE** (não usamos webhook).
- **Repository permissions:**
  - **Checks:** Read and write
  - **Pull requests:** Read and write
  - **Contents:** Read-only
  - (Metadata: Read-only — automático)
- **Where can this GitHub App be installed?** *Only on this account*.

Clique **Create GitHub App**. Anote o **App ID** (aparece no topo da página do App).

## Passo 2 — Gerar a private key

Na página do App → seção **Private keys** → **Generate a private key**. Um arquivo `.pem` é baixado. Guarde o caminho local (ex.: `~/Downloads/movvia-ai-review.YYYY-MM-DD.private-key.pem`).

## Passo 3 — Instalar o App

Página do App → **Install App** → `freeflowsoftware` → escolha os repos:
- para o piloto: `movvia-ai-review`
- para o rollout: adicione `pe-api-core`, `pe-bff-portal`, etc. (ou *All repositories*).

Após instalar, a URL termina em `.../installations/<INSTALLATION_ID>` — esse número é o **Installation ID** (também dá para pegar via CLI no passo 5).

---

## Passo 4 — O que me enviar (aí eu faço o resto via `gh`)

Me passe **apenas**:
1. **App ID** (número, não é segredo).
2. Confirmação de que instalou o App em `movvia-ai-review`.

**A private key (.pem) NÃO cole no chat** (vira segredo exposto no transcript/memória). Em vez disso, **você** seta o secret direto do arquivo:

```bash
gh secret set REVIEW_APP_PRIVATE_KEY \
  --repo freeflowsoftware/movvia-ai-review \
  < ~/Downloads/movvia-ai-review.<data>.private-key.pem
```

## Passo 5 — Eu configuro o resto via `gh` (com o App ID)

```bash
# App ID (você me passa)
gh secret set REVIEW_APP_ID --repo freeflowsoftware/movvia-ai-review --body "<APP_ID>"

# Installation ID — pego automaticamente a partir do App (precisa de um JWT do App,
# ou via a private key). Caminho mais simples: listar instalações do App:
#   GET /app/installations  (autenticado como App)
# Alternativa sem JWT: a instalação do repo aparece em:
gh api repos/freeflowsoftware/movvia-ai-review/installation --jq '.id'
# -> esse id é o INSTALLATION_ID:
gh secret set REVIEW_INSTALLATION_ID --repo freeflowsoftware/movvia-ai-review --body "<INSTALLATION_ID>"
```

> O endpoint `repos/{owner}/{repo}/installation` exige token com permissão; se falhar, me mande o Installation ID da URL do passo 3.

## Passo 6 — Trocar o caller para usar o App (já suportado no código)

Nada a mudar no código: o `post.ts` já detecta `REVIEW_APP_ID + REVIEW_APP_PRIVATE_KEY + REVIEW_INSTALLATION_ID` e passa a mintar o installation token automaticamente (em vez do `GITHUB_TOKEN`). O review então sai como **REQUEST_CHANGES/APPROVE** de `movvia-ai-review[bot]`.

## Passo 7 — Ruleset travando o check pelo App (via `gh api`)

Depois do App ligado, registramos o check como obrigatório, travado à origem do App (`integration_id = App ID`):

```bash
gh api -X POST repos/freeflowsoftware/<repo>/rulesets --input - <<'JSON'
{
  "name": "ai-review-gate",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main","refs/heads/develop"], "exclude": [] } },
  "rules": [
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1, "require_code_owner_review": true,
        "dismiss_stale_reviews_on_push": true, "require_last_push_approval": true,
        "allowed_merge_methods": ["squash","merge"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [
          { "context": "review-bot/verdict", "integration_id": <APP_ID> },
          { "context": "gates" }, { "context": "ci/build" }
        ] } }
  ]
}
JSON
```

---

## Alternativa quase-CLI: App Manifest Flow (opcional)

Para minimizar UI, dá para criar o App via *manifest*: você abre uma URL pré-preenchida (1 clique), o GitHub redireciona com um `code` temporário, e:

```bash
gh api -X POST app-manifests/<code>/conversions --jq '{id, pem: .pem, client_id}'
```

retorna o **App ID** e a **private key** de uma vez. Ainda exige abrir a URL no browser para autorizar — mas elimina o preenchimento manual do formulário. Posso gerar o HTML/manifest se você preferir esse caminho.

---

## Checklist final

- [ ] App criado em `freeflowsoftware` (Checks RW, PRs RW, Contents RO, sem webhook)
- [ ] Private key gerada e setada como `REVIEW_APP_PRIVATE_KEY` (você, via `<` do .pem)
- [ ] App instalado em `movvia-ai-review` (+ repos pe-* no rollout)
- [ ] `REVIEW_APP_ID` + `REVIEW_INSTALLATION_ID` setados (eu, via `gh`)
- [ ] Re-rodar `/ai-review` num PR → review agora sai como `movvia-ai-review[bot]` REQUEST_CHANGES
- [ ] Ruleset com `integration_id` aplicado nos repos
