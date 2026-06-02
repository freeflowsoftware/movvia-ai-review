# Convencoes Java

- `stream().map().filter()` e LAZY e single-pass: os operadores intermediarios sao fundidos numa unica passagem na operacao terminal. NAO trate encadeamento de stream como "N passagens" — isso e FALSO para Java.
- Use Optional em vez de retornar null em ports.
- JUnit 5 + Mockito; mock das PORTS (interfaces), nunca das implementacoes.
- Hexagonal: domain sem anotacao Spring/JPA; nada de @Transactional no domain.
- PostgreSQL: VARCHAR(50) + CHECK, nunca CREATE TYPE ENUM.
