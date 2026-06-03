---
appliesTo:
  - "**/*.java"
---

---
description: Hexagonal Architecture (Ports & Adapters) para o processador Spring Boot (pe-processador-concessionaria)
globs: **/domain/**/*.java, **/application/**/*.java, **/adapter/**/*.java
---

# Hexagonal Architecture - PE Processador Concessionária

## Estrutura Real do Projeto

O processador segue Hexagonal Architecture (Ports & Adapters):

```
br.com.movvia.pe.processador/
├── domain/              → Modelos, value objects, domain services, events, exceptions
│   ├── model/
│   ├── valueobject/
│   ├── service/
│   ├── event/
│   └── exception/
├── application/         → Use cases, DTOs, mappers, ports de saída, strategies, outbox
│   ├── usecase/
│   ├── dto/
│   ├── mapper/
│   ├── port/output/     → Interfaces para adaptadores de saída
│   ├── strategy/
│   └── outbox/
└── adapter/             → Implementações concretas (inbound + outbound)
    ├── config/          → ApplicationConfig, RabbitConfig, RedisConfig, S3Config
    ├── scheduler/       → OutboxProcessor
    ├── inbound/
    │   ├── rabbitmq/    → Listeners, message handlers
    │   └── rest/        → Controllers, DTOs de API
    └── outbound/
        ├── persistence/ → JPA repositories, entities, converters, mappers
        ├── cache/       → RedisIdempotencyStore
        ├── storage/     → S3 upload
        ├── http/        → External API clients
        └── messaging/   → Outbound message publishing
```

## Regras de Dependência

```
adapter.inbound  → application → domain
adapter.outbound → application → domain
```

- `domain` NÃO importa nada de `application` ou `adapter`
- `application` NÃO importa de `adapter` — usa ports (interfaces em `application/port/output/`)
- `adapter.outbound` implementa as ports definidas em `application`

## Padrões do Projeto

### Domain (Modelos puros)
```java
// Entidades SEM anotações Spring ou JPA
public class Passagem {
    private final String id;
    private final String placa;
    // regras de negócio como métodos
}
```

### Application (Ports de saída)
```java
// Interface no application/port/output, implementação no adapter/outbound
public interface PassagemRepository {
    Optional<Passagem> findById(String id);
    void save(Passagem passagem);
}
```

### Application (Use cases)
```java
@Service
public class ProcessarPassagemUseCase {
    private final PassagemRepository repository; // interface (port), não implementação
}
```

### Adapter Outbound (Implementa port)
```java
@Repository
public class PassagemRepositoryImpl implements PassagemRepository {
    private final PassagemJpaRepository jpaRepository;
}
```

### Padrões Adicionais em Uso
- **Transactional Outbox** — eventos publicados via outbox para garantir consistência
- **Redis Idempotency Store** — deduplicação de mensagens recebidas
- **Strategy Pattern** — para lógica de processamento variável
- **Dynamic RabbitMQ** — conexões configuradas por concessionária

## Não Faça

- Não use `@Entity` JPA em classes do domain — crie JPA entities no `adapter/outbound/persistence`
- Não injete `EntityManager` ou `JdbcTemplate` em use cases
- Não coloque lógica de negócio em controllers, listeners ou repositories
- Não use `@Transactional` em classes do domain
- Não crie dependências de `adapter` dentro de `application` ou `domain`
- Não importe classes de `adapter.inbound` em `adapter.outbound` (ou vice-versa)

## PostgreSQL com Hibernate

- Use `VARCHAR(50)` para campos que representam enums (nunca `CREATE TYPE ENUM` no PostgreSQL)
- Para queries JPQL com parâmetros nullable e LIKE:
  ```java
  // ✅ CORRETO
  WHERE (COALESCE(:param, '') = '' OR col LIKE CONCAT('%', CAST(:param AS string), '%'))

  // ❌ ERRADO - causa "operator does not exist: character varying ~~ bytea"
  WHERE (:param IS NULL OR col LIKE '%' || :param || '%')
  ```
