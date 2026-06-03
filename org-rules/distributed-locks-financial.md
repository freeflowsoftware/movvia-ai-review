---
appliesTo:
  - "**/*.ts"
---

---
description: Locks distribuídos obrigatórios para operações financeiras no pe-api-banking
globs: **/*.service.ts
---

# Distributed Locks - Operações Financeiras

## Regra Crítica

**TODA operação que altera saldo, confirma pagamento, ou processa recarga DEVE usar lock distribuído via `LockService`.**

Race conditions em operações financeiras causam inconsistência de saldo e são bugs P0.

## LockService API

Referência: `pe-api-banking/src/infrastructure/redis/lock.service.ts`

```typescript
import { LockService } from '../../infrastructure/redis/lock.service';

// Injeção
constructor(private readonly lockService: LockService) {}

// Adquirir lock com retry (padrão para operações financeiras)
const lock = await this.lockService.acquireWithRetry(
  `conta:${contaId}`,  // chave do recurso
  3,                    // maxRetries
  100,                  // retryDelay ms
  30000,                // TTL ms
);

try {
  // Operação protegida aqui
  await this.prisma.$transaction(async (tx) => { ... });
} finally {
  // SEMPRE liberar lock no finally
  await this.lockService.release(lock);
}
```

## Convenção de Chaves de Lock

| Recurso | Chave | Quando usar |
|---------|-------|-------------|
| Conta (saldo) | `conta:{contaId}` | Crédito, débito, consulta-para-débito |
| Recarga | `recarga:{recargaId}` | Confirmação de recarga |
| Pagamento | `pagamento:{pagamentoId}` | Confirmação de pagamento |
| Liquidação | `liquidacao:{contaId}` | Liquidação automática de passagens |

## Padrão Obrigatório

```typescript
// ✅ CORRETO - Lock + Transaction + Finally
const lockConta = await this.lockService.acquireWithRetry(`conta:${contaId}`);
try {
  const resultado = await this.prisma.$transaction(async (tx) => {
    // operações atômicas aqui
  }, { timeout: 30000 });
  return resultado;
} finally {
  await this.lockService.release(lockConta);
}

// ❌ ERRADO - Sem lock em operação de saldo
await this.prisma.$transaction(async (tx) => {
  const conta = await tx.conta.findUnique({ where: { id: contaId } });
  await tx.conta.update({
    where: { id: contaId },
    data: { saldo_atual: conta.saldo_atual + valor },
  });
});

// ❌ ERRADO - Lock sem finally (leak se houver exceção)
const lock = await this.lockService.acquireWithRetry(`conta:${contaId}`);
await this.processarOperacao();
await this.lockService.release(lock);
```

## Múltiplos Locks

Quando uma operação requer locks em múltiplos recursos, adquira-os em ordem consistente para evitar deadlock:

```typescript
// Adquira locks sempre na mesma ordem: recurso específico → conta
const lockRecarga = await this.lockService.acquireWithRetry(`recarga:${recargaId}`);
const lockConta = await this.lockService.acquireWithRetry(`conta:${contaId}`);
try {
  // ...
} finally {
  // Libere na ordem inversa
  await this.lockService.release(lockConta);
  await this.lockService.release(lockRecarga);
}
```

## TTL Guidelines

- Operações simples (débito/crédito): 10s
- Operações com liquidação (pode processar N passagens): 30s
- Se a operação pode exceder o TTL, use `lockService.extend()` dentro do loop
