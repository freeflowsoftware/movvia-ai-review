import { describe, it, expect } from 'vitest';
import {
  parseDismissCommand,
  decideDismiss,
  buildFeedbackIssue,
  feedbackIssueMarker,
  dismissRun,
  type DismissDeps,
  type DismissInput,
  type DismissConfig,
  type DismissedFinding,
  type FeedbackIssue,
} from '../lib/dismiss.js';
import type { Withdrawal } from '../lib/withdrawals.js';
import type { ChatRunner } from '../lib/run-agent.js';

// Dispensa MANUAL por comando (PED-2728). Motivo OBRIGATORIO; P0 so por CODEOWNER + flag
// (ADR-002, default bloqueado). Write do store PRIMEIRO (duravel); issue de feedback DEPOIS
// (best-effort, nunca desfaz o dismiss). Nucleo puro + FakeDismissDeps sem rede.

describe('parseDismissCommand (motivo obrigatorio)', () => {
  it('dismiss com id 12-hex + motivo suficiente', () => {
    const r = parseDismissCommand('/ai-review dismiss abc123def456 motivo bem detalhado', 15);
    expect(r).toEqual({ kind: 'dismiss', findingId: 'abc123def456', motivo: 'motivo bem detalhado' });
  });

  it('extrai o findingId de um marker colado inteiro', () => {
    const r = parseDismissCommand(
      '/ai-review dismiss <!-- movvia-ai-review:seguranca:abc123def456 --> e falso positivo mesmo',
      15,
    );
    expect(r).toEqual({ kind: 'dismiss', findingId: 'abc123def456', motivo: 'e falso positivo mesmo' });
  });

  it('motivo ausente -> invalid', () => {
    expect(parseDismissCommand('/ai-review dismiss abc123def456', 15)?.kind).toBe('invalid');
  });

  it('motivo curto (< minMotivoLen) -> invalid', () => {
    expect(parseDismissCommand('/ai-review dismiss abc123def456 curto', 15)?.kind).toBe('invalid');
  });

  it('findingId invalido -> invalid', () => {
    expect(parseDismissCommand('/ai-review dismiss xyz motivo suficientemente longo', 15)?.kind).toBe('invalid');
  });

  it('undismiss nao exige motivo', () => {
    expect(parseDismissCommand('/ai-review undismiss abc123def456', 15)).toEqual({ kind: 'undismiss', findingId: 'abc123def456' });
  });

  it('comando fora do dismiss -> null', () => {
    expect(parseDismissCommand('/ai-review --full', 15)).toBeNull();
    expect(parseDismissCommand('comentario qualquer', 15)).toBeNull();
  });
});

describe('decideDismiss (politica P0)', () => {
  it('P1/P2 sempre write', () => {
    expect(decideDismiss('P1', false, false)).toEqual({ action: 'write' });
    expect(decideDismiss('P2', false, false)).toEqual({ action: 'write' });
  });
  it('P0 com politica OFF -> reject (mesmo CODEOWNER)', () => {
    expect(decideDismiss('P0', true, false).action).toBe('reject');
  });
  it('P0 com politica ON mas NAO-CODEOWNER -> reject', () => {
    expect(decideDismiss('P0', false, true).action).toBe('reject');
  });
  it('P0 com politica ON e CODEOWNER -> write', () => {
    expect(decideDismiss('P0', true, true)).toEqual({ action: 'write' });
  });
});

describe('buildFeedbackIssue', () => {
  const finding: DismissedFinding = {
    findingId: 'abc123def456', severity: 'P1', file: 'a.ts', agent: 'seguranca',
    category: '', title: 'Lock ausente', rationale: 'r', suggestion: 's',
  };
  it('embute o marker de idempotencia e as labels', () => {
    const issue = buildFeedbackIssue(finding, 'motivo', 'dev', 'http://pr/1', 'analise');
    expect(issue.body).toContain(feedbackIssueMarker('abc123def456'));
    expect(issue.labels).toEqual(['dismiss-feedback', 'false-positive']);
    expect(issue.title).toContain('seguranca');
  });
});

// Fake nomeado das bordas do dismiss: registra write/reply/resolve/issue sem tocar a rede.
class FakeDismissDeps implements DismissDeps {
  public written: Withdrawal[] | null = null;
  public replies: string[] = [];
  public resolved: string[] = [];
  public issuesCreated: FeedbackIssue[] = [];
  constructor(
    private readonly finding: DismissedFinding | null,
    private readonly store: Withdrawal[] = [],
    private readonly opts: { codeowner?: boolean; issueFails?: boolean } = {},
  ) {}
  findFindingById = async () => this.finding;
  isCodeowner = async () => this.opts.codeowner ?? false;
  readWithdrawals = async () => this.written ?? this.store;
  writeWithdrawals = async (list: Withdrawal[]) => { this.written = list; };
  resolveThreadFor = async (id: string) => { this.resolved.push(id); };
  reply = async (body: string) => { this.replies.push(body); };
  fileProvider = async () => 'linha1\nlinha2';
  run: ChatRunner = async () => 'analise do llm';
  createFeedbackIssue = async (issue: FeedbackIssue) => {
    if (this.opts.issueFails) throw new Error('falha ao abrir issue');
    this.issuesCreated.push(issue);
    return 'http://movvia-ai-review/issues/1';
  };
}

const finding = (over: Partial<DismissedFinding> = {}): DismissedFinding => ({
  findingId: 'abc123def456', severity: 'P1', file: 'a.ts', agent: 'seguranca',
  category: '', title: 'Lock ausente', rationale: 'r', suggestion: 's', ...over,
});
const input = (commentBody: string): DismissInput => ({
  commentBody, author: 'dev', headSha: 'sha1', now: '2026-07-22T00:00:00Z', prUrl: 'http://pr/1',
});
const cfg = (over: Partial<DismissConfig> = {}): DismissConfig => ({
  minMotivoLen: 15, allowP0Policy: false, feedbackModel: 'm', feedbackRepo: 'freeflowsoftware/movvia-ai-review', ...over,
});

describe('dismissRun (invariantes)', () => {
  it('dismiss P1 valido -> write no store (com motivo) + resolve + reply + issue', async () => {
    const deps = new FakeDismissDeps(finding(), []);
    await dismissRun(input('/ai-review dismiss abc123def456 motivo bem detalhado'), deps, cfg());
    expect(deps.written).toHaveLength(1);
    expect(deps.written![0]!.motivo).toBe('motivo bem detalhado');
    expect(deps.written![0]!.severity).toBe('P1');
    expect(deps.resolved).toEqual(['abc123def456']);
    expect(deps.issuesCreated).toHaveLength(1);
  });

  it('motivo insuficiente -> no-op (nao grava), so reply de uso', async () => {
    const deps = new FakeDismissDeps(finding(), []);
    await dismissRun(input('/ai-review dismiss abc123def456 curto'), deps, cfg());
    expect(deps.written).toBeNull();
    expect(deps.replies[0]).toContain('motivo obrigatorio');
  });

  it('findingId nao encontrado -> reply, sem gravar', async () => {
    const deps = new FakeDismissDeps(null, []);
    await dismissRun(input('/ai-review dismiss abc123def456 motivo bem detalhado'), deps, cfg());
    expect(deps.written).toBeNull();
    expect(deps.replies[0]).toContain('nao encontrado');
  });

  it('P0 com politica ON mas NAO-CODEOWNER -> reject, store intacto', async () => {
    const deps = new FakeDismissDeps(finding({ severity: 'P0' }), [], { codeowner: false });
    await dismissRun(input('/ai-review dismiss abc123def456 motivo bem detalhado'), deps, cfg({ allowP0Policy: true }));
    expect(deps.written).toBeNull();
    expect(deps.replies[0]).toContain('recusada');
  });

  it('P0 CODEOWNER + politica ON -> grava P0 no store', async () => {
    const deps = new FakeDismissDeps(finding({ severity: 'P0' }), [], { codeowner: true });
    await dismissRun(input('/ai-review dismiss abc123def456 motivo bem detalhado'), deps, cfg({ allowP0Policy: true }));
    expect(deps.written).toHaveLength(1);
    expect(deps.written![0]!.severity).toBe('P0');
  });

  it('P0 CODEOWNER mas politica OFF -> reject (default bloqueado)', async () => {
    const deps = new FakeDismissDeps(finding({ severity: 'P0' }), [], { codeowner: true });
    await dismissRun(input('/ai-review dismiss abc123def456 motivo bem detalhado'), deps, cfg({ allowP0Policy: false }));
    expect(deps.written).toBeNull();
  });

  it('undismiss remove a entry do store', async () => {
    const existente: Withdrawal = { findingId: 'abc123def456', severity: 'P1', acceptedSha: 's', acceptedAt: 't', acceptedBy: 'dev', category: '', file: 'a.ts' };
    const deps = new FakeDismissDeps(finding(), [existente]);
    await dismissRun(input('/ai-review undismiss abc123def456'), deps, cfg());
    expect(deps.written).toEqual([]);
    expect(deps.replies[0]).toContain('revertida');
  });

  it('falha ao abrir a issue NAO desfaz o dismiss (store ja durável)', async () => {
    const deps = new FakeDismissDeps(finding(), [], { issueFails: true });
    await dismissRun(input('/ai-review dismiss abc123def456 motivo bem detalhado'), deps, cfg());
    expect(deps.written).toHaveLength(1);
    expect(deps.replies.some((r) => r.includes('dispensado'))).toBe(true);
  });
});
