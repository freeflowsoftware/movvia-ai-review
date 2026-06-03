---
appliesTo:
  - "**/*.ts"
---

---
description: Padrões de teste Jest/NestJS para os serviços PE
globs: **/*.spec.ts
---

# NestJS Testing Patterns - PE

## Setup do TestingModule

Sempre use `Test.createTestingModule` com mocks manuais (não `@nestjs/testing` auto-mock):

```typescript
import { Test, TestingModule } from '@nestjs/testing';

// Mocks definidos FORA do describe, reutilizáveis
const mockPrismaService = {
  recarga: { findUnique: jest.fn(), create: jest.fn(), update: jest.fn() },
  pagamento: { create: jest.fn(), updateMany: jest.fn() },
  $transaction: jest.fn(),
  $queryRaw: jest.fn(),
};

const mockRedisClient = {
  get: jest.fn(),
  setex: jest.fn(),
  set: jest.fn(),
  del: jest.fn(),
};

const mockLockService = {
  acquireWithRetry: jest.fn(),
  release: jest.fn(),
};

describe('MeuService', () => {
  let service: MeuService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MeuService,
        { provide: PrismaService, useValue: mockPrismaService },
        { provide: LockService, useValue: mockLockService },
        { provide: REDIS_CLIENT, useValue: mockRedisClient },
      ],
    }).compile();

    service = module.get<MeuService>(MeuService);
    jest.clearAllMocks();
  });
});
```

## Padrão de Mock do Prisma.$transaction

```typescript
// Mock que executa o callback passando o tx mock
mockPrismaService.$transaction.mockImplementation(async (callback) => {
  return await callback({
    recarga: {
      findUnique: jest.fn().mockResolvedValue(mockRecarga),
      update: jest.fn().mockResolvedValue(mockRecargaAtualizada),
      create: jest.fn().mockResolvedValue(mockRecargaCriada),
    },
    pagamento: {
      create: jest.fn().mockResolvedValue({}),
    },
  });
});
```

## Padrão de Mock do Redis (REDIS_CLIENT)

O Redis é injetado via `@Inject(REDIS_CLIENT)`, não via `RedisService`:

```typescript
{ provide: REDIS_CLIENT, useValue: mockRedisClient }
```

## Cenários Obrigatórios

Para todo service financeiro, teste:

1. **Fluxo feliz** - operação completa com sucesso
2. **Idempotência (Redis cache)** - retorna resultado cacheado
3. **Idempotência (DB)** - retorna registro existente no banco
4. **Entidade não encontrada** - lança `NotFoundException`
5. **Validação de negócio** - lança `BadRequestException`
6. **Lock release no finally** - lock é liberado mesmo com erro
7. **Falha compensatória** - ex: estorno quando DB falha após gateway aprovar

## Convenções

- Nomes de teste em português: `it('deve criar recarga PIX com sucesso', ...)`
- Um `describe` por método público
- `jest.clearAllMocks()` no `beforeEach`
- Use `Decimal` do Prisma para valores monetários nos mocks
- Assertions com `toHaveBeenCalledWith(expect.objectContaining({...}))` para verificar parâmetros parciais
- Spy no logger para verificar logs de erro: `jest.spyOn(service['logger'], 'error')`

## Não Faça

- Não use `jest.mock()` global - prefira injeção manual
- Não importe módulos reais do NestJS (ConfigModule, etc.) - mock tudo
- Não teste implementação interna (métodos privados) - teste via métodos públicos
- Não ignore erros assíncronos - use `rejects.toThrow()`
