---
appliesTo:
  - "**/*.sql"
  - "**/migrations/**"
  - "**/flyway/**"
---

---
description: Regras para migrations SQL do PE (PostgreSQL + Flyway)
globs: **/V*__*.sql, **/migrations/**/*.sql
---

# Flyway Migrations - PE

## NUNCA Use ENUM do PostgreSQL

**Hibernate e Prisma não funcionam bem com `CREATE TYPE ... AS ENUM`.** Isso causa erros como:
- `operator does not exist: tipo_isencao = character varying`

```sql
-- ❌ ERRADO - Causa problemas com ORMs
CREATE TYPE status_pedido AS ENUM ('PENDENTE', 'CONFIRMADO', 'CANCELADO');
CREATE TABLE pedidos (
  status status_pedido NOT NULL
);

-- ✅ CORRETO - Use VARCHAR com CHECK constraint
CREATE TABLE pedidos (
  status VARCHAR(50) NOT NULL CHECK (status IN ('PENDENTE', 'CONFIRMADO', 'CANCELADO'))
);
```

Se um ENUM PostgreSQL já existe e precisa ser removido:
```sql
ALTER TABLE tabela ALTER COLUMN coluna TYPE VARCHAR(50) USING coluna::text;
DROP TYPE IF EXISTS tipo_enum;
```

## Migrations Devem Ser Idempotentes

Use `IF NOT EXISTS` / `IF EXISTS` para que a migration possa ser re-executada sem erros:

```sql
-- ✅ CORRETO
CREATE TABLE IF NOT EXISTS clientes ( ... );
CREATE INDEX IF NOT EXISTS idx_clientes_cpf ON clientes(cpf);

ALTER TABLE passagens ADD COLUMN IF NOT EXISTS valor_taxa DECIMAL(10,2);

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'recargas' AND column_name = 'taxa')
  THEN
    ALTER TABLE recargas ADD COLUMN taxa DECIMAL(10,2);
  END IF;
END $$;

-- ❌ ERRADO - Falha na segunda execução
CREATE TABLE clientes ( ... );
ALTER TABLE passagens ADD COLUMN valor_taxa DECIMAL(10,2);
```

## Convenção de Nomes

- Formato: `V{NNN}__{descricao_snake_case}.sql` (dois underscores após versão)
- Versão com 3 dígitos zero-padded: `V001`, `V002`, ..., `V015`
- Descrição curta e clara: `V016__add_taxa_columns_to_recargas.sql`

## Schema

- PE usa schema `public` (default)
- TPA usa schema `tpa` (configurado via `-schemas=tpa` no Flyway)

## Flyway Baseline (Cuidado!)

- `baselineOnMigrate=true` só deve ser usado quando `flyway_schema_history` não existe no schema alvo
- Após primeira execução bem-sucedida, **remover as flags de baseline**
- HML e PRD podem precisar de configurações diferentes de baseline

## Tipos Recomendados

| Dado | Tipo SQL | Motivo |
|------|----------|--------|
| Valores monetários | `DECIMAL(12,2)` | Precisão exata |
| Percentuais | `DECIMAL(5,2)` | Até 999.99% |
| Status/Enums | `VARCHAR(50)` | Compatível com ORMs |
| IDs internos | `SERIAL` ou `BIGSERIAL` | Auto-incremento |
| IDs externos | `VARCHAR(100)` | UUIDs, IDs de gateway |
| Timestamps | `TIMESTAMPTZ` | Sempre com timezone |
| CPF/CNPJ | `VARCHAR(14)` | Apenas dígitos |
| Placa | `VARCHAR(7)` | Formato Mercosul |
