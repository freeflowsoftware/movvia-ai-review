import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildContextPack,
  collectSiblings,
  resolveIntraRepoImports,
  collectExemplars,
  loadTsconfigAliases,
  skeletonize,
  estimateTokens,
  enforceTokenBudget,
  composedSuffix,
  buildPresenceIndex,
  EMPTY_PRESENCE_INDEX,
  nodeFileSystemReader,
  type FileSystemReader,
  type ContextPackOpts,
  type ContextPack,
  type PackFile,
} from '../lib/context-pack.js';

const FS = nodeFileSystemReader;

const OPTS: ContextPackOpts = {
  maxSiblings: 4,
  maxImports: 6,
  maxExemplars: 3,
  skeletonLocThreshold: 400,
  maxTokens: 100_000,
};

/** Cria um repo temp e devolve a raiz + um helper de escrita (cria diretorios pai). */
function makeRepo(): { dir: string; write: (rel: string, content: string) => void } {
  const dir = mkdtempSync(join(tmpdir(), 'ctxpack-'));
  const write = (rel: string, content: string): void => {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  };
  return { dir, write };
}

/**
 * Fake nomeado do FileSystemReader (regra Movvia: fakes nomeados, nao stubs inline). Cada
 * metodo pode ser configurado para lancar, exercitando a degradacao graciosa por camada.
 */
class FakeFileSystemReader implements FileSystemReader {
  constructor(private readonly throwOn: Set<keyof FileSystemReader> = new Set()) {}
  readFile(): string {
    if (this.throwOn.has('readFile')) throw new Error('readFile boom');
    return '';
  }
  listDir(): string[] {
    if (this.throwOn.has('listDir')) throw new Error('listDir boom');
    return [];
  }
  exists(): boolean {
    if (this.throwOn.has('exists')) throw new Error('exists boom');
    return false;
  }
  isFile(): boolean {
    if (this.throwOn.has('isFile')) throw new Error('isFile boom');
    return false;
  }
}

const findPack = (pack: ContextPack, file: string) => pack.files.find((f) => f.file === file)!;

describe('composedSuffix', () => {
  it('extrai o sufixo composto a partir do primeiro ponto', () => {
    expect(composedSuffix('src/conta.service.ts')).toBe('.service.ts');
    expect(composedSuffix('Foo.java')).toBe('.java');
    expect(composedSuffix('a/b/c.dto.ts')).toBe('.dto.ts');
  });
  it('retorna vazio quando o nome nao tem ponto', () => {
    expect(composedSuffix('src/Makefile')).toBe('');
  });
});

describe('estimateTokens', () => {
  it('estima ~ chars/4 arredondando para cima', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('skeletonize', () => {
  it('mantem apenas linhas de assinatura (class/interface/function/def)', () => {
    const src = [
      'export class ContaService {',
      '  private saldo = 0;',
      '  creditar(v: number) {',
      '    this.saldo += v;',
      '    return this.saldo;',
      '  }',
      '}',
    ].join('\n');
    const out = skeletonize(src);
    expect(out).toContain('export class ContaService');
    expect(out).toContain('creditar(v: number)');
    // corpo (atribuicao/return) e descartado
    expect(out).not.toContain('this.saldo += v;');
    expect(out).not.toContain('return this.saldo;');
  });
  it('reconhece def do Python e import do Java como assinatura', () => {
    expect(skeletonize('def processar(x):\n    return x')).toContain('def processar(x)');
    expect(skeletonize('interface Port {\n  save(): void;\n}')).toContain('interface Port');
  });
});

describe('collectSiblings (camada 2)', () => {
  it('coleta irmaos da mesma extensao, priorizando o mesmo sufixo composto', () => {
    const { dir, write } = makeRepo();
    write('src/conta.service.ts', 'CHANGED');
    write('src/pedido.service.ts', 'SVC PEDIDO');
    write('src/usuario.service.ts', 'SVC USUARIO');
    write('src/conta.dto.ts', 'DTO CONTA'); // mesma ext, sufixo diferente -> menor prioridade
    write('src/notas.md', 'IGNORAR'); // ext diferente -> fora
    const sib = collectSiblings(FS, dir, 'src/conta.service.ts', 4);
    const paths = sib.map((s) => s.path);
    expect(paths).not.toContain('src/conta.service.ts'); // exclui o proprio
    expect(paths).not.toContain('src/notas.md'); // ext diferente
    // os .service.ts vem antes do .dto.ts
    expect(paths.indexOf('src/pedido.service.ts')).toBeLessThan(paths.indexOf('src/conta.dto.ts'));
  });
  it('respeita a cota max', () => {
    const { dir, write } = makeRepo();
    write('src/a.service.ts', 'A');
    write('src/b.service.ts', 'B');
    write('src/c.service.ts', 'C');
    write('src/d.service.ts', 'D');
    const sib = collectSiblings(FS, dir, 'src/a.service.ts', 2);
    expect(sib).toHaveLength(2);
  });
});

describe('resolveIntraRepoImports (camada 3)', () => {
  it('resolve import relativo TS (from) para o arquivo real com extensao inferida', () => {
    const { dir, write } = makeRepo();
    write('src/lock.service.ts', 'export class LockService {}');
    const content = "import { LockService } from './lock.service';\n";
    const imps = resolveIntraRepoImports(FS, content, dir, 'src/conta.service.ts', new Map(), 6);
    expect(imps.map((i) => i.path)).toEqual(['src/lock.service.ts']);
  });
  it('resolve import Java dotted intra-repo', () => {
    const { dir, write } = makeRepo();
    write('br/com/movvia/Conta.java', 'public class Conta {}');
    const content = 'import br.com.movvia.Conta;\n';
    const imps = resolveIntraRepoImports(FS, content, dir, 'br/com/movvia/Service.java', new Map(), 6);
    expect(imps.map((i) => i.path)).toContain('br/com/movvia/Conta.java');
  });
  it('resolve from-import Python intra-repo', () => {
    const { dir, write } = makeRepo();
    write('app/repo.py', 'class Repo: pass');
    const content = 'from app.repo import Repo\n';
    const imps = resolveIntraRepoImports(FS, content, dir, 'app/service.py', new Map(), 6);
    expect(imps.map((i) => i.path)).toContain('app/repo.py');
  });
  it('resolve alias do tsconfig.paths (@pe/*) lendo o mapa de aliases', () => {
    const { dir, write } = makeRepo();
    write('packages/shared/lock.ts', 'export const lock = 1;');
    const aliases = new Map([['@pe/shared', 'packages/shared']]);
    const content = "import { lock } from '@pe/shared/lock';\n";
    const imps = resolveIntraRepoImports(FS, content, dir, 'apps/x/a.ts', aliases, 6);
    expect(imps.map((i) => i.path)).toContain('packages/shared/lock.ts');
  });
  it('ignora imports de pacote externo (nao intra-repo): nao vira evidencia de ausencia', () => {
    const { dir } = makeRepo();
    const content = "import { Injectable } from '@nestjs/common';\nimport axios from 'axios';\n";
    const imps = resolveIntraRepoImports(FS, content, dir, 'src/a.ts', new Map(), 6);
    expect(imps).toEqual([]);
  });
  it('respeita a cota max de imports', () => {
    const { dir, write } = makeRepo();
    write('src/a.ts', 'a');
    write('src/b.ts', 'b');
    write('src/c.ts', 'c');
    const content = "import './a';\nimport './b';\nimport './c';\n";
    const imps = resolveIntraRepoImports(FS, content, dir, 'src/main.ts', new Map(), 2);
    expect(imps).toHaveLength(2);
  });
});

describe('collectExemplars (camada 4)', () => {
  it('escolhe os exemplares de maior LOC para o sufixo dado, excluindo o proprio', () => {
    const { dir, write } = makeRepo();
    write('a/pequeno.dto.ts', 'class Pequeno {}');
    write('b/grande.dto.ts', Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n'));
    write('c/medio.dto.ts', Array.from({ length: 10 }, (_, i) => `line${i}`).join('\n'));
    write('d/alterado.dto.ts', 'class Alterado {}');
    const ex = collectExemplars(FS, dir, '.dto.ts', 'd/alterado.dto.ts', 2);
    expect(ex.map((e) => e.path)).toEqual(['b/grande.dto.ts', 'c/medio.dto.ts']);
  });
  it('retorna vazio para sufixo vazio', () => {
    const { dir } = makeRepo();
    expect(collectExemplars(FS, dir, '', 'x.ts', 3)).toEqual([]);
  });
});

describe('loadTsconfigAliases', () => {
  it('le compilerOptions.paths e remove o /* das pontas', () => {
    const { dir, write } = makeRepo();
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@pe/*': ['src/pe/*'], '@/*': ['src/*'] } } }),
    );
    const aliases = loadTsconfigAliases(FS, dir);
    expect(aliases.get('@pe')).toBe('src/pe');
    expect(aliases.get('@')).toBe('src');
  });
  it('retorna mapa vazio sem tsconfig.json', () => {
    const { dir } = makeRepo();
    expect(loadTsconfigAliases(FS, dir).size).toBe(0);
  });
});

describe('enforceTokenBudget', () => {
  const pf = (path: string, content: string): PackFile => ({ path, content, skeletonized: false });

  it('mantem o arquivo alterado e corta exemplos antes de irmaos quando estoura', () => {
    const big = 'x'.repeat(400); // ~100 tokens
    const pack: ContextPack = {
      files: [
        {
          file: 'a.ts',
          changed: pf('a.ts', 'x'.repeat(40)), // ~10 tokens, sempre fica
          siblings: [pf('s.ts', big)],
          imports: [pf('i.ts', big)],
          exemplars: [pf('e.ts', big)],
        },
      ],
      presenceIndex: EMPTY_PRESENCE_INDEX,
    };
    // budget so cabe o alterado + 1 camada extra
    const out = enforceTokenBudget(pack, 120);
    const f = out.files[0]!;
    expect(f.changed.content).toHaveLength(40); // alterado intacto
    expect(f.siblings).toHaveLength(1); // irmao tem prioridade sobre exemplo
    expect(f.exemplars).toHaveLength(0); // exemplo cortado primeiro
  });

  it('nao corta nada quando tudo cabe no budget', () => {
    const pack: ContextPack = {
      files: [
        {
          file: 'a.ts',
          changed: pf('a.ts', 'aa'),
          siblings: [pf('s.ts', 'bb')],
          imports: [pf('i.ts', 'cc')],
          exemplars: [pf('e.ts', 'dd')],
        },
      ],
      presenceIndex: EMPTY_PRESENCE_INDEX,
    };
    const out = enforceTokenBudget(pack, 100_000);
    const f = out.files[0]!;
    expect(f.siblings).toHaveLength(1);
    expect(f.imports).toHaveLength(1);
    expect(f.exemplars).toHaveLength(1);
  });
});

describe('buildContextPack (orquestrador, 4 camadas)', () => {
  it('monta as 4 camadas: alterado inteiro + irmaos + imports + exemplares', () => {
    const { dir, write } = makeRepo();
    write(
      'tsconfig.json',
      JSON.stringify({ compilerOptions: { paths: { '@shared/*': ['src/shared/*'] } } }),
    );
    write('src/conta.service.ts', "import { Lock } from '@shared/lock';\nexport class ContaService {}\n");
    write('src/lock-but-not-imported.service.ts', 'SIBLING');
    write('src/shared/lock.ts', 'export class Lock {}');
    write('other/big.service.ts', Array.from({ length: 20 }, (_, i) => `m${i}() {}`).join('\n'));

    const pack = buildContextPack(dir, ['src/conta.service.ts'], OPTS, FS);
    const f = findPack(pack, 'src/conta.service.ts');

    // camada 1: arquivo alterado inteiro, nunca skeletonizado
    expect(f.changed.content).toContain('export class ContaService');
    expect(f.changed.skeletonized).toBe(false);
    // camada 2: irmao do mesmo sufixo .service.ts
    expect(f.siblings.map((s) => s.path)).toContain('src/lock-but-not-imported.service.ts');
    // camada 3: import resolvido via alias tsconfig
    expect(f.imports.map((i) => i.path)).toContain('src/shared/lock.ts');
    // camada 4: exemplar do mesmo sufixo .service.ts (maior LOC), excluindo o alterado
    expect(f.exemplars.map((e) => e.path)).toContain('other/big.service.ts');
    expect(f.exemplars.map((e) => e.path)).not.toContain('src/conta.service.ts');
  });

  it('skeletoniza arquivos vizinhos grandes (>threshold) mas NUNCA o alterado', () => {
    const { dir, write } = makeRepo();
    const bigBody = Array.from({ length: 12 }, (_, i) => `  metodo${i}() {\n    const v = ${i};\n  }`).join('\n');
    write('src/a.service.ts', `export class A {\n${bigBody}\n}`);
    write('src/b.service.ts', `export class B {\n${bigBody}\n}`);
    const opts: ContextPackOpts = { ...OPTS, skeletonLocThreshold: 5 };
    const pack = buildContextPack(dir, ['src/a.service.ts'], opts, FS);
    const f = findPack(pack, 'src/a.service.ts');
    // alterado: inteiro, com corpo, NAO skeletonizado
    expect(f.changed.skeletonized).toBe(false);
    expect(f.changed.content).toContain('const v = 0;');
    // irmao grande: skeletonizado (corpo sumiu)
    const sibling = f.siblings.find((s) => s.path === 'src/b.service.ts')!;
    expect(sibling.skeletonized).toBe(true);
    expect(sibling.content).not.toContain('const v = 0;');
    expect(sibling.content).toContain('export class B');
  });

  it('degrada graciosamente quando o arquivo alterado nao existe (changed vazio, nunca lanca)', () => {
    const { dir } = makeRepo();
    const pack = buildContextPack(dir, ['nao/existe.ts'], OPTS, FS);
    const f = findPack(pack, 'nao/existe.ts');
    expect(f.changed.content).toBe('');
    expect(f.siblings).toEqual([]);
    expect(f.imports).toEqual([]);
    expect(f.exemplars).toEqual([]);
  });
});

describe('buildContextPack — degradacao graciosa por camada (fake que lanca)', () => {
  it('NUNCA lanca quando o filesystem falha em todas as operacoes; secoes ficam vazias', () => {
    const exploding = new FakeFileSystemReader(
      new Set<keyof FileSystemReader>(['readFile', 'listDir', 'exists', 'isFile']),
    );
    const pack = buildContextPack('/repo', ['src/conta.service.ts'], OPTS, exploding);
    const f = findPack(pack, 'src/conta.service.ts');
    expect(f.changed.content).toBe(''); // camada 1 degradou para vazio
    expect(f.siblings).toEqual([]);
    expect(f.imports).toEqual([]);
    expect(f.exemplars).toEqual([]);
  });

  it('a falha de UMA camada (irmaos) nao derruba as outras', () => {
    const { dir, write } = makeRepo();
    write('src/conta.service.ts', "import './dep';\nexport class C {}\n");
    write('src/dep.ts', 'export const dep = 1;');
    write('src/outro.service.ts', 'export class Outro {}');

    // Decorador do fs real que lanca SO no listDir (camada 2 = irmaos), preservando o resto.
    const listDirFails: FileSystemReader = {
      ...nodeFileSystemReader,
      listDir: () => {
        throw new Error('listDir indisponivel');
      },
    };
    const pack = buildContextPack(dir, ['src/conta.service.ts'], OPTS, listDirFails);
    const f = findPack(pack, 'src/conta.service.ts');
    expect(f.changed.content).toContain('export class C'); // camada 1 ok
    expect(f.siblings).toEqual([]); // camada 2 degradou
    expect(f.imports.map((i) => i.path)).toContain('src/dep.ts'); // camada 3 ok (nao usa listDir)
  });
});

describe('buildPresenceIndex', () => {
  it('indexa models Prisma, simbolos declarados, sujeitos de teste e chaves de .env.example', () => {
    const { dir, write } = makeRepo();
    // FP SEO-42/PR640: o model existe no schema, fora da janela do context-pack do service.
    write('prisma/schema.prisma', 'model ConsultaAlertaEmail {\n  id String @id\n}\n');
    // FP SEO-153: componente que o bot alegou "nao implementado/nao renderizado".
    write('app/_rota-verde/_components/rv-hero.tsx', 'export function RvHero() {\n  return null;\n}\n');
    // FP PR763: teste co-locado em __tests__/ que o bot alegou faltar.
    write('hooks/__tests__/useIsAndroid.test.ts', "import { useIsAndroid } from '../useIsAndroid';\n");
    // FP PR69-FP3: flag que o bot alegou ausente no .env.example (ela esta la).
    write('.env.example', 'DATABASE_URL=postgres://x\nENABLE_CONSULTA_ALERTA_REMINDERS=false\n');

    const index = buildPresenceIndex(dir, nodeFileSystemReader);

    expect(index.symbols).toContain('ConsultaAlertaEmail');
    expect(index.symbols).toContain('RvHero');
    expect(index.testSubjects).toContain('useIsAndroid');
    expect(index.envKeys).toContain('ENABLE_CONSULTA_ALERTA_REMINDERS');
  });

  it('F2: indexa const/component de topo (export) mas NAO variavel local de funcao', () => {
    const { dir, write } = makeRepo();
    write('app/rv-hero.tsx', 'export const RvHero = () => null;\nfunction x() {\n  const localSecreto = 1;\n  return localSecreto;\n}\n');
    const index = buildPresenceIndex(dir, nodeFileSystemReader);
    expect(index.symbols).toContain('RvHero');
    expect(index.symbols).not.toContain('localSecreto'); // binding local nao infla o indice
  });

  it('F1: ignora arquivos fora da allowlist de extensao (lockfile/asset nao sao lidos p/ simbolo)', () => {
    const { dir, write } = makeRepo();
    write('src/comp.tsx', 'export class RealComp {}');
    write('pnpm-lock.yaml', 'packages:\n  class FakeFromLock:\n');
    write('public/data.json', '{"class": "FakeFromJson"}');
    const index = buildPresenceIndex(dir, nodeFileSystemReader);
    expect(index.symbols).toContain('RealComp');
    expect(index.symbols).not.toContain('FakeFromLock');
    expect(index.symbols).not.toContain('FakeFromJson');
  });

  it('F1: pula arquivo fonte gigante (acima do cap) sem quebrar o indice', () => {
    const { dir, write } = makeRepo();
    write('src/ok.ts', 'export class Pequena {}');
    write('src/gigante.ts', `export class Gigante {}\n${'// x'.repeat(200_000)}`);
    const index = buildPresenceIndex(dir, nodeFileSystemReader);
    expect(index.symbols).toContain('Pequena');
    expect(index.symbols).not.toContain('Gigante'); // gigante pulado pelo cap de tamanho
  });

  it('degrada gracioso: fs que lanca no walk devolve indice vazio (nunca quebra o pack)', () => {
    const listDirFails: FileSystemReader = {
      ...nodeFileSystemReader,
      listDir: () => {
        throw new Error('listDir boom');
      },
    };
    const index = buildPresenceIndex('/qualquer', listDirFails);
    expect(index).toEqual({ symbols: [], testSubjects: [], envKeys: [] });
  });
});

describe('buildContextPack presenceIndex', () => {
  it('anexa o presenceIndex do repo inteiro (independe dos arquivos alterados)', () => {
    const { dir, write } = makeRepo();
    write('prisma/schema.prisma', 'model ConsultaAlertaEmail {\n  id String @id\n}\n');
    write('src/consulta-alerta.service.ts', 'export class ConsultaAlertaService {}');

    const pack = buildContextPack(dir, ['src/consulta-alerta.service.ts'], OPTS);
    expect(pack.presenceIndex.symbols).toContain('ConsultaAlertaEmail');
  });
});
