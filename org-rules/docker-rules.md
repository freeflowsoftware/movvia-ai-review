---
appliesTo:
  - "**/Dockerfile"
  - "**/docker-compose*.yml"
  - "**/.dockerignore"
---

---
description: Regras para Dockerfile e docker-compose — build seguro e eficiente
globs: **/Dockerfile, **/*.Dockerfile, **/docker-compose*.yml
---

# Docker — Build Seguro e Eficiente

## Multi-stage Build Obrigatório

Toda imagem de produção DEVE usar multi-stage build para reduzir tamanho e superfície de ataque.

```dockerfile
# ✅ CORRETO - Multi-stage build
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:22-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
CMD ["node", "dist/main.js"]

# ❌ ERRADO - Single stage com tudo junto
FROM node:latest
WORKDIR /app
COPY . .
RUN npm install
CMD ["npm", "run", "start"]
```

## Imagens Base com Tag Específica

**NUNCA use `:latest`.** Sempre fixe a versão para builds reproduzíveis.

```dockerfile
# ✅ CORRETO
FROM node:22-alpine
FROM eclipse-temurin:21-jre-alpine

# ❌ ERRADO
FROM node:latest
FROM openjdk:latest
```

## Não Copie Artefatos Desnecessários

Use `.dockerignore` e nunca copie `node_modules`, `.env`, `.git` para a imagem.

```dockerignore
# .dockerignore obrigatório
node_modules
.env
.env.*
.git
.gitignore
dist
target
*.md
```

```dockerfile
# ❌ ERRADO - Copia .env e node_modules para dentro da imagem
COPY . .
RUN npm run build
```

## docker-compose: Variáveis de Ambiente

Nunca hardcode credenciais ou secrets no `docker-compose.yml`.

```yaml
# ✅ CORRETO - Variáveis via .env ou referência
services:
  api:
    image: pe-api-core:${IMAGE_TAG}
    env_file:
      - .env
    environment:
      - DATABASE_URL=${DATABASE_URL}

# ❌ ERRADO - Credenciais hardcoded
services:
  api:
    environment:
      - DATABASE_URL=postgresql://admin:senha123@db:5432/mydb
      - JWT_SECRET=minha-chave-super-secreta
```

## Portas e Volumes

Sempre declare portas explicitamente e use named volumes para dados persistentes.

```yaml
# ✅ CORRETO - Named volume + porta explícita
services:
  postgres:
    image: postgres:16-alpine
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:

# ❌ ERRADO - Bind mount para dados persistentes em produção
services:
  postgres:
    volumes:
      - ./data:/var/lib/postgresql/data
```
