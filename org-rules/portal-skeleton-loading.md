---
appliesTo:
  - "**/*.tsx"
---

---
description: Toda página do pe-portais DEVE ter loading state com Skeleton, NUNCA spinner genérico
globs: pedagio-eletronico/pe-portais/apps/*/app/**/*.tsx
---

# Skeleton Loading States - PE Portais

## Regra Obrigatória

**TODA nova página DEVE ter um `loading.tsx`** no mesmo diretório, usando skeletons do `@pe/ui`.

**NUNCA use spinner genérico, texto "Carregando..." ou tela em branco como loading state.**

## Componentes Disponíveis

Importar de `@pe/ui` (NÃO criar localmente):

```typescript
import { Skeleton } from '@pe/ui';
```

Importar do app (componentes compostos):

```typescript
import { PageSkeleton, TableSkeleton, CardSkeleton, DetailsSkeleton } from '@/components/shared/page-skeleton';
```

## Variantes e Quando Usar

| Componente | Quando usar |
|-----------|------------|
| `PageSkeleton` | Páginas com tabela (listagens) |
| `PageSkeleton` com `showCards` | Páginas com métricas + tabela |
| `TableSkeleton` | Apenas a tabela (dentro de tabs, por ex.) |
| `CardSkeleton` | Apenas cards de métricas |
| `DetailsSkeleton` | Páginas de detalhe de item |

## Padrão loading.tsx

```typescript
// app/(dashboard)/clientes/loading.tsx
import { PageSkeleton } from '@/components/shared/page-skeleton';

export default function Loading() {
  return <PageSkeleton rows={8} showHeader showCards cardCount={3} />;
}
```

```typescript
// app/(dashboard)/clientes/[id]/loading.tsx
import { DetailsSkeleton } from '@/components/shared/page-skeleton';

export default function Loading() {
  return <DetailsSkeleton />;
}
```

## Suspense Boundaries

Quando usar `<Suspense>` em Server Components, o fallback DEVE ser um skeleton:

```typescript
// ✅ CORRETO
<Suspense fallback={<TableSkeleton rows={5} />}>
  <TabelaPassagens />
</Suspense>

// ❌ ERRADO
<Suspense fallback={<div>Carregando...</div>}>
  <TabelaPassagens />
</Suspense>

// ❌ ERRADO
<Suspense fallback={<Spinner />}>
  <TabelaPassagens />
</Suspense>
```

## Client Components com useQuery

```typescript
// ✅ CORRETO
const { data, isLoading } = useClientes();
if (isLoading) return <TableSkeleton rows={5} />;

// ❌ ERRADO
if (isLoading) return <p>Carregando...</p>;
```

## Referência

Componente base: `pe-portais/apps/pe-portal-backoffice/components/shared/page-skeleton.tsx`
