import { describe, it, expect } from 'vitest';
import {
  withdrawalsMarker,
  parseWithdrawals,
  buildWithdrawalsComment,
  upsertWithdrawal,
  computeValidWithdrawals,
  type Withdrawal,
} from '../lib/withdrawals.js';

// O store de withdrawals registra os findings que o dev CONTESTOU com argumento valido
// (judge-pushback). O pipeline consulta o store para NAO re-postar esses findings — sem
// ele, como o codigo nao muda, o re-review re-detectaria e re-postaria (loop). Invalidacao:
// se o arquivo mudar desde o acceptedSha, o argumento expira e o finding volta a valer.

const entry = (over: Partial<Withdrawal> = {}): Withdrawal => ({
  findingId: 'abc123def456', severity: 'P1', acceptedSha: 'sha1', acceptedAt: '2026-06-03T00:00:00Z',
  acceptedBy: 'dev', category: 'lock', file: 'a.ts', ...over,
});

describe('withdrawalsMarker', () => {
  it('e o marker top-level dedicado', () => {
    expect(withdrawalsMarker).toBe('<!-- movvia-ai-review:withdrawals -->');
  });
});

describe('parseWithdrawals / buildWithdrawalsComment', () => {
  it('round-trip: build -> parse devolve as entries', () => {
    const list = [entry(), entry({ findingId: 'ffff00001111', severity: 'P2', file: 'b.ts' })];
    const parsed = parseWithdrawals(buildWithdrawalsComment(list));
    expect(parsed).toEqual(list);
  });

  it('build embute o marker + bloco json', () => {
    const body = buildWithdrawalsComment([entry()]);
    expect(body).toContain(withdrawalsMarker);
    expect(body).toContain('```json');
  });

  it('FAIL-SAFE: json quebrado -> [] (na duvida NAO suprime, nunca derruba o job)', () => {
    expect(parseWithdrawals(`${withdrawalsMarker}\n\`\`\`json\n{quebrado\n\`\`\``)).toEqual([]);
  });

  it('FAIL-SAFE: body sem marker/sem bloco -> []', () => {
    expect(parseWithdrawals('comentario qualquer')).toEqual([]);
    expect(parseWithdrawals('')).toEqual([]);
  });
});

describe('upsertWithdrawal', () => {
  it('adiciona uma entry nova (P1/P2)', () => {
    const out = upsertWithdrawal([], entry());
    expect(out).toHaveLength(1);
    expect(out[0]!.findingId).toBe('abc123def456');
  });

  it('por findingId: atualiza acceptedSha em vez de empilhar', () => {
    const out = upsertWithdrawal([entry({ acceptedSha: 'velho' })], entry({ acceptedSha: 'novo' }));
    expect(out).toHaveLength(1);
    expect(out[0]!.acceptedSha).toBe('novo');
  });

  it('REJEITA severity P0 (store nunca contem P0 — guarda inviolavel)', () => {
    const out = upsertWithdrawal([], entry({ severity: 'P0' }));
    expect(out).toEqual([]);
  });
});

describe('computeValidWithdrawals (invalidacao por arquivo)', () => {
  // deltaProvider(file, acceptedSha) = true se o arquivo MUDOU desde o acceptedSha -> expira.
  it('withdrawal valido (arquivo NAO mudou) -> entra em validIds e sobrevive', () => {
    const naoMudou = () => false;
    const r = computeValidWithdrawals([entry()], naoMudou);
    expect(r.validIds.has('abc123def456')).toBe(true);
    expect(r.survivors).toHaveLength(1);
  });

  it('withdrawal expira (arquivo mudou) -> fora de validIds e some dos survivors', () => {
    const mudou = () => true;
    const r = computeValidWithdrawals([entry()], mudou);
    expect(r.validIds.has('abc123def456')).toBe(false);
    expect(r.survivors).toEqual([]);
  });

  it('usa o acceptedSha de CADA entry (nao um previousSha global)', () => {
    const vistos: Array<{ file: string; sha: string }> = [];
    const provider = (file: string, sha: string) => { vistos.push({ file, sha }); return file === 'b.ts'; };
    const r = computeValidWithdrawals(
      [entry({ file: 'a.ts', acceptedSha: 'shaA', findingId: 'aaaaaaaaaaaa' }), entry({ file: 'b.ts', acceptedSha: 'shaB', findingId: 'bbbbbbbbbbbb' })],
      provider,
    );
    expect(vistos).toEqual([{ file: 'a.ts', sha: 'shaA' }, { file: 'b.ts', sha: 'shaB' }]);
    expect(r.validIds.has('aaaaaaaaaaaa')).toBe(true);  // a.ts nao mudou -> valido
    expect(r.validIds.has('bbbbbbbbbbbb')).toBe(false); // b.ts mudou -> expirou
  });
});
