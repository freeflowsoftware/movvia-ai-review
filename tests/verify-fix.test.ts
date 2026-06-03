import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseInlineBody,
  parseCorrectionVerdict,
  validateCitation,
  decideVerify,
  readVerifyConfig,
  verifyZombieThreads,
  type ZombieThread,
} from '../lib/verify-fix.js';
import { buildInlineComments } from '../lib/post.js';
import type { Finding } from '../lib/types.js';
import type { ChatRunner } from '../lib/run-agent.js';

// O verificador CONFIRMA, lendo o codigo no head, se um problema foi corrigido antes de
// fechar a thread. Fail-closed: na duvida PRESERVA (oposto do refuter, que na duvida
// descarta). P0 NUNCA fecha por aqui — vira reply ao CODEOWNER (decisao Pablo 2026-06-03).

const finding: Finding = {
  agent: 'seguranca', file: 'conta.service.ts', startLine: 10, endLine: 12, severity: 'P0',
  category: 'cred', title: 'Token hardcoded', rationale: 'segredo no codigo', suggestion: 'use env', cite: 'conta.service.ts:10-12',
};

describe('parseInlineBody', () => {
  it('extrai severity/title/rationale/suggestion de um body bem-formado', () => {
    const body = buildInlineComments([finding])[0]!.body;
    const d = parseInlineBody(body);
    expect(d).not.toBeNull();
    expect(d!.severity).toBe('P0');
    expect(d!.title).toBe('Token hardcoded');
    expect(d!.rationale).toContain('segredo no codigo');
  });

  it('round-trip: recupera os campos do Finding original (ancora os dois lados)', () => {
    const d = parseInlineBody(buildInlineComments([finding])[0]!.body);
    expect(d!.severity).toBe(finding.severity);
    expect(d!.title).toBe(finding.title);
  });

  it('body sem `**Pn** —` retorna null (fail-closed: severidade ilegivel = nao-fechavel)', () => {
    expect(parseInlineBody('comentario solto de humano')).toBeNull();
    expect(parseInlineBody('')).toBeNull();
  });
});

describe('parseCorrectionVerdict (fail-closed INVERTIDO vs parseRefuteVerdict)', () => {
  it('JSON valido parseia fiel', () => {
    const v = parseCorrectionVerdict('{"fixed":true,"score":9,"correctionLine":120,"evidence":"await lock"}');
    expect(v).toEqual({ fixed: true, score: 9, correctionLine: 120, evidence: 'await lock' });
  });

  it('sem chaves -> {fixed:FALSE} (conservador = MANTEM, oposto do refuter que descarta)', () => {
    const v = parseCorrectionVerdict('texto sem json');
    expect(v.fixed).toBe(false);
    expect(v.correctionLine).toBe(-1);
  });

  it('JSON.parse lanca -> fixed:false', () => {
    expect(parseCorrectionVerdict('{quebrado').fixed).toBe(false);
  });

  it('fixed nao-booleano (string "true") -> fixed:false', () => {
    expect(parseCorrectionVerdict('{"fixed":"true","score":9}').fixed).toBe(false);
  });
});

describe('validateCitation', () => {
  const file = 'linha1\nlinha2 com codigo\n\nlinha4';
  it('linha existente e nao-vazia -> true', () => {
    expect(validateCitation(2, file)).toBe(true);
  });
  it('linha fora do range -> false', () => {
    expect(validateCitation(99, file)).toBe(false);
  });
  it('correctionLine -1 -> false', () => {
    expect(validateCitation(-1, file)).toBe(false);
  });
  it('linha vazia (so whitespace) -> false', () => {
    expect(validateCitation(3, file)).toBe(false);
  });
});

describe('decideVerify', () => {
  const file = 'a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\nl';
  const ok = { fixed: true, score: 9.5, correctionLine: 2, evidence: 'x' };
  it('P0 + corrigido + citacao valida -> reply (NUNCA resolve)', () => {
    expect(decideVerify('P0', ok, file, 0.9)).toEqual({ action: 'reply', correctionLine: 2 });
  });
  it('P1 + corrigido + score>=threshold + citacao valida -> resolve', () => {
    expect(decideVerify('P1', ok, file, 0.9)).toEqual({ action: 'resolve' });
  });
  it('P1 + score abaixo do threshold -> preserve', () => {
    expect(decideVerify('P1', { ...ok, score: 8.5 }, file, 0.9)).toEqual({ action: 'preserve' });
  });
  it('P2 + corrigido mas citacao invalida -> preserve', () => {
    expect(decideVerify('P2', { ...ok, correctionLine: 99 }, file, 0.9)).toEqual({ action: 'preserve' });
  });
  it('fixed:false -> preserve', () => {
    expect(decideVerify('P1', { ...ok, fixed: false }, file, 0.9)).toEqual({ action: 'preserve' });
  });
  it('severity null (dossie ilegivel) -> preserve', () => {
    expect(decideVerify(null, ok, file, 0.9)).toEqual({ action: 'preserve' });
  });
});

describe('readVerifyConfig', () => {
  function writeYaml(content: string): string {
    const dir = mkdtempSync(join(tmpdir(), 'verifycfg-'));
    const p = join(dir, 'defaults.yml');
    writeFileSync(p, content);
    return p;
  }
  it('le close_threshold e max_threads_per_run', () => {
    const p = writeYaml('verify:\n  close_threshold: 0.85\n  max_threads_per_run: 7\n');
    expect(readVerifyConfig(p)).toEqual({ closeThreshold: 0.85, maxThreads: 7 });
  });
  it('secao ausente -> defaults (0.9 / 10)', () => {
    const p = writeYaml('gatekeeper:\n  adversarial_threshold: 0.8\n');
    expect(readVerifyConfig(p)).toEqual({ closeThreshold: 0.9, maxThreads: 10 });
  });
});

// ChatRunner fake nomeado (espelha o padrao do gatekeeper.test): nao toca a rede; conta
// chamadas e devolve um veredito por arquivo/thread.
class VerificadorFake {
  public chamadas = 0;
  constructor(private readonly resposta: (thread: ZombieThread) => string) {}
  run: ChatRunner = async (_model, _system, _user) => {
    this.chamadas++;
    // o user prompt nao identifica a thread; o teste controla via 1 resposta fixa ou por ordem.
    return this.resposta({ threadId: '', path: '', rootBody: '' });
  };
}

describe('verifyZombieThreads', () => {
  const fileProvider = async (_path: string) => 'l1\nl2 fix aqui\nl3\nl4';
  function dossieBody(severity: string, title = 't'): string {
    return `**${severity}** — ${title}\n\nrationale\n\n**Sugestao:** s\n\n<!-- movvia-ai-review:seguranca:abc123 -->`;
  }

  it('P1 zumbi corrigido (fixed:true, citacao valida) -> toResolveExtra', async () => {
    const fake = new VerificadorFake(() => '{"fixed":true,"score":9.5,"correctionLine":2,"evidence":"l2 fix aqui"}');
    const candidates: ZombieThread[] = [{ threadId: 'T1', path: 'a.ts', rootBody: dossieBody('P1') }];
    const r = await verifyZombieThreads({ candidates, fileProvider, run: fake.run, model: 'm', closeThreshold: 0.9, maxThreads: 10 });
    expect(r.toResolveExtra).toEqual(['T1']);
    expect(r.p0ToReply).toEqual([]);
  });

  it('P0 zumbi corrigido -> p0ToReply, NUNCA toResolveExtra', async () => {
    const fake = new VerificadorFake(() => '{"fixed":true,"score":10,"correctionLine":2,"evidence":"x"}');
    const candidates: ZombieThread[] = [{ threadId: 'T0', path: 'a.ts', rootBody: dossieBody('P0') }];
    const r = await verifyZombieThreads({ candidates, fileProvider, run: fake.run, model: 'm', closeThreshold: 0.9, maxThreads: 10 });
    expect(r.toResolveExtra).toEqual([]);
    expect(r.p0ToReply).toEqual([{ threadId: 'T0', correctionLine: 2 }]);
  });

  it('rootBody ilegivel (parseInlineBody null) -> preserve, sem chamar LLM', async () => {
    const fake = new VerificadorFake(() => '{"fixed":true,"score":10,"correctionLine":2}');
    const candidates: ZombieThread[] = [{ threadId: 'T?', path: 'a.ts', rootBody: 'comentario humano' }];
    const r = await verifyZombieThreads({ candidates, fileProvider, run: fake.run, model: 'm', closeThreshold: 0.9, maxThreads: 10 });
    expect(r.toResolveExtra).toEqual([]);
    expect(r.p0ToReply).toEqual([]);
    expect(fake.chamadas).toBe(0);
  });

  it('acima do cap: nao verifica o excedente (preserva) e conta chamadas <= maxThreads', async () => {
    const fake = new VerificadorFake(() => '{"fixed":true,"score":9.5,"correctionLine":2,"evidence":"x"}');
    const candidates: ZombieThread[] = Array.from({ length: 5 }, (_v, i) => ({ threadId: `T${i}`, path: 'a.ts', rootBody: dossieBody('P1') }));
    const r = await verifyZombieThreads({ candidates, fileProvider, run: fake.run, model: 'm', closeThreshold: 0.9, maxThreads: 2 });
    expect(fake.chamadas).toBe(2);
    expect(r.toResolveExtra.length).toBe(2);
  });

  it('LLM rejeita (throw) -> preserve (fail-closed)', async () => {
    const run: ChatRunner = async () => { throw new Error('timeout'); };
    const candidates: ZombieThread[] = [{ threadId: 'T1', path: 'a.ts', rootBody: dossieBody('P1') }];
    const r = await verifyZombieThreads({ candidates, fileProvider, run, model: 'm', closeThreshold: 0.9, maxThreads: 10 });
    expect(r.toResolveExtra).toEqual([]);
  });
});
