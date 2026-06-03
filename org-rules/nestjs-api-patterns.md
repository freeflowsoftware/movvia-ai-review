---
appliesTo:
  - "**/*.ts"
---

---
description: Padrões obrigatórios para APIs NestJS do PE (pe-api-core, pe-api-banking, pe-bff-portal, pe-gateway-api, pe-api-notification)
globs: **/*.service.ts, **/*.controller.ts, **/*.module.ts, **/*.dto.ts
---

# NestJS API Patterns - Pedágio Eletrônico

## Envelope de Resposta

O BFF e Gateway já aplicam envelope automaticamente via interceptor. **NUNCA** construa envelope manualmente no controller.

```typescript
// ❌ ERRADO - Envelope manual no controller
@Get()
async listar() {
  const data = await this.service.listar();
  return { success: true, data, meta: { timestamp: new Date() } };
}

// ✅ CORRETO - Retorne dados puros, interceptor faz o envelope
@Get()
async listar() {
  return this.service.listar();
}
```

## Headers Obrigatórios em Comunicação Inter-Serviço

Toda chamada HTTP entre serviços PE deve incluir:

```typescript
headers: {
  'X-Internal-Service-Key': this.configService.get('INTERNAL_SERVICE_KEY'),
  'X-Correlation-ID': correlationId, // propagado do request original
}
```

## Idempotência

Operações de escrita (POST de pagamentos, recargas, webhooks) **DEVEM** implementar idempotência:

1. Receber `idempotencyKey` no DTO ou gerar a partir de campos únicos
2. Verificar cache Redis primeiro: `redis.get(idempotencyKey)`
3. Se cache hit, retornar resultado cacheado
4. Processar operação
5. Cachear resultado: `redis.setex(idempotencyKey, TTL, resultado)`

Padrão de referência: `pe-api-banking/src/modules/webhook/webhook.service.ts`

```typescript
// Padrão de idempotência
const idempotencyKey = `idemp:${dominio}:${identificadorUnico}`;
const cached = await this.redis.get(idempotencyKey);
if (cached) return JSON.parse(cached);

// ... processar ...

await this.redis.setex(idempotencyKey, 86400, JSON.stringify(response));
```

## Guards (Autenticação e Autorização)

O pe-api-core define vários guards reutilizáveis:

| Guard | Uso |
|-------|-----|
| `JwtAuthGuard` | Rotas autenticadas (Bearer token + check blacklist) |
| `OptionalJwtGuard` | Auth opcional (não lança se token ausente) |
| `ApiKeyGuard` | Totem/device auth via `X-Api-Key` header |
| `InternalServiceGuard` | Comunicação inter-serviço via `X-Internal-Service-Key` |
| `JwtOrInternalGuard` | Aceita JWT OU service key (para BFF → Core) |
| `BackofficeJwtGuard` | JWT customizado para backoffice (HMAC SHA256) |
| `AdminGuard` | Role-based para admin |

Combine guards conforme necessário:
```typescript
@UseGuards(JwtOrInternalGuard)
@Get('internal/passagens')
async buscarInterno() { ... }
```

## Controllers

- Use decorators de validação do `class-validator` nos DTOs
- Use `ParseIntPipe`, `ParseUUIDPipe` em parâmetros de rota
- Retorne tipos tipados (nunca `any`)
- Use `@HttpCode()` para POST que não retorna 201

## Services

- Injete dependências via constructor (nunca `@Inject` direto em propriedade)
- Use `Logger` do NestJS (nunca `console.log`)
- Operações financeiras devem usar `Prisma.$transaction()` com timeout explícito
- Erros de negócio devem usar exceções NestJS (`NotFoundException`, `BadRequestException`, etc.)

## DTOs

- Sempre use `class-validator` decorators para validação
- Separe DTOs de request e response
- Use `@ApiProperty()` do Swagger para documentação
- Tipos Prisma (`Decimal`, enums) devem ser convertidos no DTO, não no controller

## Prisma

- Use `$transaction()` para operações que envolvem múltiplas tabelas
- Defina timeout explícito em transações longas: `{ timeout: 30000 }`
- Use `$queryRaw` apenas quando Prisma Client não suporta a query
- Nunca exponha o PrismaService diretamente no controller
