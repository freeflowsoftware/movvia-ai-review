// tests/gatekeeper.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findingId, dedupe, dedupeByLine, decideVerdict, filterByCite, runAdversarial, readAdversarialThreshold, consolidateFindings, type Refuter } from '../lib/gatekeeper.js';
import type { ChatRunner } from '../lib/run-agent.js';
import type { Finding } from '../lib/types.js';

function f(over: Partial<Finding>): Finding {
  return {
    agent: 'seguranca', file: 'a.ts', startLine: 10, endLine: 12, severity: 'P1',
    category: 'lock', title: 't', rationale: 'r', suggestion: 's', cite: 'a.ts:10-12', ...over,
  };
}

/**
 * Fake nomeado do refutador (borda externa: simula o LLM/opencode). Lanca para
 * findings cuja categoria casa com `categoriaQueFalha`, simulando uma rejeicao
 * transitoria (timeout/spawn/rede); para os demais, refuta com confianca alta.
 * Uso: new RefuterQueFalhaEm('quebra').asRefuter()
 */
class RefuterQueFalhaEm {
  constructor(private readonly categoriaQueFalha: string) {}

  asRefuter(): Refuter {
    return async (finding) => {
      if (finding.category === this.categoriaQueFalha) {
        throw new Error(`refuter timeout para categoria ${finding.category}`);
      }
      return { refuted: false, score: 9 };
    };
  }
}

/**
 * Fake nomeado do ChatRunner do consolidador (borda externa: simula o LLM melhor).
 * Devolve sempre o JSON cru passado no construtor, contando quantas vezes foi chamado —
 * assim o teste do caso "<=1 finding" pode afirmar que o LLM NAO foi invocado.
 * Uso: new ConsolidadorFake('{"findings":[]}')
 */
class ConsolidadorFake {
  chamadas = 0;

  constructor(private readonly respostaJson: string) {}

  asRunner(): ChatRunner {
    return async () => {
      this.chamadas += 1;
      return this.respostaJson;
    };
  }
}

describe('findingId', () => {
  it('e estavel para mesmo arquivo+range+categoria', () => {
    expect(findingId(f({}))).toBe(findingId(f({ title: 'outro titulo' })));
  });
  it('difere por categoria', () => {
    expect(findingId(f({ category: 'lock' }))).not.toBe(findingId(f({ category: 'sql' })));
  });
  // Regressao: a ancoragem de findingId e de dedupe precisa concordar. Antes,
  // findingId usava bucket fixo floor(startLine/3) e dedupe usava janela ±3,
  // entao um deslocamento de 1 linha cruzando a fronteira do bucket (11→12)
  // mudava o ID estavel apesar de dedupe fundir os dois — quebrando a promessa
  // de idempotencia. Agora os dois usam a mesma ancora de linha (lineAnchor).
  it('concorda com dedupe: linhas que o dedupe funde compartilham o mesmo ID', () => {
    const fundidos = dedupe([f({ startLine: 11 }), f({ startLine: 12 })]);
    expect(fundidos).toHaveLength(1);
    expect(findingId(f({ startLine: 11 }))).toBe(findingId(f({ startLine: 12 })));
    expect(findingId(fundidos[0]!)).toBe(findingId(f({ startLine: 11 })));
  });
});

describe('dedupe', () => {
  it('funde findings da mesma categoria a ±3 linhas mantendo a maior severidade', () => {
    const out = dedupe([f({ severity: 'P2', startLine: 10 }), f({ severity: 'P0', startLine: 12 })]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('P0');
  });
  it('mantem findings de categorias diferentes', () => {
    expect(dedupe([f({ category: 'lock' }), f({ category: 'sql' })])).toHaveLength(2);
  });
  // Regressao: o casamento de chave precisa ser exato no par file:category.
  // Antes usava k.startsWith(`${file}:${category}`); como `category` e string
  // livre vinda do modelo, uma categoria prefixo de outra (lock x lockfile)
  // fundia DOIS findings distintos em um, descartando silenciosamente um achado
  // valido — aqui um P0 de outra categoria sumia.
  it('nao funde categorias onde uma e prefixo da outra (lock x lockfile)', () => {
    const out = dedupe([f({ category: 'lockfile', severity: 'P0', startLine: 10 }), f({ category: 'lock', severity: 'P1', startLine: 12 })]);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.severity).sort()).toEqual(['P0', 'P1']);
  });
});

describe('dedupeByLine', () => {
  // O caso-alvo: varios agentes apontam o mesmo problema na mesma linha em
  // categorias diferentes; o dedupe por (file, category) deixa passar, este corta.
  it('funde 3 findings de agentes/categorias diferentes na mesma linha mantendo a maior severidade', () => {
    const out = dedupeByLine([
      f({ agent: 'seguranca', category: 'any', severity: 'P2', startLine: 15, endLine: 15 }),
      f({ agent: 'arquitetura', category: 'tipo', severity: 'P0', startLine: 15, endLine: 15 }),
      f({ agent: 'regressao', category: 'lint', severity: 'P1', startLine: 15, endLine: 15 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.severity).toBe('P0');
  });
  it('preserva findings em linhas diferentes (gap > 1)', () => {
    const out = dedupeByLine([f({ endLine: 10 }), f({ endLine: 20 })]);
    expect(out).toHaveLength(2);
  });
  it('funde dentro da janela +-1 (endLine 14 e 15) e separa gap > 1 (15 e 17)', () => {
    const out = dedupeByLine([
      f({ category: 'a', severity: 'P1', endLine: 14 }),
      f({ category: 'b', severity: 'P0', endLine: 15 }),
      f({ category: 'c', severity: 'P2', endLine: 17 }),
    ]);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.severity).sort()).toEqual(['P0', 'P2']);
  });
  // Empate de severidade mantem o PRIMEIRO da ordem de entrada (sort estavel por index).
  it('em empate de severidade mantem o primeiro da ordem de entrada', () => {
    const out = dedupeByLine([
      f({ agent: 'primeiro', severity: 'P1', endLine: 15 }),
      f({ agent: 'segundo', severity: 'P1', endLine: 15 }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]?.agent).toBe('primeiro');
  });
});

describe('filterByCite', () => {
  it('remove findings sem ancora valida no diff', () => {
    const added = new Map([['a.ts', new Set([10, 11, 12])]]);
    const out = filterByCite([f({ cite: 'a.ts:10-12' }), f({ cite: 'a.ts:99-100' })], added);
    expect(out).toHaveLength(1);
  });
});

describe('runAdversarial', () => {
  it('descarta finding refutado pelo refuter injetado', async () => {
    const refuter: Refuter = async (finding) => ({ refuted: finding.category === 'falso', score: 9 });
    const out = await runAdversarial([f({ category: 'real' }), f({ category: 'falso' })], refuter, 0.8);
    expect(out.map((x) => x.category)).toEqual(['real']);
  });
  it('descarta finding com score abaixo do threshold', async () => {
    const refuter: Refuter = async () => ({ refuted: false, score: 3 });
    expect(await runAdversarial([f({})], refuter, 0.8)).toEqual([]);
  });
  // Regressao: o refutador chama o LLM (opencode) por finding. Uma rejeicao
  // transitoria (timeout/spawn/rede) NAO pode derrubar o batch inteiro nem
  // esconder os demais findings. Conservador de corretude: o finding cujo
  // refutador falhou e MANTIDO (refuted=false, score=10) — nunca silenciamos
  // um possivel bug por falha de infraestrutura.
  it('falha transitoria de um refuter nao derruba o batch e mantem o finding afetado', async () => {
    const refuter = new RefuterQueFalhaEm('quebra').asRefuter();
    const out = await runAdversarial(
      [f({ category: 'ok' }), f({ category: 'quebra' })],
      refuter,
      0.8,
    );
    expect(out.map((x) => x.category).sort()).toEqual(['ok', 'quebra']);
  });
});

describe('consolidateFindings', () => {
  const MODELO = 'deepseek/deepseek-v4-flash';

  it('retorna o subset que o consolidador devolveu (fusao semantica)', async () => {
    const entrada = [f({ category: 'a', title: 'dup A' }), f({ category: 'b', title: 'dup B' })];
    // O consolidador funde os dois num unico finding real.
    const fundido = JSON.stringify({ findings: [f({ category: 'a', title: 'dup A' })] });
    const fake = new ConsolidadorFake(fundido);
    const out = await consolidateFindings(entrada, fake.asRunner(), MODELO);
    expect(out).toHaveLength(1);
    expect(out[0]?.title).toBe('dup A');
  });

  // Fallback robusto: o consolidador devolveu vazio (modelo cortou/falhou) mas a entrada
  // tinha findings — jamais descartamos achados reais por erro do passo extra.
  it('cai no fallback (retorna a entrada original) quando o consolidador devolve vazio', async () => {
    const entrada = [f({ category: 'a' }), f({ category: 'b' })];
    const fake = new ConsolidadorFake('{"findings":[]}');
    const out = await consolidateFindings(entrada, fake.asRunner(), MODELO);
    expect(out).toEqual(entrada);
  });

  // Com <=1 finding nao ha o que fundir: pulamos a chamada ao LLM (economia).
  it('com 1 finding retorna sem chamar o runner', async () => {
    const fake = new ConsolidadorFake('{"findings":[]}');
    const out = await consolidateFindings([f({})], fake.asRunner(), MODELO);
    expect(out).toHaveLength(1);
    expect(fake.chamadas).toBe(0);
  });
});

describe('readAdversarialThreshold', () => {
  // defaults.yml prometia que gatekeeper.adversarial_threshold passaria a ser lido
  // a partir do Task 15; este teste fecha essa promessa (antes era hardcoded).
  it('le gatekeeper.adversarial_threshold do YAML', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'defaults.yml');
    writeFileSync(path, 'gatekeeper:\n  adversarial_threshold: 0.5\n');
    expect(readAdversarialThreshold(path)).toBe(0.5);
  });
  it('usa fallback 0.8 quando a chave esta ausente', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cfg-')), 'defaults.yml');
    writeFileSync(path, 'llm:\n  default_model: x\n');
    expect(readAdversarialThreshold(path)).toBe(0.8);
  });
});

describe('decideVerdict', () => {
  it('REQUEST_CHANGES/failure quando ha P1', () => {
    const v = decideVerdict([f({ severity: 'P1' })]);
    expect(v).toMatchObject({ event: 'REQUEST_CHANGES', conclusion: 'failure' });
  });
  it('APPROVE/success quando so ha P2', () => {
    const v = decideVerdict([f({ severity: 'P2' })]);
    expect(v).toMatchObject({ event: 'APPROVE', conclusion: 'success' });
  });
  it('APPROVE/success quando nao ha findings', () => {
    expect(decideVerdict([])).toMatchObject({ event: 'APPROVE', conclusion: 'success' });
  });
});
