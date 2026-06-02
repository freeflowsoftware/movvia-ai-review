import { describe, it, expect } from 'vitest';
import { parseAddedLines, parseCite, isCiteValid } from '../lib/cite-the-line.js';

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,5 @@ class A {
 contexto
+const token = "abc";
+doStuff(token);
 mais contexto
@@ -40,2 +42,2 @@
-velho
+novo
`;

// Conteudo adicionado que comeca com ++/--. O git emite headers como "+++ b/path"
// e "--- a/path" COM ESPACO; conteudo como "++count" nao tem espaco e deve contar
// como linha adicionada normal, senao newLine para de avancar e desalinha tudo.
const DIFF_CONTEUDO_PLUS_PLUS = `diff --git a/src/c.ts b/src/c.ts
--- a/src/c.ts
+++ b/src/c.ts
@@ -0,0 +1,2 @@
+++count
+next
`;

describe('parseAddedLines', () => {
  it('mapeia linhas adicionadas por arquivo (numeracao do arquivo NOVO)', () => {
    const map = parseAddedLines(DIFF);
    expect([...(map.get('src/a.ts') ?? [])].sort((x, y) => x - y)).toEqual([11, 12, 42]);
  });

  it('trata conteudo "++"/"--" como linha (nao como header) sem off-by-one', () => {
    const map = parseAddedLines(DIFF_CONTEUDO_PLUS_PLUS);
    expect([...(map.get('src/c.ts') ?? [])].sort((x, y) => x - y)).toEqual([1, 2]);
  });
});

describe('parseCite', () => {
  it('parseia "file:start-end"', () => {
    expect(parseCite('src/a.ts:11-12')).toEqual({ file: 'src/a.ts', start: 11, end: 12 });
  });
  it('aceita linha unica "file:42"', () => {
    expect(parseCite('src/a.ts:42')).toEqual({ file: 'src/a.ts', start: 42, end: 42 });
  });
  it('retorna null em formato invalido', () => {
    expect(parseCite('lixo')).toBeNull();
  });
});

describe('isCiteValid', () => {
  it('true quando a citacao cobre ao menos uma linha adicionada', () => {
    const map = parseAddedLines(DIFF);
    expect(isCiteValid('src/a.ts:11-12', map)).toBe(true);
  });
  it('false quando o range nao toca nenhuma linha adicionada (alucinacao)', () => {
    const map = parseAddedLines(DIFF);
    expect(isCiteValid('src/a.ts:100-110', map)).toBe(false);
  });
  it('false quando o arquivo nao esta no diff', () => {
    const map = parseAddedLines(DIFF);
    expect(isCiteValid('src/inexistente.ts:1-2', map)).toBe(false);
  });
});
