---
appliesTo:
  - "**/*.tsx"
  - "**/*.ts"
---

---
description: Trailing slash em projetos Next.js - como avaliar hrefs estaticos e dinamicos sem gerar falso positivo
globs: "**/*.tsx, **/*.ts"
---

# Next.js – Trailing Slash em Links

## Contexto

Projetos com `trailingSlash: true` em `next.config.ts` exigem que URLs internas
terminem com `/`. URLs sem a barra geram redirect 308, prejudicando SEO.

## Hrefs Estaticos — Verifique no JSX

Quando o href esta literal no componente, avalie diretamente:

```tsx
// ✅ href="/sobre/" — tem trailing slash
// ❌ href="/sobre"  — falta trailing slash
```

## Hrefs Dinamicos — Verifique a ORIGEM, nao o componente

Quando o href vem de uma prop ou variavel (`href={link.href}`, `href={item.url}`),
a responsabilidade do trailing slash esta no **arquivo de dados fonte**,
nao no componente que o consome.

**Antes de reportar P1**: verifique o arquivo de dados fonte (camada de imports —
ex: `footerData.ts`, `sitemapData.ts`, arrays de configuracao) para confirmar se
os valores ja incluem `/`. Se o arquivo de dados **ja tem trailing slash**, o
componente esta correto — NAO reporte P1.

```tsx
// Componente — href dinamico, trailing slash nao visivel no JSX
{links.map(link => <Link href={link.href}>{link.label}</Link>)}

// Verificar o arquivo de dados (camada de imports):
// footerData.ts:45  href: "/pagar-pedagio/concessionarias/"  ← tem / = OK
// footerData.ts:50  href: "/concessionarias/free-flow-cnl/"  ← tem / = OK
```

## Padrao de Testes Next.js — `.replace(/\/$/, "")` NAO e evidencia de ausencia

O mock de `next/link` usado pelo `next/jest` (jsdom) **normaliza hrefs removendo
trailing slash** no elemento renderizado. Testes que adaptam esse comportamento
com `.replace(/\/$/, "")` ou `.toContain(path)` nas assertions fazem isso por
causa do ambiente de teste, **nao porque o dado real nao tem trailing slash**.

```tsx
// Este trecho no teste NAO indica que o href esta errado em producao:
expect(link.getAttribute("href")).toContain(href.replace(/\/$/, ""));

// A evidencia correta e o teste de dados:
expect(href).toMatch(/\/$/);  // ← ESTE prova que o dado tem trailing slash
```

Ao avaliar trailing slash a partir de testes, procure testes que verificam
diretamente os **dados fonte** (`footerData`, arrays de config), nao os elementos
renderizados — esses sofrem normalizacao do mock jsdom.
