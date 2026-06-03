---
appliesTo:
  - "**/*.java"
  - "**/application*.yml"
  - "**/application*.yaml"
  - "**/*.properties"
---

---
description: Regras para arquivos de configuracao Spring Boot (application.yml, application.properties)
globs: "**/application*.yml, **/application*.properties"
---

# Regras de Configuracao Spring Boot

## Config Server URI

O Spring Cloud Config Server **DEVE** incluir o context path `/config`. Sem ele, retorna 404.

```yaml
# ✅ CORRETO - Com context path /config
spring:
  config:
    import: optional:configserver:http://pe-config-service.pedagio-eletronico.svc.cluster.local:80/config

# ❌ ERRADO - Falta o /config, retorna 404
spring:
  config:
    import: optional:configserver:http://pe-config-service.pedagio-eletronico.svc.cluster.local:80
```

Para desenvolvimento local:

```yaml
# ✅ CORRETO - Config server local
spring:
  config:
    import: optional:configserver:http://localhost:8888/config
  profiles:
    active: local
```

## Credenciais e Segredos

**NUNCA** incluir valores sensiveis em plain text. Usar variaveis de ambiente.

```yaml
# ✅ CORRETO - Variaveis de ambiente
spring:
  datasource:
    url: ${DATABASE_URL:jdbc:postgresql://localhost:5432/movvia}
    username: ${DATABASE_USERNAME:postgres}
    password: ${DATABASE_PASSWORD:postgres}

app:
  celcoin:
    client-id: ${CELCOIN_CLIENT_ID}
    client-secret: ${CELCOIN_CLIENT_SECRET}

# ❌ ERRADO - Credenciais expostas
spring:
  datasource:
    url: jdbc:postgresql://prod-rds.amazonaws.com:5432/movvia_prod
    username: movvia_admin
    password: S3nh@Pr0duc40!
```

O valor apos `:` no placeholder `${VAR:default}` e o fallback local. Use apenas para ambiente de desenvolvimento.

## Perfis de Ambiente

Usar perfis para separar configuracoes por ambiente:

```yaml
# ✅ CORRETO - Perfis bem definidos
# application.yml (base)
spring:
  profiles:
    active: ${SPRING_PROFILES_ACTIVE:local}

# application-local.yml (desenvolvimento)
# application-hml.yml (homologacao)
# application-prd.yml (producao)
```

```yaml
# ❌ ERRADO - Config de producao no arquivo base
spring:
  datasource:
    url: jdbc:postgresql://prod-host:5432/db
```

## Configs Sensiveis de Producao

- Configs de `prd` devem estar no Config Server ou K8s Secrets
- **NUNCA** commitar `application-prd.yml` com dados reais
- Use `optional:` no import do Config Server para nao falhar em dev local

```yaml
# ✅ CORRETO - optional permite rodar sem Config Server
spring:
  config:
    import: optional:configserver:http://config-server:80/config

# ❌ ERRADO - Falha se Config Server indisponivel
spring:
  config:
    import: configserver:http://config-server:80/config
```

## Referencia

Regras complementares em `deploy-cicd-patterns.md` para configuracao de CD e ArgoCD.
