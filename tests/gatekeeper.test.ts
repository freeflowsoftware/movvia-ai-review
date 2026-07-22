// tests/gatekeeper.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { findingId, dedupe, dedupeByLine, decideVerdict, filterByCite, runAdversarial, readAdversarialThreshold, consolidateFindings, buildRefuteUserPrompt, buildRefuter, capProcessGateSeverity, refuteByPresence, type Refuter } from '../lib/gatekeeper.js';
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

describe('buildRefuteUserPrompt', () => {
  // O cetico refuta com base FACTUAL: quando o context-pack traz o trecho do arquivo do
  // finding, ele entra no prompt para o refutador confirmar se o "ausente" ja segue o padrao.
  it('injeta o trecho do codebase quando fornecido', () => {
    const prompt = buildRefuteUserPrompt(f({ file: 'conta.service.ts' }), 'class ContaService { valida() {} }');
    expect(prompt).toContain('Contexto do codebase do arquivo:');
    expect(prompt).toContain('class ContaService { valida() {} }');
  });
  // Retrocompat: sem excerpt o prompt continua identico ao anterior (sem a secao de contexto),
  // para nao quebrar callers/testes legados nem poluir o prompt em PRs sem context-pack.
  it('omite a secao de contexto quando o excerpt nao e fornecido', () => {
    const prompt = buildRefuteUserPrompt(f({ file: 'conta.service.ts' }));
    expect(prompt).not.toContain('Contexto do codebase do arquivo:');
    expect(prompt).toContain('Arquivo: conta.service.ts');
  });
  // Excerpt vazio (arquivo sem secao no pack) tambem omite — string vazia nao e "ausencia".
  it('omite a secao de contexto quando o excerpt e vazio', () => {
    const prompt = buildRefuteUserPrompt(f({}), '');
    expect(prompt).not.toContain('Contexto do codebase do arquivo:');
  });
});

describe('buildRefuter (context-aware)', () => {
  /**
   * Fake nomeado do ChatRunner: captura o ultimo USER prompt recebido para o teste
   * inspecionar se o excerpt do arquivo do finding foi de fato injetado.
   */
  class ChatRunnerEspiao {
    ultimoUser = '';
    asRunner(): ChatRunner {
      return async (_model, _system, user) => {
        this.ultimoUser = user;
        return '{"refuted":false,"score":9}';
      };
    }
  }

  it('passa ao prompt o excerpt do pack correspondente ao file do finding', async () => {
    const espiao = new ChatRunnerEspiao();
    // Provider de excerpt injetado (DIP): so o arquivo do finding resolve um trecho.
    const excerptFor = (file: string): string => (file === 'a.ts' ? 'EXCERPT DE a.ts' : '');
    const refute = buildRefuter(espiao.asRunner(), 'modelo-x', excerptFor);
    await refute(f({ file: 'a.ts' }));
    expect(espiao.ultimoUser).toContain('Contexto do codebase do arquivo:');
    expect(espiao.ultimoUser).toContain('EXCERPT DE a.ts');
  });

  it('sem provider de excerpt mantem o prompt sem a secao de contexto (retrocompat)', async () => {
    const espiao = new ChatRunnerEspiao();
    const refute = buildRefuter(espiao.asRunner(), 'modelo-x');
    await refute(f({ file: 'a.ts' }));
    expect(espiao.ultimoUser).not.toContain('Contexto do codebase do arquivo:');
  });

  // Anti-alucinacao do PROPRIO cetico (lição do PR #475): se ele MANTEM o finding citando
  // uma evidencia que NAO existe no codigo, ele inventou a prova -> descarta.
  it('descarta quando o cetico mantem (refuted=false) citando evidencia INEXISTENTE no excerpt', async () => {
    const run: ChatRunner = async () => '{"refuted":false,"score":9,"evidence":"if (valorTotal < 0)"}';
    const refute = buildRefuter(run, 'm', () => 'let valorTotal = 0; for (const v of itens) valorTotal += v.x;');
    expect(await refute(f({ file: 'a.ts' }))).toEqual({ refuted: true, score: 0 });
  });

  it('mantem (refuted=false) quando a evidencia citada EXISTE no excerpt', async () => {
    const run: ChatRunner = async () => '{"refuted":false,"score":9,"evidence":"metodoReal()"}';
    const refute = buildRefuter(run, 'm', () => 'class X { metodoReal() { return 1; } }');
    expect(await refute(f({ file: 'a.ts' }))).toEqual({ refuted: false, score: 9 });
  });

  it('evidencia vazia NAO forca descarte (preserva recall de finding real nao-transcrito)', async () => {
    const run: ChatRunner = async () => '{"refuted":false,"score":9,"evidence":""}';
    const refute = buildRefuter(run, 'm', () => 'class X {}');
    expect(await refute(f({ file: 'a.ts' }))).toEqual({ refuted: false, score: 9 });
  });
});

describe('buildRefuteUserPrompt — severidade e evidencia', () => {
  it('inclui a severidade alegada e pede a evidencia literal', () => {
    const prompt = buildRefuteUserPrompt(f({ severity: 'P0' }));
    expect(prompt).toContain('Severidade alegada: P0');
    expect(prompt).toContain('evidence');
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
  // Fail-closed (ACID): uma dimensao degradada (timeout) NAO pode virar "verde limpo" — o
  // estado que o gate le (conclusion) tem de ser bloqueante, nao so uma nota textual.
  it('REQUEST_CHANGES/failure quando ha dimensao degradada, mesmo sem findings bloqueantes', () => {
    const v = decideVerdict([f({ severity: 'P2' })], ['regressao']);
    expect(v).toMatchObject({ event: 'REQUEST_CHANGES', conclusion: 'failure' });
  });
  it('degraded vazio nao altera o veredito (retrocompat)', () => {
    expect(decideVerdict([f({ severity: 'P2' })], [])).toMatchObject({ event: 'APPROVE', conclusion: 'success' });
  });
});

describe('capProcessGateSeverity', () => {
  it('capa findings do adr-guardian em P2 (gate de processo nunca bloqueia merge)', () => {
    const out = capProcessGateSeverity([f({ agent: 'adr-guardian', severity: 'P1' }), f({ agent: 'seguranca', severity: 'P0' })]);
    expect(out[0]!.severity).toBe('P2');
    expect(out[1]!.severity).toBe('P0'); // agente de codigo intacto
  });
  it('nao altera findings de outros agentes nem os ja P2', () => {
    const out = capProcessGateSeverity([f({ agent: 'requisitos', severity: 'P1' }), f({ agent: 'adr-guardian', severity: 'P2' })]);
    expect(out[0]!.severity).toBe('P1'); // requisitos NAO e capado
    expect(out[1]!.severity).toBe('P2');
  });
});

describe('refuteByPresence (guard determinístico, sem LLM)', () => {
  const index = {
    symbols: ['ConsultaAlertaEmail', 'RvHero', 'LockService'],
    testSubjects: ['useIsAndroid'],
    envKeys: ['ENABLE_CONSULTA_ALERTA_REMINDERS'],
  };

  it('suprime P0 "model X ausente" quando o model existe no repo (SEO-42/PR640)', () => {
    const finding = f({
      severity: 'P0', file: 'src/consulta-alerta.service.ts',
      title: 'Model Prisma consultaAlertaEmail ausente no schema',
      rationale: 'O model `ConsultaAlertaEmail` nao existe no schema.prisma — quebra de compilacao.',
    });
    const { kept, suppressed } = refuteByPresence([finding], index);
    expect(kept).toEqual([]);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]!.reason).toContain('ConsultaAlertaEmail');
  });

  it('suprime "sem testes" quando o teste co-locado existe (PR763)', () => {
    const finding = f({
      severity: 'P2', category: 'test-coverage', file: 'apps/pe-portal/hooks/useIsAndroid.ts',
      title: 'Hook useIsAndroid nao possui testes unitarios',
      rationale: 'Adicionar testes para o hook useIsAndroid.',
    });
    const { kept } = refuteByPresence([finding], index);
    expect(kept).toEqual([]);
  });

  it('suprime "flag ausente no .env.example" quando a chave existe (PR69-FP3)', () => {
    const finding = f({
      severity: 'P2', file: 'src/config/rabbitmq.setup.ts',
      title: 'Flag ENABLE_CONSULTA_ALERTA_REMINDERS nao esta no .env.example',
      rationale: 'A variavel ENABLE_CONSULTA_ALERTA_REMINDERS nao esta documentada no .env.example.',
    });
    const { kept } = refuteByPresence([finding], index);
    expect(kept).toEqual([]);
  });

  it('suprime "componente nao implementado" (existência estrita) quando o componente existe', () => {
    const finding = f({
      severity: 'P1', file: 'app/_rota-verde/rota-verde-detalhe.tsx',
      title: 'Componente RvHero nao esta implementado',
      rationale: 'O componente `RvHero` nao foi encontrado.',
    });
    const { kept } = refuteByPresence([finding], index);
    expect(kept).toEqual([]);
  });

  // Regressão SEO-153 / gap apontado no review manual: um componente PODE existir no repo
  // e ainda assim não ser renderizado no fluxo citado. Isso é AUSÊNCIA COMPORTAMENTAL — não
  // pode ser suprimida por presença global do símbolo. Antes o padrão "renderizad" caía em
  // EXISTENCE_ABSENCE e o guard suprimia esse tipo de finding indevidamente.
  it('PRESERVA "componente X nao e renderizado" mesmo com o simbolo no indice (comportamental)', () => {
    const finding = f({
      severity: 'P1', file: 'app/_rota-verde/rota-verde-detalhe.tsx',
      title: 'Hero RvHero nao e renderizado na pagina',
      rationale: 'O componente `RvHero` existe mas nao e renderizado no fluxo de detalhe.',
    });
    const { kept, suppressed } = refuteByPresence([finding], index);
    expect(kept).toEqual([finding]);
    expect(suppressed).toEqual([]);
  });

  it('PRESERVA "does not render" (EN) mesmo com o simbolo no indice (comportamental)', () => {
    const finding = f({
      severity: 'P1', file: 'app/page.tsx',
      title: 'Page does not render RvHero',
      rationale: 'Layout does not render `RvHero` — component defined but never mounted.',
    });
    const { kept } = refuteByPresence([finding], index);
    expect(kept).toEqual([finding]);
  });

  // Regressao adversarial: reproduz o texto SEO-153 original combinado. Existe uma claim
  // de existencia ("nao foi encontrado" bate EXISTENCE_ABSENCE) E uma claim comportamental
  // ("nao e renderizado", sem acento como PT-BR de LLM sem locale). O guard checa
  // BEHAVIORAL primeiro; se a regex nao aceitar "e" desacentuado, o texto cai em
  // EXISTENCE_ABSENCE e RvHero (no indice) suprime o finding indevidamente.
  it('PRESERVA texto combinado "nao foi encontrado / nao e renderizado" (sem acento, SEO-153 real)', () => {
    const finding = f({
      severity: 'P1', file: 'app/_rota-verde/rota-verde-detalhe.tsx',
      title: 'Componente RvHero nao esta implementado no fluxo',
      rationale: 'O componente `RvHero` nao foi encontrado / nao e renderizado no template de detalhe.',
    });
    const { kept, suppressed } = refuteByPresence([finding], index);
    expect(kept).toEqual([finding]);
    expect(suppressed).toEqual([]);
  });

  it('PRESERVA ausencia comportamental P0 mesmo com o simbolo no indice (recall)', () => {
    // "nao usa LockService" e ausencia de COMPORTAMENTO; LockService existe no repo. NAO suprimir.
    const finding = f({
      severity: 'P0', category: 'lock', file: 'src/saldo.service.ts',
      title: 'Operacao de saldo sem lock distribuido',
      rationale: 'O read-modify-write de saldo nao usa LockService — race financeira.',
    });
    const { kept } = refuteByPresence([finding], index);
    expect(kept).toEqual([finding]);
  });

  it('PRESERVA ausencia de existencia REAL quando o simbolo NAO esta no indice', () => {
    const finding = f({
      severity: 'P0', title: 'Model Prisma Fantasma ausente no schema',
      rationale: 'O model `Fantasma` nao existe no schema.prisma.',
    });
    const { kept } = refuteByPresence([finding], index);
    expect(kept).toEqual([finding]);
  });

  it('deixa passar findings que nao sao alegacao de ausencia', () => {
    const finding = f({ title: 'N+1 query no loop', rationale: 'findMany dentro do for.' });
    const { kept, suppressed } = refuteByPresence([finding], index);
    expect(kept).toEqual([finding]);
    expect(suppressed).toEqual([]);
  });
});
