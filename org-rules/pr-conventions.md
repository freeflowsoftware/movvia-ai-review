---
# Transversal: aplica a qualquer diff (sem appliesTo).
---

---
description: Convencoes para titulos de PR, commits e descricoes — formato validado pelo CodeRabbit
---

# Convencoes de Pull Request

## Titulo do PR

Formato obrigatorio: `<tipo>: <descricao curta>` (maximo 70 caracteres)

### Tipos Validos

| Tipo | Quando usar |
|------|-------------|
| `feat` | Nova funcionalidade |
| `fix` | Correcao de bug |
| `refactor` | Refatoracao sem mudanca de comportamento |
| `docs` | Apenas documentacao |
| `test` | Apenas testes |
| `chore` | Tarefas de manutencao, dependencias |
| `ci` | Mudancas em CI/CD, workflows |
| `perf` | Otimizacao de performance |
| `style` | Formatacao, espacos, ponto-e-virgula |

### Exemplos de Titulos

```
// ✅ CORRETO
feat: adicionar endpoint de estorno parcial
fix: corrigir calculo de taxa no PIX
refactor: extrair validacao de CPF para shared-lib
docs: documentar fluxo de liquidacao automatica
test: adicionar testes para RecargaService
chore: atualizar Prisma para v6.2
ci: adicionar step de lint no workflow de PR
perf: otimizar query de passagens com indice parcial

// ❌ ERRADO
Update files
WIP
fix stuff
Pablo's changes
feat: Adicionar endpoint de estorno parcial de recargas para clientes PF e PJ com validacao
FEAT: nova feature
Fix: bug no pagamento
```

## Labels Automaticas

O CodeRabbit aplica labels com base nos arquivos alterados:

| Label | Criterio |
|-------|----------|
| `backend` | Alteracoes em `*.service.ts`, `*.controller.ts`, `*.java` |
| `frontend` | Alteracoes em `*.tsx`, `*.css`, `pe-portais/` |
| `migration` | Alteracoes em `**/migrations/**`, `**/flyway/**` |
| `infra` | Alteracoes em `**/terraform/**`, `**/argocd/**`, `Dockerfile` |
| `financial` | Alteracoes em `banking`, `pagamento`, `recarga`, `saldo` |
| `tests` | Alteracoes em `*.spec.ts`, `*.test.ts`, `*Test.java` |
| `config` | Alteracoes em `application*.yml`, `*.properties` |

## Tamanho do PR

```
// ✅ CORRETO - PR focado (< 400 linhas)
feat: adicionar endpoint de consulta de saldo

// ❌ ERRADO - PR gigante (> 400 linhas misturando concerns)
feat: adicionar modulo completo de pagamentos com testes e migrations
```

PRs acima de 400 linhas alteradas: considere dividir em PRs menores e sequenciais.

## Body do PR

Estrutura recomendada:

```markdown
## Resumo
- O que muda e por que

## Tipo de mudanca
- [ ] Nova feature
- [ ] Bug fix
- [ ] Refatoracao
- [ ] Breaking change

## Impacto
- Servicos afetados
- Migrations necessarias
- Variaveis de ambiente novas

## Como testar
- Passos para validar a mudanca
```

## Commits dentro do PR

- Use o mesmo formato de tipo: `feat:`, `fix:`, etc.
- Commits atomicos — cada commit deve compilar e passar testes
- Evite commits de "fix review" — faca squash ou amend antes do merge
