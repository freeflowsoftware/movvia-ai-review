import { describe, it, expect } from 'vitest';
import { parseCodeowners, ownersFor, isDirectOwner, teamOwners } from '../lib/codeowners.js';

// CODEOWNERS resolve quem pode dispensar P0 por comando (PED-2728, ADR-002). Nucleo PURO:
// parse + match (ultima regra vence). Membership de time e leitura do arquivo ficam na borda
// (dismiss.ts), fail-closed. Aqui garantimos a semantica de precedencia e o match direto.

describe('parseCodeowners', () => {
  it('ignora comentarios e linhas vazias, extrai pattern + donos', () => {
    const rules = parseCodeowners('# comentario\n\n*  @a\n/src/  @b @org/time  # inline\n');
    expect(rules).toEqual([
      { pattern: '*', owners: ['@a'] },
      { pattern: '/src/', owners: ['@b', '@org/time'] },
    ]);
  });

  it('descarta linha sem donos', () => {
    expect(parseCodeowners('/src/x.ts')).toEqual([]);
  });
});

describe('ownersFor (ultima regra que casa vence)', () => {
  const rules = parseCodeowners('*  @a\n/src/**  @b\n**/schema.prisma  @c');

  it('arquivo generico -> curinga *', () => {
    expect(ownersFor(rules, 'README.md')).toEqual(['@a']);
  });

  it('arquivo sob /src -> regra mais especifica (ultima que casa)', () => {
    expect(ownersFor(rules, 'src/lib/x.ts')).toEqual(['@b']);
  });

  it('schema.prisma em qualquer nivel -> regra dedicada', () => {
    expect(ownersFor(rules, 'apps/api/schema.prisma')).toEqual(['@c']);
  });

  it('sem regra casando -> [] (fail-closed no chamador)', () => {
    expect(ownersFor(parseCodeowners('/only/here  @x'), 'outro/arquivo.ts')).toEqual([]);
  });
});

describe('isDirectOwner / teamOwners', () => {
  it('match direto de login, case-insensitive e tolerante a @', () => {
    expect(isDirectOwner(['@Pablo'], 'pablo')).toBe(true);
    expect(isDirectOwner(['@pablo'], '@Pablo')).toBe(true);
    expect(isDirectOwner(['@pablo'], 'outro')).toBe(false);
  });

  it('teamOwners isola apenas os donos que sao times (@org/team)', () => {
    expect(teamOwners(['@pablo', '@org/seg', '@org/plat'])).toEqual(['@org/seg', '@org/plat']);
  });
});
