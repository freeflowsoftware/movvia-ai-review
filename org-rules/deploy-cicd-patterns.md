---
appliesTo:
  - "**/*.yml"
  - "**/*.yaml"
  - "**/Dockerfile"
  - "**/kustomization*.yaml"
  - "**/k8s/**"
  - "**/.github/workflows/**"
---

---
description: Regras críticas para workflows CI/CD e manifests ArgoCD do PE
globs: **/.github/workflows/*.yml, **/*argocd/**/*.yaml, **/overlays/**/*.yaml
---

# Deploy & CI/CD Patterns - PE

## Branch Push (CRÍTICO!)

No CD workflow, ao usar o Smart-Transportation/push action, **SEMPRE** configure a branch:

```yaml
# ✅ CORRETO - Push para a branch correta
- uses: Smart-Transportation/push@v1
  with:
    branch: ${{ github.ref }}
    # ...

# ❌ ERRADO - Push vai para master independente da branch origem
- uses: Smart-Transportation/push@v1
  with:
    # branch não especificada = master
```

**Sem essa config, kustomization.yaml é atualizado em `master` mas ArgoCD usa `develop` → ImagePullBackOff**

## Config Server URI

Nos manifests e configs de aplicação, o Spring Cloud Config Server **DEVE** ter o context path `/config`:

```yaml
# ✅ CORRETO
spring:
  config:
    import: optional:configserver:http://pe-config-service.pedagio-eletronico.svc.cluster.local:80/config

# ❌ ERRADO - Retorna 404
spring:
  config:
    import: optional:configserver:http://pe-config-service.pedagio-eletronico.svc.cluster.local:80
```

## Repositórios ArgoCD

Ao adicionar repositório privado ao ArgoCD:
- O URL no Secret **DEVE** usar SSH: `git@github.com:freeflowsoftware/<repo>.git`
- Secret precisa da label `argocd.argoproj.io/secret-type: repository`

## Namespaces

### Pedágio Eletrônico

| Serviço | Namespace |
|---------|-----------|
| pe-api-core, pe-config-service, pe-bff-portal, pe-gateway-api | `pedagio-eletronico` |
| tpa-api-core, tpa-bff-dashboard, tpa-api-relatorios | `tpa` |
| ArgoCD applications e secrets | `argocd` |

## Workflow Structure

CI e CD devem ser workflows separados:
- **CI**: build + test (roda em PRs e push)
- **CD**: build image + push ECR + update kustomization (roda só em push para develop/main)

## Kustomization

- Image tag deve usar o SHA do commit: `newTag: sha-${GITHUB_SHA::7}`
- Manifests ficam em `pe-argocd/<app>/overlays/<env>/`

## Checklist Pós-Commit

1. Verificar CI/CD: `gh run list --repo freeflowsoftware/<repo> --branch <branch> --limit 3`
2. Verificar ArgoCD sync: `kubectl get application <app> -n argocd`
3. Verificar rollout: `kubectl rollout status deployment/<app> -n <ns>`
4. Verificar logs: `kubectl logs -n <ns> -l app=<app> --tail=100`
