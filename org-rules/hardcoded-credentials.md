---
# Transversal: aplica a qualquer diff (sem appliesTo).
---

---
description: NUNCA incluir credenciais, tokens, senhas ou API keys hardcoded no codigo fonte
globs: "**/*.ts, **/*.java, **/*.yml, **/*.yaml, **/*.properties"
---

# Credenciais Hardcoded - Proibido

## REGRA CRITICA

**Check de ERROR no CodeRabbit — bloqueia merge automaticamente.**

Tokens, senhas, API keys e segredos NUNCA devem estar no codigo fonte. Devem vir de variaveis de ambiente ou Config Server.

## Padroes Proibidos

Strings que serao detectadas como credenciais:
- `Bearer eyJ...`, `sk-...`, `aws_secret_access_key`
- `password = "..."`, `token = "..."`, `apiKey = "..."`
- URLs com credenciais inline: `postgres://user:senha@host`
- Arquivos `.env` commitados (devem estar no `.gitignore`)

## NestJS (TypeScript)

```typescript
// ✅ CORRETO - Usar ConfigService para acessar variaveis de ambiente
@Injectable()
export class MeuService {
  constructor(private readonly configService: ConfigService) {}

  async chamarApi() {
    const apiKey = this.configService.get<string>('API_KEY');
    const token = this.configService.get<string>('AUTH_TOKEN');
    return this.httpService.get(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
  }
}

// ❌ ERRADO - Credencial hardcoded no codigo
@Injectable()
export class MeuService {
  private readonly apiKey = 'sk-abc123def456ghi789';

  async chamarApi() {
    return this.httpService.get(url, {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.xxxx' },
    });
  }
}
```

## Spring Boot (Java)

```yaml
# ✅ CORRETO - Variavel de ambiente no application.yml
spring:
  datasource:
    url: ${DATABASE_URL}
    username: ${DATABASE_USERNAME}
    password: ${DATABASE_PASSWORD}

app:
  celcoin:
    client-secret: ${CELCOIN_CLIENT_SECRET}
```

```yaml
# ❌ ERRADO - Credenciais em plain text
spring:
  datasource:
    url: jdbc:postgresql://prod-db:5432/movvia
    username: admin
    password: SuperSecreta123!

app:
  celcoin:
    client-secret: a1b2c3d4-e5f6-7890-abcd-ef1234567890
```

```java
// ✅ CORRETO - Injetar do application.yml
@Value("${app.celcoin.client-secret}")
private String clientSecret;

// ❌ ERRADO - Hardcoded no Java
private static final String CLIENT_SECRET = "a1b2c3d4-e5f6-7890";
```

## Arquivos .env

```gitignore
# ✅ CORRETO - .env no .gitignore
.env
.env.local
.env.production
```

- Commitar apenas `.env.example` com valores placeholder
- Valores reais devem ser configurados no ambiente (K8s Secrets, CI/CD vars)

## Ferramentas de Deteccao

O CodeRabbit usa **gitleaks** e **trufflehog** para detectar credenciais em PRs. Se detectado:
1. O PR sera bloqueado automaticamente
2. Remova a credencial do codigo
3. Rotacione a credencial comprometida (ela ja esta no historico do Git)
4. Use `git filter-branch` ou BFG Repo-Cleaner se necessario limpar o historico
