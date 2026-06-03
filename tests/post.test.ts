import { describe, it, expect } from 'vitest';
import { summaryMarker, parseSummarySha, findingMarker, buildSummary, buildInlineComments, decideReviewEvent, reconcileInline } from '../lib/post.js';
import type { ExistingThread } from '../lib/post.js';
import { findingId } from '../lib/gatekeeper.js';
import type { Finding, Verdict } from '../lib/types.js';

const verdict: Verdict = { event: 'REQUEST_CHANGES', conclusion: 'failure', counts: { P0: 1, P1: 0, P2: 2 } };
const findings: Finding[] = [{
  agent: 'seguranca', file: 'a.ts', startLine: 10, endLine: 12, severity: 'P0',
  category: 'cred', title: 'Token hardcoded', rationale: 'r', suggestion: 's', cite: 'a.ts:10-12',
}];

describe('summaryMarker / parseSummarySha', () => {
  it('embute e extrai o sha', () => {
    const marker = summaryMarker('abc1234');
    expect(parseSummarySha(`texto\n${marker}\nmais`)).toBe('abc1234');
  });
  it('retorna null quando nao ha marker (PR ainda nao revisado)', () => {
    expect(parseSummarySha('sem marker')).toBeNull();
  });
});

describe('findingMarker', () => {
  it('inclui o id estavel do finding (ancorado em findingId do gatekeeper)', () => {
    // O marker e a ancora de dedup contra threads existentes; deve carregar o
    // mesmo id estavel que o gatekeeper usa, nao a linha crua.
    expect(findingMarker(findings[0]!)).toContain(findingId(findings[0]!));
  });

  it('produz o MESMO marker quando o codigo desloca 1 linha (idempotencia)', () => {
    // Dedup-contra-threads-existentes so funciona se um commit que empurra o
    // codigo nao gerar um marker novo. Mesmo arquivo/categoria, startLine
    // deslocado dentro do bucket -> marker identico -> nao duplica comentario.
    const original = findings[0]!;
    const deslocado: Finding = { ...original, startLine: original.startLine + 1, endLine: original.endLine + 1 };
    expect(findingMarker(deslocado)).toBe(findingMarker(original));
  });
});

describe('buildInlineComments', () => {
  it('ancora cada comentario no path do arquivo e em endLine (fim do trecho citado)', () => {
    // Diferencial do prototipo /revisar-pr: o comentario cai NA linha exata da
    // ofensa. endLine (nao startLine) porque o GitHub exige que `line` seja a
    // ultima linha do range RUNNING do diff; ancorar no fim casa a thread com o
    // trecho inteiro citado em `cite`.
    const comments = buildInlineComments(findings);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.path).toBe('a.ts');
    expect(comments[0]!.line).toBe(12);
  });

  it('monta o body com severidade, titulo, rationale, suggestion e o marker de dedup', () => {
    // O body carrega tudo que o autor humano precisa para agir, e termina com o
    // findingMarker invisivel — ancora estavel de dedup idempotente entre re-runs.
    const body = buildInlineComments(findings)[0]!.body;
    expect(body).toContain('P0');
    expect(body).toContain('Token hardcoded');
    expect(body).toContain('r'); // rationale
    expect(body).toContain('s'); // suggestion
    expect(body).toContain(findingMarker(findings[0]!));
  });

  it('produz um comentario por finding preservando a ordem', () => {
    const segundo: Finding = {
      ...findings[0]!, file: 'b.ts', startLine: 30, endLine: 31, title: 'Outro', category: 'perf', cite: 'b.ts:30-31',
    };
    const comments = buildInlineComments([findings[0]!, segundo]);
    expect(comments.map((c) => c.path)).toEqual(['a.ts', 'b.ts']);
    expect(comments.map((c) => c.line)).toEqual([12, 31]);
  });
});

describe('decideReviewEvent', () => {
  it('mantem o veredicto formal quando ha identidade forte (App/PAT)', () => {
    expect(decideReviewEvent('REQUEST_CHANGES', true)).toBe('REQUEST_CHANGES');
    expect(decideReviewEvent('APPROVE', true)).toBe('APPROVE');
  });
  it('cai para COMMENT quando so ha GITHUB_TOKEN (sem identidade que conta)', () => {
    expect(decideReviewEvent('REQUEST_CHANGES', false)).toBe('COMMENT');
    expect(decideReviewEvent('APPROVE', false)).toBe('COMMENT');
  });
});

describe('buildSummary', () => {
  it('mostra contagem por severidade, veredicto e carimba o sha', () => {
    const s = buildSummary(findings, verdict, 'abc1234');
    expect(s).toContain('1 P0');
    expect(s).toContain('Mudancas necessarias');
    expect(s).toContain(summaryMarker('abc1234'));
  });
});

describe('reconcileInline', () => {
  // Helper: monta um finding distinto (file/category controlam o findingMarker).
  function makeFinding(file: string, category: string): Finding {
    return {
      agent: 'seguranca', file, startLine: 10, endLine: 12, severity: 'P1',
      category, title: 't', rationale: 'r', suggestion: 's', cite: `${file}:10-12`,
    };
  }
  // Helper: simula uma thread inline NOSSA ja postada (marker + id + arquivo da thread).
  // O `path` deriva do cite do finding (o arquivo onde o comentario ancorou).
  function existingFor(f: Finding, threadId: string): ExistingThread {
    return { marker: findingMarker(f), threadId, path: f.file };
  }

  it('(a) finding novo (sem thread) entra em toPost', () => {
    const novo = makeFinding('novo.ts', 'cred');
    const { toPost, toResolveThreadIds } = reconcileInline([novo], []);
    expect(toPost).toEqual([novo]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('(b) finding com comentario existente (mesmo marker) nao re-posta', () => {
    const persistente = makeFinding('persiste.ts', 'cred');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [persistente],
      [existingFor(persistente, 'T1')],
    );
    // Marker em ambos -> nem re-posta (dedup) nem resolve (continua pendente).
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('(c) marker existente que sumiu dos findings -> threadId em toResolve', () => {
    // O dev corrigiu o problema: o finding desapareceu, entao a thread fecha.
    const corrigido = makeFinding('corrigido.ts', 'cred');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [],
      [existingFor(corrigido, 'T9')],
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual(['T9']);
  });

  it('(d) caso misto: novo posta, persistente fica, corrigido resolve', () => {
    const persistente = makeFinding('persiste.ts', 'cred');
    const corrigido = makeFinding('corrigido.ts', 'perf');
    const novo = makeFinding('novo.ts', 'lock');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [persistente, novo],
      [existingFor(persistente, 'T1'), existingFor(corrigido, 'T2')],
    );
    expect(toPost).toEqual([novo]);
    expect(toResolveThreadIds).toEqual(['T2']);
  });
});

describe('reconcileInline por delta de arquivos (re-review incremental)', () => {
  // O re-review nao-deterministico re-gera markers diferentes a cada run (modelo
  // varia category/linha). Reconciliar SO os arquivos do delta preserva as threads
  // dos arquivos NAO-tocados, evitando churn de resolve+repost desnecessario.
  function makeFinding(file: string, category: string): Finding {
    return {
      agent: 'seguranca', file, startLine: 10, endLine: 12, severity: 'P1',
      category, title: 't', rationale: 'r', suggestion: 's', cite: `${file}:10-12`,
    };
  }
  function existingFor(f: Finding, threadId: string): ExistingThread {
    return { marker: findingMarker(f), threadId, path: f.file };
  }

  it('sem changedFiles (1o review) reconcilia tudo, igual ao comportamento atual', () => {
    // changedFiles undefined = nao ha SHA anterior -> reconcilia o PR inteiro.
    const novo = makeFinding('novo.ts', 'cred');
    const corrigido = makeFinding('corrigido.ts', 'perf');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novo],
      [existingFor(corrigido, 'T2')],
      undefined,
    );
    expect(toPost).toEqual([novo]);
    expect(toResolveThreadIds).toEqual(['T2']);
  });

  it('preserva finding E thread de arquivo FORA do delta (nem posta nem resolve)', () => {
    // intocado.ts nao mudou desde o ultimo review: seu finding novo nao deve postar
    // e sua thread orfa (sem finding correspondente neste run) nao deve resolver.
    const intocadoNovo = makeFinding('intocado.ts', 'cred');
    const intocadoThread = makeFinding('intocado.ts', 'perf');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [intocadoNovo],
      [existingFor(intocadoThread, 'T-INTOCADO')],
      ['outro.ts'], // delta nao inclui intocado.ts
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('arquivo NO delta reconcilia normal: novo posta, sumido resolve', () => {
    const novoNoDelta = makeFinding('mexido.ts', 'cred');
    const sumidoNoDelta = makeFinding('mexido.ts', 'perf');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novoNoDelta],
      [existingFor(sumidoNoDelta, 'T-MEXIDO')],
      ['mexido.ts'], // delta inclui mexido.ts
    );
    expect(toPost).toEqual([novoNoDelta]);
    expect(toResolveThreadIds).toEqual(['T-MEXIDO']);
  });

  it('delta misto: reconcilia os do delta e preserva os de fora simultaneamente', () => {
    const novoNoDelta = makeFinding('mexido.ts', 'cred');
    const persistenteForaDelta = makeFinding('intocado.ts', 'lock');
    const threadSumidaNoDelta = makeFinding('mexido.ts', 'perf');
    const threadForaDelta = makeFinding('intocado.ts', 'lock');
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novoNoDelta, persistenteForaDelta],
      [existingFor(threadSumidaNoDelta, 'T-SUMIDA'), existingFor(threadForaDelta, 'T-FORA')],
      ['mexido.ts'],
    );
    // novo do delta posta; fora do delta nao posta (preservado).
    expect(toPost).toEqual([novoNoDelta]);
    // thread sumida do delta resolve; thread de fora preservada.
    expect(toResolveThreadIds).toEqual(['T-SUMIDA']);
  });

  it('prioriza o arquivo do cite sobre o file cru para checar o delta', () => {
    // parseCite.file e a fonte de verdade (validado contra o diff); file cru pode
    // vir absoluto. O delta deve casar pelo cite, nao pelo file divergente.
    const f: Finding = {
      agent: 'seguranca', file: '/abs/checkout/mexido.ts', startLine: 10, endLine: 12,
      severity: 'P1', category: 'cred', title: 't', rationale: 'r', suggestion: 's',
      cite: 'mexido.ts:10-12',
    };
    const { toPost } = reconcileInline([f], [], ['mexido.ts']);
    expect(toPost).toEqual([f]);
  });
});
