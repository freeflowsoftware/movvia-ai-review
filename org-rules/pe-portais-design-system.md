---
appliesTo:
  - "**/*.tsx"
  - "**/pe-portais/**"
---

---
description: Reutilizar componentes e utils dos packages compartilhados @pe/ui e @pe/shared-lib no monorepo pe-portais
globs: pedagio-eletronico/pe-portais/apps/**/*.tsx, pedagio-eletronico/pe-portais/apps/**/*.ts
---

# Design System - Monorepo pe-portais

## Regra Principal

**ANTES de criar qualquer componente, hook, utilitário ou tipo em um app, verificar se já existe em `@pe/ui` ou `@pe/shared-lib`.**

Se existir, usar o compartilhado. Se não existir mas for reutilizável, criar no package compartilhado.

## Packages Disponíveis

### @pe/ui - Componentes UI Base

```typescript
// Componentes (shadcn/radix)
import { Button, Card, Input, Label, Skeleton, Badge, Table, Dialog, Sheet, Tabs, Separator, Avatar, DropdownMenu, Select, Checkbox, RadioGroup, Switch, Textarea, Tooltip, Popover, Calendar, Command } from '@pe/ui';

// Hooks de UI
import { useToast, toast } from '@pe/ui/hooks';

// Utilitários
import { cn, formatCurrency, formatDate, formatDateTime, formatPlaca, formatCPF, formatCNPJ } from '@pe/ui/utils';

// Providers
import { QueryProvider, AuthProvider } from '@pe/ui/providers';

// Types
import type { ApiResponse, ApiError, PaginatedResponse } from '@pe/ui/types';

// HTTP Client
import { ApiClient } from '@pe/ui/lib';
```

### @pe/shared-lib - Lógica de Negócio Compartilhada

```typescript
// Hooks de negócio
import { useTransacao, usePedidos, usePixPedido, useCartaoPedido, useViaCep, useTurnstile, useCreditCardForm } from '@pe/shared-lib';

// API factory (parametrizada com AxiosInstance)
import { createBffApi } from '@pe/shared-lib';

// Contexts
import { ConsultaProvider, useConsulta } from '@pe/shared-lib';
import { CookieConsentProvider, useCookieConsent } from '@pe/shared-lib';
import { UsuarioProvider, useUsuario } from '@pe/shared-lib';
import { PortalConfigProvider, usePortalConfig, ApiProvider, useApi } from '@pe/shared-lib';

// Validações Zod
import { cpfSchema, cnpjSchema, emailSchema, veiculoSchema } from '@pe/shared-lib';

// Utilitários
import { formatDocumento, isValidCPF, isValidCNPJ, getTipoDocumento } from '@pe/shared-lib';

// Componentes compartilhados de negócio
import { Faq, CookieConsentButton, CookieConsentModal } from '@pe/shared-lib';
import { PagamentoResultado, PassagensSelecionadasAccordion, PedidoEmProcessamentoModal } from '@pe/shared-lib';

// PDF
import { generateComprovantePdf } from '@pe/shared-lib';

// Types
import type { Pedido, Transacao, Pendencia, StatusPedido, MetodoPagamento } from '@pe/shared-lib';
```

## Checklist Antes de Criar

1. Precisa de um componente UI? → Verifique `@pe/ui`
2. Precisa de formatação (moeda, data, placa)? → Use `@pe/ui/utils`
3. Precisa de um hook de dados (fetch/mutate)? → Verifique `@pe/shared-lib`
4. Precisa de validação Zod? → Verifique `@pe/shared-lib`
5. Precisa de um componente de negócio (FAQ, Pagamento)? → Verifique `@pe/shared-lib`

## Apps no Monorepo

| App | Porta | Propósito |
|-----|-------|-----------|
| `pe-portal` | 3003 | Portal público PE |
| `pe-portal-cnl` | 3004 | Portal white-label CNL |
| `pe-portal-backoffice` | 3007 | Backoffice interno |
| `pe-portal-concessionaria` | 3008 | Portal concessionárias |
| `pe-portal-camanducaia` | 3005 | Portal white-label Camanducaia |

## Não Faça

- Não crie `cn()` ou `formatCurrency()` localmente - já existem em `@pe/ui/utils`
- Não crie componentes UI base (Button, Card, Input) localmente - use `@pe/ui`
- Não duplique hooks de fetch entre apps - centralize em `@pe/shared-lib`
- Não copie tipos de API entre apps - use `@pe/ui/types`
- Não instale shadcn/ui diretamente em apps - use via `@pe/ui`

## Tema e Cores

Use CSS variables do tema, não cores hardcoded:

```tsx
// ✅ CORRETO
<button className="bg-theme-primary hover:bg-theme-primary-hover">

// ❌ ERRADO
<button className="bg-violet-600 hover:bg-violet-700">
```

Variáveis: `--color-primary`, `--color-primary-hover`, `--color-primary-light`, `--color-primary-dark`
