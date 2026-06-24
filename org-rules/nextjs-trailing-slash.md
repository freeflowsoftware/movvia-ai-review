---
appliesTo:
  - "**/*.tsx"
---

---
description: Trailing slash em projetos Next.js - como avaliar hrefs estaticos e dinamicos sem gerar falso positivo
globs: "**/*.tsx"
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

## Hrefs Dinamicos — Verifique ORIGEM e o componente

Quando o href vem de prop ou variavel (`href={link.href}`, `href={item.url}`),
a responsabilidade primaria do trailing slash esta no arquivo de dados fonte
(imports — ex: `footerData.ts`, `sitemapData.ts`, arrays de configuracao).

**Antes de reportar P1, verifique as DUAS coisas:**

1. **O arquivo de dados** (camada de imports): todos os hrefs do array terminam com `/`?
2. **O componente**: ele transforma o href antes de usar?
   - Template string sem barra: `` `${path}` `` em vez de `` `${path}/` ``
   - `.replace()` ou concatenacao que remove a barra final

Se o dado tem trailing slash **E** o componente nao transforma o href,
o componente esta correto — NAO reporte P1.

Se o dado tem trailing slash **mas** o componente aplica transformacao que pode
remover a barra, reporte P1 citando a transformacao no componente.

Se o dado **nao tem** trailing slash em algum item do array, reporte P1
citando o arquivo de dados fonte.

```tsx
// ✅ Dado com trailing slash + componente sem transformacao = OK
// footerData.ts:45  href: "/pagar-pedagio/concessionarias/"
{links.map(link => <Link href={link.href}>{link.label}</Link>)}

// ❌ Dado com trailing slash MAS componente remove a barra = P1
{links.map(link => <Link href={link.href.replace(/\/$/, '')}>{link.label}</Link>)}

// ❌ Algum item do array sem trailing slash = P1 no arquivo de dados
// footerData.ts:50  href: "/concessionarias/cnl"  ← falta /
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
