import { describe, it, expect } from 'vitest';
import {
  parseJudgeVerdict,
  decideJudge,
  shouldJudge,
  judgeRun,
  type JudgeDeps,
  type JudgeInput,
} from '../lib/judge.js';
import type { ChatRunner } from '../lib/run-agent.js';
import type { Withdrawal } from '../lib/withdrawals.js';

// O judge avalia o PUSHBACK textual do dev numa thread. Válido (com evidência verificável
// no código) -> concorda, FECHA P1/P2 e registra no store. Inválido -> refuta e mantém.
// P0 NUNCA fecha por argumento (early-return -> reply_only). Anti-loop por identidade do
// bot + circuit-breaker por contagem. Fail-closed: na dúvida REPLY, nunca WITHDRAW.

describe('parseJudgeVerdict (fail-closed)', () => {
  it('JSON valido com evidencia parseia', () => {
    const v = parseJudgeVerdict('{"valid":true,"evidenceCite":"auth.ts:40","reason":"ja valida"}');
    expect(v).toEqual({ valid: true, evidenceCite: 'auth.ts:40', reason: 'ja valida' });
  });
  it('ilegivel -> {valid:false} (na duvida NAO fecha)', () => {
    expect(parseJudgeVerdict('texto').valid).toBe(false);
    expect(parseJudgeVerdict('{quebrado').valid).toBe(false);
  });
  it('valid:true mas evidenceCite vazio -> evidenceCite null (sem evidencia nao procede)', () => {
    expect(parseJudgeVerdict('{"valid":true,"evidenceCite":"","reason":"confia"}').evidenceCite).toBeNull();
  });
});

describe('decideJudge (GUARDA P0)', () => {
  const valido = { valid: true, evidenceCite: 'a.ts:1', reason: 'r' };
  it('P0 -> reply_only SEMPRE, mesmo com argumento valido (decisao Pablo)', () => {
    expect(decideJudge('P0', valido)).toEqual({ action: 'reply_only' });
  });
  it('P1 valido com evidencia -> withdraw', () => {
    expect(decideJudge('P1', valido)).toEqual({ action: 'withdraw' });
  });
  it('P2 valido com evidencia -> withdraw', () => {
    expect(decideJudge('P2', valido)).toEqual({ action: 'withdraw' });
  });
  it('P1 valido SEM evidencia -> reply_only (nao procede sem prova verificavel)', () => {
    expect(decideJudge('P1', { valid: true, evidenceCite: null, reason: 'r' })).toEqual({ action: 'reply_only' });
  });
  it('P1 invalido -> reply_only (refuta)', () => {
    expect(decideJudge('P1', { valid: false, evidenceCite: null, reason: 'r' })).toEqual({ action: 'reply_only' });
  });
});

describe('shouldJudge (anti-loop + circuit-breaker)', () => {
  const cfg = { botLogin: 'movvia-ai-review[bot]', maxReplies: 3 };
  it('ignora comentario do PROPRIO bot (anti-loop por identidade)', () => {
    expect(shouldJudge({ commentAuthorLogin: 'movvia-ai-review[bot]', rootHasOurMarker: true, ourReplyCount: 0 }, cfg)).toBe(false);
  });
  it('ignora thread sem NOSSO marker no root (nao e finding nosso)', () => {
    expect(shouldJudge({ commentAuthorLogin: 'dev', rootHasOurMarker: false, ourReplyCount: 0 }, cfg)).toBe(false);
  });
  it('ignora acima do circuit-breaker (ourReplyCount >= maxReplies)', () => {
    expect(shouldJudge({ commentAuthorLogin: 'dev', rootHasOurMarker: true, ourReplyCount: 3 }, cfg)).toBe(false);
  });
  it('aceita pushback humano novo em thread nossa abaixo do cap', () => {
    expect(shouldJudge({ commentAuthorLogin: 'dev', rootHasOurMarker: true, ourReplyCount: 1 }, cfg)).toBe(true);
  });
});

// Fake nomeado das bordas do judge: registra reply/resolve/upsert sem tocar a rede.
class FakeJudgeDeps implements JudgeDeps {
  public replies: Array<{ threadId: string; body: string }> = [];
  public resolved: string[] = [];
  public withdrawalsWritten: Withdrawal[] | null = null;
  constructor(private readonly llmRaw: string, private readonly store: Withdrawal[] = []) {}
  fileProvider = async (_path: string) => 'l1\nl2\nl3';
  run: ChatRunner = async () => this.llmRaw;
  reply = async (threadId: string, body: string) => { this.replies.push({ threadId, body }); };
  resolve = async (threadId: string) => { this.resolved.push(threadId); };
  readWithdrawals = async () => this.store;
  writeWithdrawals = async (list: Withdrawal[]) => { this.withdrawalsWritten = list; };
}

const baseInput: JudgeInput = {
  threadId: 'T1',
  rootBody: '**P1** — Lock ausente\n\nr\n\n**Sugestao:** s\n\n<!-- movvia-ai-review:seguranca:abc123def456 -->',
  devArgument: 'isso ja e protegido pelo guard X',
  path: 'a.ts',
  commentAuthorLogin: 'dev',
  rootHasOurMarker: true,
  ourReplyCount: 0,
  headSha: 'sha1',
  acceptedBy: 'dev',
};
const cfg = { botLogin: 'movvia-ai-review[bot]', maxReplies: 3, model: 'm' };

describe('judgeRun (invariantes de seguranca)', () => {
  it('P1 valido -> reply + resolve + upsert no store (severity P1)', async () => {
    const deps = new FakeJudgeDeps('{"valid":true,"evidenceCite":"a.ts:2","reason":"ok"}');
    await judgeRun(baseInput, deps, cfg);
    expect(deps.replies).toHaveLength(1);
    expect(deps.resolved).toEqual(['T1']);
    expect(deps.withdrawalsWritten).toHaveLength(1);
    expect(deps.withdrawalsWritten![0]!.findingId).toBe('abc123def456');
    expect(deps.withdrawalsWritten![0]!.severity).toBe('P1');
  });

  it('P0 -> reply only, NUNCA resolve, NUNCA upsert (store intacto)', async () => {
    const p0Input = { ...baseInput, rootBody: '**P0** — Token\n\nr\n\n<!-- movvia-ai-review:seguranca:p0p0p0p0p0p0 -->' };
    const deps = new FakeJudgeDeps('{"valid":true,"evidenceCite":"a.ts:2","reason":"ok"}');
    await judgeRun(p0Input, deps, cfg);
    expect(deps.replies).toHaveLength(1);
    expect(deps.resolved).toEqual([]);
    expect(deps.withdrawalsWritten).toBeNull();
  });

  it('P1 invalido -> reply refutando, sem resolve, sem upsert', async () => {
    const deps = new FakeJudgeDeps('{"valid":false,"evidenceCite":null,"reason":"argumento fraco"}');
    await judgeRun(baseInput, deps, cfg);
    expect(deps.replies).toHaveLength(1);
    expect(deps.resolved).toEqual([]);
    expect(deps.withdrawalsWritten).toBeNull();
  });

  it('shouldJudge=false (autor e o bot) -> no-op total', async () => {
    const deps = new FakeJudgeDeps('{"valid":true,"evidenceCite":"a.ts:2"}');
    await judgeRun({ ...baseInput, commentAuthorLogin: 'movvia-ai-review[bot]' }, deps, cfg);
    expect(deps.replies).toEqual([]);
    expect(deps.resolved).toEqual([]);
    expect(deps.withdrawalsWritten).toBeNull();
  });
});
