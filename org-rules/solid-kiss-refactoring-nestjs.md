---
appliesTo:
  - "**/*.ts"
---

# SOLID + KISS — Guidelines de Refactoring para serviços **NestJS** do PE

> ⚠️ **ESCOPO: APENAS NEST.JS**
>
> Este documento se aplica **exclusivamente** aos serviços NestJS do PE:
> - `pe-api-core`
> - `pe-api-banking`
> - `pe-api-notification`
> - `pe-bff-portal`
>
> **NÃO se aplica aos serviços Java/Spring Boot** (`pe-gateway-api`, `pe-processador-concessionaria`, `pe-config-service`, `tpa-api-core`), que já adotam **Hexagonal Architecture / Clean Architecture / Ports & Adapters** corretamente — veja `.claude/rules/processador-clean-arch.md`. Os Java mantêm `domain/application/adapter` com use cases, ports de output, etc. Não migre os Java para o padrão Nest e nem o contrário.
>
> A razão da divergência é deliberada: o ecossistema Spring Boot tem ferramental e cultura para Hexagonal pleno; o ecossistema NestJS tem cultura mais próxima do Express/Spring MVC clássico, e forçar Hexagonal em Nest gera cerimônia desproporcional ao ganho.

---

## Premissa

> SOLID dá os 5 princípios. KISS é o juiz que impede SOLID virar arquitetura astronáutica. Quando SOLID e KISS brigam, **KISS ganha**.
>
> Estas regras existem para evitar dois extremos nos serviços Nest do PE: (1) god services de 1.800 LOC e (2) hexagonal completo com 10 arquivos por CRUD. O alvo é o meio: classes pequenas, concretas, com responsabilidades claras, sem abstrações especulativas.

---

## Os 5 princípios SOLID releídos para os Nest do PE

### S — Single Responsibility
**Como aplicamos:** 1 classe por verbo de negócio (`DebitarSaldoService`, `ConfirmarRecargaService`, `ProcessarWebhookPagamentoHandler`). Não 1 classe por entidade gigante (`TransacoesService` fazendo crédito + débito + bloqueio + extrato).

**Como NÃO aplicamos:** quebrar em 12 micro-classes só pra ficar bonito. SRP é "uma razão para mudar", não "uma operação por classe".

### O — Open/Closed
**Como aplicamos:** abstração só quando existem **2+ implementações vivas**. Hoje só Pagar.me está pleno em produção; Celcoin é fallback parcial. Quando o terceiro gateway entrar, aí sim cria `IPaymentGateway`. Antes disso é YAGNI.

**Como NÃO aplicamos:** criar interface para 1 implementação "porque um dia pode mudar".

### L — Liskov Substitution
**Como aplicamos:** **composição > herança** sempre. Os Nest do PE praticamente não usam herança — mantém assim.

**Como NÃO aplicamos:** criar `BaseFinancialService extends BaseService`. Zero novas hierarquias.

### I — Interface Segregation
**Como aplicamos:** ISP nos Nest do PE é **consequência** de aplicar SRP bem. Quando você quebra a classe certo, as interfaces ficam pequenas naturalmente.

**Como NÃO aplicamos:** criar 4 interfaces para 1 classe gigante. Quebre a classe, não a interface.

### D — Dependency Inversion
**Como aplicamos:** DIP **só na borda externa** do sistema — onde substituição é plausível em ≤2 anos: `LockService` (Redis pode mudar), gateways de pagamento, fila externa, providers de email/SMS.

**Como NÃO aplicamos:** abstrair `PrismaService`. Não vamos trocar de ORM, e Prisma já é uma camada. Idem para `ConfigService`, `Logger`, `HttpService`.

---

## Por que NÃO Hexagonal completo nos Nest (e SIM nos Java)

| Aspecto | Nest do PE | Java do PE |
|---|---|---|
| Padrão atual | Module + Controller + Service + Prisma | `domain/application/adapter` com ports |
| Cultura do ecossistema | Express/Spring MVC clássico | Hexagonal é norma em Spring Boot moderno |
| Ferramental | DI nativo do Nest, decorators | ArchUnit, profiles, Spring DI |
| Separação domínio/infra | Implícita (service + Prisma) | Explícita (entity vs JPA entity) |
| ROI de Hexagonal pleno | Baixo — 6-10 arquivos por feature | Alto — separação JPA/Domain é necessária |
| Decisão | **Refactoring tático SRP+KISS** | **Manter Hexagonal** |

**Não tente importar padrões cross-stack.** O `pe-processador-concessionaria` (Java) deve continuar com `application/port/output`, `adapter/inbound/rabbitmq`, etc. O `pe-api-banking` (Nest) deve continuar com `module/service/controller` + quebra por SRP quando o service crescer.

---

## As 8 heurísticas KISS (regras objetivas para PR review nos Nest)

### 1. Regra dos 500/7 — **gatilho de quebra**

> Classe com **>500 LOC** OU **>7 dependências injetadas** no constructor = quebrar **antes** do próximo PR de feature naquele arquivo.

**Como medir:**
```bash
wc -l src/modules/<modulo>/<arquivo>.service.ts
grep -c "private readonly" src/modules/<modulo>/<arquivo>.service.ts
```

**O que fazer:** identificar 2-4 responsabilidades distintas e criar classes irmãs no mesmo módulo Nest. Não inventar `domain/application/infrastructure`.

**Exemplo PE:**
- ❌ `WebhookService` (1.488 LOC, 5 deps)
- ✅ `WebhookRouter` + `WebhookPagamentoHandler` + `WebhookRecargaHandler` + `WebhookEstornoHandler` (todos `@Injectable()` no mesmo módulo)

---

### 2. Regra das 3 implementações — **gatilho de abstração**

> Só crie interface (`IXxx`) quando existem **2+ classes** que a implementam **hoje**, ou quando há requisito formal de ter a 2ª em ≤6 meses.
>
> **1 implementação = classe concreta com nome bem escolhido.**

**Exemplo PE:**
- ❌ `IClienteRepository` com 1 impl Prisma — desnecessário no Nest
- ✅ `ILockRepository` — Redis hoje, mas há discussão de migrar para outro lock manager
- ✅ `IPaymentGateway` — quando Celcoin virar full + Pagar.me coexistirem em produção

---

### 3. Regra da borda — **onde DIP entra nos Nest**

> Abstração só onde o serviço Nest **toca o mundo externo**: gateway de pagamento, lock distribuído, fila/Kafka, provider de email/SMS, storage S3.
>
> **Por dentro do serviço, classes concretas Nest comuns.**

**Exemplo PE:**
- ✅ Borda: `IPaymentGateway`, `ILockRepository`, `IEmailProvider`, `ISmsProvider`
- ❌ Interno: `IClienteService`, `IPedidoMapper`, `IRecargaValidator`

---

### 4. Regra do switch — **gatilho de Strategy**

> `switch`/`if` por **tipo** dentro de método com **3+ casos** = quebrar em classes Strategy (1 por caso).
>
> 2 casos = `if` simples está OK.

**Exemplo PE:**
- ❌ `webhook.service.processarWebhook()` com 9 branches `switch (event.type)`
- ✅ `WebhookHandlerRegistry` injeta um `Map<EventType, WebhookHandler>` e despacha

---

### 5. Regra do shared — **o que vai para `@pe/nest-shared`**

> Só vai para pacote compartilhado código **100% idêntico** entre repos Nest. **90% similar fica local.**

**Razão:** semelhança não é igualdade. Forçar 90% pra shared cria acoplamento e força todo mundo a refatorar simultaneamente quando uma mudança é necessária.

**Exemplo PE:**
- ✅ `InternalServiceGuard` (idêntico em pe-api-core e pe-api-banking)
- ✅ `PlateConverter` (167 linhas idênticas)
- ❌ `TransformInterceptor` (94% similar — divergiu por boa razão; manter local)
- ❌ `DataMaskingInterceptor` (banking não tem `Reflector`, core tem — divergência intencional)

---

### 6. Regra do verbo — **nomes de classe**

> Nome de classe Nest = **verbo de negócio em português ou substantivo concreto**, não jargão arquitetural.

**Exemplo PE:**
- ✅ `DebitarSaldoService`, `ConfirmarRecargaService`, `WebhookPagamentoHandler`
- ❌ `DebitOperationCommandHandler`, `RecargaConfirmationCommand`, `WebhookEventDispatcherImpl`

**Razão:** o time é PT-BR e o domínio é financeiro brasileiro. Inglês astronáutico atrapalha onboarding.

> Nota: nos Java do PE, nomes podem seguir convenção Hexagonal (`ProcessarPassagemUseCase`, `PassagemRepositoryPort`) — isso é OK lá, é a cultura do stack.

---

### 7. Regra do bug ≠ refactor — **separação no PR**

> Bug se conserta com **fix mínimo**, não com refactor arquitetural. Refactor vai em PR separado.

**Por quê:** misturar fix de bug com refactor (a) atrasa o fix urgente e (b) torna o PR irreviewable.

**Exemplo PE:**
- ❌ "Fix HMAC ausente + extrair WebhookHandler + adicionar testes" em 1 PR
- ✅ PR1: adiciona validação HMAC com 1 teste. PR2 (próxima sprint): refator de WebhookService.

---

### 8. Regra do comentário — **smell test de simplicidade**

> Se você precisa de **>5 linhas de comentário** para explicar a abstração, ela não é simples. Reescreva direto.
>
> Exceção: comentários explicando **regra de negócio** ou **decisão de compliance** (ex: "valor mínimo de R$ 5 conforme contrato Celcoin").

---

## Decisões de arquitetura derivadas (apenas Nest)

### O que os Nest do PE FAZEM
1. Classes Nest comuns, injeção de dependência padrão.
2. Service por verbo de negócio quando o agregado fica grande.
3. Strategy para `switch` por tipo (3+ casos).
4. Interface (port) **só na borda externa** + **só com 2+ implementações**.
5. `@pe/nest-shared` para código 100% idêntico (guards, interceptors básicos, utils).
6. VOs locais por serviço onde há regra de negócio (`Saldo`, `Dinheiro` em banking).
7. Validação de DTO via `class-validator`.
8. Testes unitários com mocks manuais via `Test.createTestingModule` (já é o padrão).

### O que os Nest do PE NÃO FAZEM
1. ❌ Hexagonal completo (`domain/application/infrastructure` em cada módulo) — **isso é dos Java**.
2. ❌ Use-case classe para CRUDs simples.
3. ❌ Ports de input para CRUDs (`IFindClientePort` etc.).
4. ❌ Repositórios in-memory paralelos a Prisma.
5. ❌ Mappers Entity↔DTO↔UseCase↔Presenter (4 representações).
6. ❌ VOs em `@pe/shared` carregando lógica financeira.
7. ❌ Abstração de `PrismaService`, `ConfigService`, `Logger`, `HttpService`.
8. ❌ Herança entre services.
9. ❌ Nomes em inglês astronáutico (`*CommandHandler`, `*UseCaseImpl`).
10. ❌ Big-bang de refactor — sempre incremental, PR pequeno.

---

## Como aplicar em PR review (Nest apenas)

**Checklist obrigatório (CodeRabbit + reviewer humano) para PRs em `pe-api-*` e `pe-bff-*`:**

- [ ] Nenhum arquivo novo ou modificado ultrapassa 500 LOC (ou tem PR de quebra agendado)
- [ ] Nenhuma classe nova tem >7 dependências injetadas
- [ ] Nenhuma interface nova foi criada sem 2+ implementações
- [ ] Nenhum `switch` por tipo com 3+ casos foi introduzido sem Strategy
- [ ] Nenhum código foi movido para `@pe/nest-shared` sem ser 100% idêntico
- [ ] Nomes de classe seguem regra do verbo
- [ ] Bug fix não está misturado com refactor no mesmo PR
- [ ] Abstrações criadas estão na borda externa do sistema, não no interior
- [ ] Nenhum `extends` foi introduzido em service/handler

> ⚠️ **PRs em repos Java (`pe-gateway-api`, `pe-processador-*`, `tpa-*`) NÃO usam este checklist.** Lá vale `.claude/rules/processador-clean-arch.md` e `.claude/rules/java-testing-patterns.md`.

---

## Antipadrões observados nos Nest do PE (não repetir)

| Antipadrão | Onde aparece | Como evitar |
|---|---|---|
| God service (>1.500 LOC) | `WebhookService`, `TransacoesService`, `PagarmeService` (banking); `pedidos.service`, `auth.service`, `backoffice-sac.service` (core) | Regra 1 + 4 |
| Switch por tipo | `webhook.processarWebhook` (9 branches) | Regra 4 |
| Duplicação cross-repo | `InternalServiceGuard`, `PlateConverter`, `BandeiraNormalizer` | Regra 5 |
| `: any` em código de produção | 201 ocorrências em pe-api-core | Lint rule |
| `console.log` em produção | 6 arquivos pe-api-core | Lint rule |
| `$transaction` sem timeout | repasse-processor, backoffice-financeiro | Lint rule |
| `Number(decimal)` em valores monetários | `webhook.service.ts` em estornos | Lint rule + Decimal puro |
| Service injeta service que injeta service (cadeia 3+) | `pedidos → passagens → pagamentos` | Regra 1 (quebrar antes) |

---

## Quando estas regras NÃO se aplicam (mesmo dentro dos Nest)

- **Código de teste:** specs podem ser longas, com mocks verbosos. SRP/KISS aplicam dentro do `it()`, não no arquivo todo.
- **Migrations Prisma/Flyway:** scripts SQL não são código orientado a objetos.
- **Configuração:** `app.module.ts`, `main.ts`, `*.config.ts` podem ter muitas dependências por natureza.
- **DTOs e tipos:** arquivos só com `class XxxDto` ou `interface YyyResponse` não contam para LOC.

---

## Referências cruzadas

**Nest (este documento):**
- `.claude/rules/nestjs-api-patterns.md` — padrão Nest do PE (envelope, guards, idempotência)
- `.claude/rules/nestjs-testing-patterns.md` — padrão de testes (mocks manuais, sem in-memory)
- `.claude/rules/distributed-locks-financial.md` — DIP aplicado a locks (regra 3)
- `.claude/rules/prisma-schema-rules.md`
- `docs/analise-migracao-hexagonal-pe-nestjs-rev2.md` — análise que motivou estas regras

**Java (NÃO seguir este documento):**
- `.claude/rules/processador-clean-arch.md` — Hexagonal Architecture pleno
- `.claude/rules/java-testing-patterns.md`
- `.claude/rules/spring-config-rules.md`

---

**Última atualização:** 2026-04-07
**Escopo:** `pe-api-core`, `pe-api-banking`, `pe-api-notification`, `pe-bff-portal` (NestJS)
**Owner:** Tech lead PE
**Revisão:** A cada quebra de regra recorrente em PR, atualizar esta doc.
