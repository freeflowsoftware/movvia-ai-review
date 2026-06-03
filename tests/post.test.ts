import { describe, it, expect } from 'vitest';
import { summaryMarker, parseSummarySha, findingMarker, buildSummary, buildInlineComments, decideReviewEvent, reconcileInline, summaryRefFromComments, shouldReconcileByDelta } from '../lib/post.js';
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

describe('summaryRefFromComments', () => {
  // Logica PURA: dado os comentarios top-level do PR, acha o resumo NOSSO (marker) e
  // devolve { id, previousSha }. O previousSha alimenta o re-review por delta — sem ele
  // o post nao sabe qual era o SHA do ultimo review para calcular changedFiles.
  it('devolve id + previousSha do resumo existente (parse do body via parseSummarySha)', () => {
    const body = `## resumo\n${summaryMarker('deadbeef')}`;
    const ref = summaryRefFromComments([{ id: 42, body }]);
    expect(ref).toEqual({ id: 42, previousSha: 'deadbeef' });
  });

  it('1o review (sem resumo nosso) -> { id: null, previousSha: null }', () => {
    const ref = summaryRefFromComments([{ id: 7, body: 'comentario solto de dev' }]);
    expect(ref).toEqual({ id: null, previousSha: null });
  });

  it('acha o resumo entre varios comentarios (ignora os de humanos)', () => {
    const comments = [
      { id: 1, body: 'review humano' },
      { id: 99, body: `resumo\n${summaryMarker('abc1234')}` },
    ];
    expect(summaryRefFromComments(comments)).toEqual({ id: 99, previousSha: 'abc1234' });
  });

  it('resumo presente mas sem sha parseavel -> id setado, previousSha null', () => {
    // Resumo antigo (formato anterior, sem o marker de sha): reusa o id para o update
    // idempotente, mas nao ha SHA anterior -> cai no caminho de reconciliar tudo.
    const ref = summaryRefFromComments([{ id: 5, body: '<!-- movvia-ai-review:summary -->' }]);
    expect(ref).toEqual({ id: 5, previousSha: null });
  });
});

describe('shouldReconcileByDelta', () => {
  // Decisao PURA que o CLI usa para escolher entre reconciliar por delta (changedFiles)
  // ou o PR inteiro (undefined). So reconcilia por delta quando ha SHA anterior E ele
  // difere do atual (houve commit novo desde o ultimo review).
  it('true quando ha previousSha que difere do sha atual', () => {
    expect(shouldReconcileByDelta('aaaa111', 'bbbb222')).toBe(true);
  });

  it('false no 1o review (previousSha null) -> reconcilia o PR inteiro', () => {
    expect(shouldReconcileByDelta(null, 'bbbb222')).toBe(false);
  });

  it('false quando o SHA nao mudou (re-run sem commit novo) -> reconcilia tudo', () => {
    // Mesmo SHA = nada mudou; comparar previousSha contra ele mesmo daria delta vazio
    // e resolveria todas as threads por engano. Cai no caminho de reconciliar tudo.
    expect(shouldReconcileByDelta('same777', 'same777')).toBe(false);
  });
});

describe('reconcileInline (reconciliacao por proximidade)', () => {
  // findingLine = endLine do cite; uma thread "casa" com o finding se for o MESMO
  // arquivo e a linha estiver dentro de +-5 (LINE_PROX). Casar por proximidade (e nao
  // por marker exato) e o que impede o ACUMULO sob um modelo nao-deterministico.
  function makeFinding(file: string, endLine: number, category = 'cred'): Finding {
    return {
      agent: 'seguranca', file, startLine: endLine - 2, endLine, severity: 'P1',
      category, title: 't', rationale: 'r', suggestion: 's', cite: `${file}:${endLine - 2}-${endLine}`,
    };
  }
  // Thread NOSSA ja postada. `line` = posicao atual no head (chave da proximidade);
  // `isOutdated` = o dev mexeu na linha. `marker` so existe para satisfazer o tipo — a
  // reconciliacao por proximidade nao o usa mais.
  function thread(threadId: string, path: string, line: number, isOutdated: boolean): ExistingThread {
    return { marker: `<!-- movvia-ai-review:seguranca:${threadId} -->`, threadId, path, line, isOutdated };
  }

  it('(a) finding sem thread proxima entra em toPost (novo)', () => {
    const novo = makeFinding('novo.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline([novo], []);
    expect(toPost).toEqual([novo]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('(b) finding COM thread proxima (mesmo arquivo, linha +-5) nao re-posta -> sem ACUMULO', () => {
    // O modelo re-detectou o mesmo problema com linha levemente diferente; a proximidade
    // reconhece "e o mesmo" e NAO empilha um comentario novo a cada run.
    const f = makeFinding('persiste.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [f],
      [thread('T1', 'persiste.ts', 14, false)], // |12-14| = 2 <= 5 -> casa
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('(c) thread SEM finding proximo E outdated (dev mexeu na linha) -> resolve', () => {
    const { toPost, toResolveThreadIds } = reconcileInline(
      [],
      [thread('T9', 'corrigido.ts', 12, true)],
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual(['T9']);
  });

  it('(c2) thread SEM finding proximo MAS nao outdated (linha intacta) -> PRESERVA', () => {
    // FURO DE SEGURANCA FECHADO: o finding "sumiu" (modelo nao re-detectou) mas a linha
    // nao mudou -> problema vivo -> NAO resolve. Um P0 nunca fecha sem o dev tocar nele.
    const { toPost, toResolveThreadIds } = reconcileInline(
      [],
      [thread('T-VIVO', 'vulneravel.ts', 12, false)],
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('(d) finding longe da thread (>5 linhas) NAO casa: posta novo E thread vira candidata', () => {
    // Mesmo arquivo, linhas distantes = problemas diferentes. O novo posta; a thread
    // (sem finding proximo) resolve porque esta outdated.
    const novoLonge = makeFinding('a.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novoLonge],
      [thread('T-LONGE', 'a.ts', 40, true)], // |12-40| = 28 > 5
    );
    expect(toPost).toEqual([novoLonge]);
    expect(toResolveThreadIds).toEqual(['T-LONGE']);
  });

  it('(e) misto: persiste(proximo) fica, corrigido(outdated) resolve, vivo(intacto) preserva, novo posta', () => {
    const persiste = makeFinding('persiste.ts', 12);
    const novo = makeFinding('novo.ts', 20);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [persiste, novo],
      [
        thread('T1', 'persiste.ts', 12, false), // casa com persiste -> fica
        thread('T2', 'corrigido.ts', 12, true), // sem finding proximo + outdated -> resolve
        thread('T3', 'vivo.ts', 12, false),     // sem finding proximo + intacto -> preserva
      ],
    );
    expect(toPost).toEqual([novo]);
    expect(toResolveThreadIds).toEqual(['T2']);
  });
});

describe('reconcileInline por delta de arquivos (re-review incremental)', () => {
  // Reconciliar SO os arquivos do delta preserva as threads dos arquivos NAO-tocados;
  // dentro do delta, a proximidade (path + linha +-5) decide novo/persiste/resolve.
  function makeFinding(file: string, endLine: number, category = 'cred'): Finding {
    return {
      agent: 'seguranca', file, startLine: endLine - 2, endLine, severity: 'P1',
      category, title: 't', rationale: 'r', suggestion: 's', cite: `${file}:${endLine - 2}-${endLine}`,
    };
  }
  function thread(threadId: string, path: string, line: number, isOutdated: boolean): ExistingThread {
    return { marker: `<!-- movvia-ai-review:seguranca:${threadId} -->`, threadId, path, line, isOutdated };
  }

  it('sem changedFiles (1o review) reconcilia tudo', () => {
    const novo = makeFinding('novo.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novo],
      [thread('T2', 'corrigido.ts', 12, true)],
      undefined,
    );
    expect(toPost).toEqual([novo]);
    expect(toResolveThreadIds).toEqual(['T2']);
  });

  it('preserva finding E thread de arquivo FORA do delta (nem posta nem resolve)', () => {
    const intocadoNovo = makeFinding('intocado.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [intocadoNovo],
      [thread('T-INTOCADO', 'intocado.ts', 40, true)], // outdated mas FORA do delta
      ['outro.ts'],
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual([]);
  });

  it('arquivo NO delta, thread outdated sem finding proximo: novo posta, sumido resolve', () => {
    const novoNoDelta = makeFinding('mexido.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novoNoDelta],
      [thread('T-MEXIDO', 'mexido.ts', 40, true)], // linha distante (28>5) + outdated
      ['mexido.ts'],
    );
    expect(toPost).toEqual([novoNoDelta]);
    expect(toResolveThreadIds).toEqual(['T-MEXIDO']);
  });

  it('arquivo NO delta MAS thread NAO outdated (linha intacta) -> PRESERVA', () => {
    // Ex real #475: corrigi dead code numa linha do service (T-CORRIGIDO, outdated) mas
    // o cross-tenant P0 em OUTRA linha do MESMO arquivo (T-VIVO, intacta) segue vivo ->
    // nao pode fechar. So o outdated resolve.
    const { toPost, toResolveThreadIds } = reconcileInline(
      [],
      [thread('T-CORRIGIDO', 'service.ts', 12, true), thread('T-VIVO', 'service.ts', 40, false)],
      ['service.ts'],
    );
    expect(toPost).toEqual([]);
    expect(toResolveThreadIds).toEqual(['T-CORRIGIDO']);
  });

  it('anti-ACUMULO no delta: finding re-detectado proximo da thread existente NAO vira novo', () => {
    // O cerne do fix de DX: re-revisar o arquivo do delta re-detecta o mesmo problema
    // 1 linha adiante; casar por proximidade impede empilhar um comentario a cada run.
    const reDetectado = makeFinding('mexido.ts', 13);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [reDetectado],
      [thread('T-EXISTE', 'mexido.ts', 12, false)], // |13-12| = 1 <= 5 -> casa
      ['mexido.ts'],
    );
    expect(toPost).toEqual([]); // nao acumula
    expect(toResolveThreadIds).toEqual([]); // persiste (tem match, nao outdated)
  });

  it('delta misto: reconcilia os do delta e preserva os de fora simultaneamente', () => {
    const novoNoDelta = makeFinding('mexido.ts', 12);
    const persistenteForaDelta = makeFinding('intocado.ts', 12);
    const { toPost, toResolveThreadIds } = reconcileInline(
      [novoNoDelta, persistenteForaDelta],
      [thread('T-SUMIDA', 'mexido.ts', 40, true), thread('T-FORA', 'intocado.ts', 40, true)],
      ['mexido.ts'],
    );
    expect(toPost).toEqual([novoNoDelta]);
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
