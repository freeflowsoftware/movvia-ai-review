import { describe, it, expect } from 'vitest';
import { parseAddedLines, parseCite, isCiteValid, diffForFile, indexDiffByFile } from '../lib/cite-the-line.js';

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

// Diff com DOIS arquivos: diffForFile deve isolar os hunks de cada um, sem vazar o outro.
const DIFF_DOIS_ARQUIVOS = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,1 +1,1 @@
-Em breve disponivel na:
+Disponivel em:
diff --git a/src/b.ts b/src/b.ts
--- a/src/b.ts
+++ b/src/b.ts
@@ -5,1 +5,1 @@
-antigo
+atual
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

describe('diffForFile', () => {
  // O arbitro adversarial precisa do DELTA do arquivo (nao so do HEAD do excerpt) para
  // arbitrar findings que sao afirmacoes sobre o diff (pe-portais#696).
  it('extrai os hunks (+/-/contexto) do arquivo-alvo', () => {
    const out = diffForFile(DIFF, 'src/a.ts');
    expect(out).toContain('+const token = "abc";');
    expect(out).toContain('+novo');
    expect(out).toContain('@@ -10,3 +10,5 @@ class A {');
  });

  it('isola um arquivo sem vazar os hunks de outro arquivo do mesmo diff', () => {
    const out = diffForFile(DIFF_DOIS_ARQUIVOS, 'src/a.ts');
    expect(out).toContain('+Disponivel em:');
    expect(out).toContain('-Em breve disponivel na:');
    expect(out).not.toContain('atual'); // hunk de src/b.ts nao vaza
  });

  it('exclui os cabecalhos de arquivo (diff --git / --- / +++) do conteudo', () => {
    const out = diffForFile(DIFF_DOIS_ARQUIVOS, 'src/b.ts');
    expect(out).not.toContain('diff --git');
    expect(out).not.toContain('--- a/');
    expect(out).not.toContain('+++ b/');
    expect(out).toContain('+atual');
  });

  it('retorna vazio quando o arquivo nao esta no diff', () => {
    expect(diffForFile(DIFF, 'src/inexistente.ts')).toBe('');
  });
});

describe('indexDiffByFile', () => {
  // Indexa numa unica passada para o gatekeeper consultar O(1) por finding (sem re-parse).
  it('mapeia cada arquivo aos seus hunks numa unica passada', () => {
    const idx = indexDiffByFile(DIFF_DOIS_ARQUIVOS);
    expect([...idx.keys()].sort()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(idx.get('src/a.ts')).toContain('+Disponivel em:');
    expect(idx.get('src/b.ts')).toContain('+atual');
    expect(idx.get('src/a.ts')).not.toContain('atual'); // sem vazamento entre arquivos
  });
  it('concorda com diffForFile (que delega ao indice)', () => {
    expect(diffForFile(DIFF_DOIS_ARQUIVOS, 'src/b.ts')).toBe(indexDiffByFile(DIFF_DOIS_ARQUIVOS).get('src/b.ts'));
  });
});
