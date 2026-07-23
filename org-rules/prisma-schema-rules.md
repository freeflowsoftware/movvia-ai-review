---
appliesTo:
  - "**/schema.prisma"
  - "**/*.prisma"
---

---
description: Regras para schema.prisma — tipos, enums e convencoes de campos
globs: "**/schema.prisma"
---

# Regras do Schema Prisma

## Regra Critica: NUNCA Usar Enum Nativo

**NUNCA use `enum` nativo do PostgreSQL no schema.prisma.** Causa problemas com Prisma Client e incompatibilidade com Hibernate (servicos Java compartilham o mesmo banco).

```prisma
// ❌ ERRADO - Enum nativo do PostgreSQL
enum StatusRecarga {
  PENDENTE
  CONFIRMADA
  CANCELADA
  EXPIRADA
}

model Recarga {
  id     Int            @id @default(autoincrement())
  status StatusRecarga
}

// ✅ CORRETO - String com VarChar
model Recarga {
  id     Int    @id @default(autoincrement())
  status String @db.VarChar(50) // PENDENTE, CONFIRMADA, CANCELADA, EXPIRADA
}
```

Valide no codigo da aplicacao (DTO com class-validator ou constantes tipadas).

## Tipos de Campos

```prisma
// ✅ CORRETO - Decimal com precisao adequada
model Conta {
  saldo_atual       Decimal @db.Decimal(12, 2)
  saldo_bloqueado   Decimal @db.Decimal(12, 2) @default(0)
}

// ❌ ERRADO - Float perde precisao em valores financeiros
model Conta {
  saldo_atual Float
}
```
### Timestamps

```prisma
// ✅ CORRETO - Sempre com timezone
model Recarga {
  criado_em    DateTime @default(now()) @db.Timestamptz
  atualizado_em DateTime @updatedAt @db.Timestamptz
}

// ❌ ERRADO - Sem timezone causa problemas com fusos horarios
model Recarga {
  criado_em    DateTime @default(now()) @db.Timestamp
}
```

### Documentos (CPF/CNPJ)

```prisma
// ✅ CORRETO - Apenas digitos, sem formatacao
model Cliente {
  cpf  String @db.VarChar(14) // 11 digitos CPF ou 14 digitos CNPJ
}

// ❌ ERRADO - Tamanho excessivo ou tipo errado
model Cliente {
  cpf String @db.Text
}
```

### Placa de Veiculo

```prisma
// ✅ CORRETO - Formato Mercosul (7 caracteres)
model Veiculo {
  placa String @db.VarChar(7)
}

// ❌ ERRADO
model Veiculo {
  placa String // sem restricao de tamanho
}
```

### IDs Externos (Gateways, APIs)

```prisma
// ✅ CORRETO - VarChar amplo para UUIDs e IDs de terceiros
model Pagamento {
  gateway_id       String? @db.VarChar(100)
  transaction_id   String? @db.VarChar(100)
}

// ❌ ERRADO - Tamanho fixo pode truncar IDs de gateways
model Pagamento {
  gateway_id String? @db.VarChar(36)
}
```

### Status e Tipos (substituto de enum)

```prisma
// ✅ CORRETO - VarChar(50) com comentario dos valores validos
model Pedido {
  status          String @db.VarChar(50) // PENDENTE, PROCESSANDO, CONCLUIDO, CANCELADO
  metodo_pagamento String @db.VarChar(50) // PIX, CARTAO_CREDITO, BOLETO
}
```

## CHECK constraints: NAO reportar ausencia no schema.prisma (anti-falso-positivo)

**O `schema.prisma` NAO expressa CHECK constraints.** O Prisma nao tem sintaxe para
`CHECK (status IN (...))`; o DDL do banco (incluindo CHECKs, triggers, indices parciais)
vive no repo **separado `pe-migrations`** (Flyway, fonte de verdade do DDL). O `schema.prisma`
apenas espelha as tabelas para o Prisma Client.

Portanto, ao revisar um `schema.prisma`:

- **NAO reporte "falta CHECK constraint" / "campo status sem validacao no banco"** contra o
  `.prisma`. A CHECK provavelmente JA existe na migration correspondente do `pe-migrations`
  (que NAO esta no diff deste repo). Ausencia de CHECK no `.prisma` e **esperada**, nao um defeito.
- O padrao correto no `.prisma` e `String @db.VarChar(N) // VALOR1, VALOR2, ...` — a integridade
  a nivel de banco fica na migration Flyway; a validacao a nivel de app fica no DTO/constantes.
- So reporte se a evidencia estiver NO DIFF (ex.: uma migration `.sql` no diff criando a coluna
  sem CHECK). Nao infira ausencia de algo que mora em outro repositorio.

```prisma
// ✅ CORRETO no .prisma — a CHECK vive em pe-migrations/Vxxx__....sql, NAO aqui
model ConsultaAlertaEmail {
  status String @db.VarChar(20) // ATIVO, OPT_OUT, CANCELADO — CHECK na migration Flyway
}
```

## Referencia

Alinhado com `flyway-migrations.md` para consistencia entre Prisma e Flyway.
