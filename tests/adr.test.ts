// tests/adr.test.ts
import { describe, it, expect } from 'vitest';
import { needsAdr, hasAdr, ARCH_GLOBS, ADR_GLOBS } from '../lib/adr.js';

describe('needsAdr', () => {
  it('true quando toca migration', () => {
    expect(needsAdr(['pe-migrations/V010__x.sql'], ARCH_GLOBS)).toBe(true);
  });
  it('true quando toca schema.prisma', () => {
    expect(needsAdr(['pe-api-core/prisma/schema.prisma'], ARCH_GLOBS)).toBe(true);
  });
  it('false para mudanca trivial', () => {
    expect(needsAdr(['src/util/format.ts'], ARCH_GLOBS)).toBe(false);
  });
});

describe('hasAdr', () => {
  it('true quando ha arquivo ADR no diff', () => {
    expect(hasAdr(['docs/ADR-007-x.md'], '', ADR_GLOBS)).toBe(true);
  });
  it('true quando o corpo do PR referencia um ADR', () => {
    expect(hasAdr(['src/x.ts'], 'Implementa conforme ADR-012', ADR_GLOBS)).toBe(true);
  });
  it('false quando nao ha ADR nem referencia', () => {
    expect(hasAdr(['src/x.ts'], 'sem nada', ADR_GLOBS)).toBe(false);
  });
});
