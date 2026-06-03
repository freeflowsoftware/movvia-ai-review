---
appliesTo:
  - "**/*.java"
---

---
description: Padrões de teste JUnit 5 + Mockito para serviços Spring Boot (processador, gateway, TPA)
globs: **/*Test.java
---

# Padrões de Teste Java — JUnit 5 + Mockito

## Setup Obrigatório

Use JUnit 5 com `MockitoExtension`. **Nunca** use JUnit 4 (`@RunWith`, `@Rule`).

```java
// ✅ CORRETO - JUnit 5 + Mockito
@ExtendWith(MockitoExtension.class)
class ProcessarPassagemUseCaseTest {

    @Mock
    private PassagemRepository passagemRepository; // mock da PORT, não da implementação

    @InjectMocks
    private ProcessarPassagemUseCase useCase;
}

// ❌ ERRADO - JUnit 4
@RunWith(MockitoJUnitRunner.class)
public class ProcessarPassagemUseCaseTest { ... }
```

## Nomes Descritivos em Português

Métodos de teste devem descrever o comportamento esperado.

```java
// ✅ CORRETO
@Test
void deveProcessarPassagemComSucesso() { ... }

@Test
void deveLancarExcecaoQuandoPlacaInvalida() { ... }

// ❌ ERRADO
@Test
void test1() { ... }

@Test
void testProcess() { ... }
```

## Padrão AAA (Arrange, Act, Assert)

Separe claramente as três fases do teste.

```java
@Test
void deveCalcularValorComDescontoCorreto() {
    // Arrange
    var passagem = new Passagem("ABC1D23", TipoVeiculo.LEVE);
    when(tarifaRepository.buscarPorCategoria(TipoVeiculo.LEVE))
        .thenReturn(Optional.of(new Tarifa(BigDecimal.valueOf(10.50))));

    // Act
    var resultado = useCase.calcularValor(passagem);

    // Assert
    assertThat(resultado.getValor()).isEqualByComparingTo("10.50");
    verify(tarifaRepository).buscarPorCategoria(TipoVeiculo.LEVE);
}
```

## Hexagonal Architecture: Mock de Ports

Na arquitetura hexagonal, faça mock das **interfaces (ports)** em `application/port/output/`, nunca das implementações concretas do adapter.

```java
// ✅ CORRETO - Mock da port (interface)
@Mock
private PassagemRepository passagemRepository; // interface em application/port/output

// ❌ ERRADO - Mock da implementação
@Mock
private PassagemRepositoryImpl passagemRepositoryImpl; // classe concreta em adapter/outbound
```

## Cenários Obrigatórios

Para todo use case ou service, teste no mínimo:

1. **Fluxo feliz** — operação completa com sucesso
2. **Exceções esperadas** — entidade não encontrada, validação falhou
3. **Edge cases** — valores nulos, listas vazias, limites
4. **Validações de entrada** — parâmetros inválidos

```java
@Test
void deveLancarExcecaoQuandoPassagemNaoEncontrada() {
    // Arrange
    when(passagemRepository.findById("inexistente"))
        .thenReturn(Optional.empty());

    // Act & Assert
    assertThrows(PassagemNaoEncontradaException.class,
        () -> useCase.buscarPassagem("inexistente"));
}
```

## Assertions

Prefira AssertJ (`assertThat`) para legibilidade. Use `assertThrows` do JUnit para exceções.

```java
// ✅ CORRETO - AssertJ
assertThat(resultado.getStatus()).isEqualTo("PROCESSADO");
assertThat(lista).hasSize(3).extracting("placa").contains("ABC1D23");

// ✅ CORRETO - JUnit assertions
assertEquals("PROCESSADO", resultado.getStatus());
assertThrows(IllegalArgumentException.class, () -> useCase.processar(null));

// ❌ ERRADO - Assert do JUnit 4
Assert.assertEquals("PROCESSADO", resultado.getStatus());
```

## Verificação de Interações

Use `verify()` para confirmar que side effects importantes aconteceram.

```java
// ✅ CORRETO - Verificar que persistiu e publicou evento
verify(passagemRepository).save(any(Passagem.class));
verify(eventPublisher).publish(any(PassagemProcessadaEvent.class));
verify(passagemRepository, never()).delete(any());
```

## Referência

Consulte `processador-clean-arch.md` para entender as camadas e regras de dependência da arquitetura hexagonal.
