// tests/jira.test.ts
import { describe, it, expect } from 'vitest';
import {
  extractJiraKey,
  validateJiraKey,
  fetchJiraTicket,
  type JiraClient,
  type JiraTicket,
} from '../lib/jira.js';

class FakeJiraClient implements JiraClient {
  constructor(
    private readonly existentes: Set<string>,
    private readonly contextos: Record<string, JiraTicket> = {},
  ) {}
  async issueExists(key: string): Promise<boolean> { return this.existentes.has(key); }
  async getIssueContext(key: string): Promise<JiraTicket | null> {
    return this.contextos[key] ?? null;
  }
}

describe('extractJiraKey', () => {
  it('acha PED-1234 no titulo', () => {
    expect(extractJiraKey('feat: pagamento PED-1234 saldo')).toBe('PED-1234');
  });
  it('aceita projetos PEG/AR/AN', () => {
    expect(extractJiraKey('fix AN-7 bug')).toBe('AN-7');
  });
  it('retorna null quando ausente', () => {
    expect(extractJiraKey('feat: sem ticket')).toBeNull();
  });
});

describe('validateJiraKey', () => {
  it('true quando a issue existe', async () => {
    const c = new FakeJiraClient(new Set(['PED-1234']));
    expect(await validateJiraKey('PED-1234', c)).toBe(true);
  });
  it('false quando a issue nao existe (typo)', async () => {
    const c = new FakeJiraClient(new Set(['PED-1234']));
    expect(await validateJiraKey('PED-9999', c)).toBe(false);
  });
});

describe('fetchJiraTicket', () => {
  it('devolve summary/description da US quando a issue existe', async () => {
    const c = new FakeJiraClient(new Set(['PED-1234']), {
      'PED-1234': { summary: 'Debitar saldo no pedagio', description: 'AC1: travar conta' },
    });
    const ticket = await fetchJiraTicket('PED-1234', c);
    expect(ticket?.summary).toBe('Debitar saldo no pedagio');
    expect(ticket?.description).toContain('AC1: travar conta');
  });
  it('devolve null quando a issue nao tem contexto', async () => {
    const c = new FakeJiraClient(new Set(['PED-1234']));
    expect(await fetchJiraTicket('PED-9999', c)).toBeNull();
  });
});
