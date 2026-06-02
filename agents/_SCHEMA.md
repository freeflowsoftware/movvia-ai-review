# Contrato de um agente

Cada `.md` (exceto os iniciados por `_`) vira um job paralelo. Frontmatter:

```yaml
---
name: <kebab-case unico>        # vira o nome do job
dimension: <categoria>          # ex: security, performance
model: ""                       # vazio = default do CI; ou "deepseek/deepseek-chat"
paths: ["**/*"]                 # opcional: so roda se o PR tocar esses globs
severity_hints:
  P0: "o que e critico/bloqueante nesta dimensao"
  P1: "o que e importante"
  P2: "o que e menor"
---
<persona em PT-BR: o que avaliar, citar [arquivo:linha], nao inventar API>
```

Saída obrigatória do agente: um único objeto JSON `{"agent","findings":[...]}` (schema em `lib/types.ts` → `Finding`).
