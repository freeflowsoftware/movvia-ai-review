import { describe, it, expect } from 'vitest';
import {
  walkthroughMarker,
  parseWalkthroughResult,
  formatWalkthroughComment,
  buildWalkthroughPrompts,
  generateWalkthrough,
  WALKTHROUGH_MARKER,
} from '../lib/walkthrough.js';
import type { WalkthroughResult } from '../lib/types.js';

const VALID_RESULT: WalkthroughResult = {
  walkthrough: 'Adiciona notificações de transferência pendente de aprovação.',
  changes: [
    {
      layer: 'Templates de notificação',
      files: ['templates/email/vehicle-transfer.hbs', 'templates/sms/vehicle-transfer.hbs'],
      summary: 'Dois novos templates Handlebars para e-mail e SMS.',
    },
    {
      layer: 'Serviço de transferência',
      files: ['src/csg/services/vehicle.transfer.service.ts'],
      summary: 'Método vehicleTransferPendingApproval adicionado.',
    },
  ],
  diagrams: ['sequenceDiagram\n  Solicitante->>VehicleTransferService: requestTransfer'],
  effort: { score: 2, label: 'Simple', minutes: 10 },
};

describe('walkthroughMarker', () => {
  it('retorna o marker estável de idempotência', () => {
    expect(walkthroughMarker()).toBe(WALKTHROUGH_MARKER);
    expect(walkthroughMarker()).toContain('movvia-ai-review:walkthrough');
  });

  it('retorna o mesmo valor em chamadas consecutivas', () => {
    expect(walkthroughMarker()).toBe(walkthroughMarker());
  });
});

describe('parseWalkthroughResult', () => {
  it('parseia JSON válido inline', () => {
    const raw = JSON.stringify(VALID_RESULT);
    const result = parseWalkthroughResult(raw);
    expect(result).not.toBeNull();
    expect(result!.walkthrough).toBe(VALID_RESULT.walkthrough);
    expect(result!.changes).toHaveLength(2);
    expect(result!.effort.score).toBe(2);
  });

  it('extrai JSON de fence ```json', () => {
    const raw = `Aqui está o resultado:\n\`\`\`json\n${JSON.stringify(VALID_RESULT)}\n\`\`\`\nFim.`;
    const result = parseWalkthroughResult(raw);
    expect(result).not.toBeNull();
    expect(result!.diagrams).toHaveLength(1);
  });

  it('extrai JSON de fence sem linguagem', () => {
    const raw = `\`\`\`\n${JSON.stringify(VALID_RESULT)}\n\`\`\``;
    const result = parseWalkthroughResult(raw);
    expect(result).not.toBeNull();
  });

  it('retorna null para string vazia', () => {
    expect(parseWalkthroughResult('')).toBeNull();
  });

  it('retorna null para JSON sem campos obrigatórios', () => {
    expect(parseWalkthroughResult(JSON.stringify({ foo: 'bar' }))).toBeNull();
  });

  it('retorna null para JSON malformado', () => {
    expect(parseWalkthroughResult('{invalido')).toBeNull();
  });

  it('normaliza effort.score para o intervalo 1-5', () => {
    const raw = JSON.stringify({ ...VALID_RESULT, effort: { score: 99, label: '', minutes: 0 } });
    const result = parseWalkthroughResult(raw);
    expect(result!.effort.score).toBeLessThanOrEqual(5);
    expect(result!.effort.score).toBeGreaterThanOrEqual(1);
  });

  it('filtra changes inválidos sem campo layer ou summary', () => {
    const raw = JSON.stringify({
      ...VALID_RESULT,
      changes: [{ files: ['x.ts'] }, { layer: 'L', files: [], summary: 'ok' }],
    });
    const result = parseWalkthroughResult(raw);
    expect(result!.changes).toHaveLength(1);
  });

  it('filtra diagrams não-string', () => {
    const raw = JSON.stringify({ ...VALID_RESULT, diagrams: ['ok', 123, null] });
    const result = parseWalkthroughResult(raw);
    expect(result!.diagrams).toHaveLength(1);
    expect(result!.diagrams[0]).toBe('ok');
  });
});

describe('formatWalkthroughComment', () => {
  it('contém a seção Walkthrough', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Walkthrough');
    expect(body).toContain(VALID_RESULT.walkthrough);
  });

  it('contém a tabela de Changes com cabeçalho', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Changes');
    expect(body).toContain('| Layer / File(s) | Summary |');
    expect(body).toContain('Templates de notificação');
    expect(body).toContain('templates/email/vehicle-transfer.hbs');
  });

  it('formata arquivos com backtick dentro da célula da tabela', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('`templates/email/vehicle-transfer.hbs`');
  });

  it('inclui o bloco Mermaid quando há diagrams', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Sequence Diagram(s)');
    expect(body).toContain('```mermaid');
    expect(body).toContain('sequenceDiagram');
  });

  it('omite seção Sequence Diagram quando diagrams está vazio', () => {
    const body = formatWalkthroughComment({ ...VALID_RESULT, diagrams: [] });
    expect(body).not.toContain('Sequence Diagram');
  });

  it('inclui a linha de esforço com emoji e tempo', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Estimated code review effort');
    expect(body).toContain('🍕');
    expect(body).toContain('Simple');
    expect(body).toContain('~10 minutes');
  });

  it('termina com o marker de idempotência', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body.trimEnd().endsWith(WALKTHROUGH_MARKER)).toBe(true);
  });

  it('omite tabela de changes quando lista está vazia', () => {
    const body = formatWalkthroughComment({ ...VALID_RESULT, changes: [] });
    expect(body).not.toContain('| Layer / File(s) |');
  });
});

describe('buildWalkthroughPrompts', () => {
  const diff = '+const x = 1;';

  it('system contém instrução de retornar JSON', () => {
    const { system } = buildWalkthroughPrompts(diff);
    expect(system).toContain('JSON');
    expect(system).toContain('walkthrough');
    expect(system).toContain('changes');
    expect(system).toContain('effort');
  });

  it('user contém o diff', () => {
    const { user } = buildWalkthroughPrompts(diff);
    expect(user).toContain(diff);
  });

  it('user inclui o título do PR quando fornecido', () => {
    const { user } = buildWalkthroughPrompts(diff, undefined, 'feat: minha feature');
    expect(user).toContain('feat: minha feature');
  });

  it('user inclui o context-pack quando fornecido', () => {
    const { user } = buildWalkthroughPrompts(diff, 'contexto do repo', 'titulo');
    expect(user).toContain('contexto do repo');
  });

  it('user não contém "Contexto do codebase" quando packPath ausente', () => {
    const { user } = buildWalkthroughPrompts(diff);
    expect(user).not.toContain('Contexto do codebase');
  });
});

describe('generateWalkthrough', () => {
  it('retorna o resultado parseado quando o runner retorna JSON válido', async () => {
    const fakeRunner = async () => JSON.stringify(VALID_RESULT);
    const result = await generateWalkthrough('+x', 'model', fakeRunner);
    expect(result.walkthrough).toBe(VALID_RESULT.walkthrough);
    expect(result.changes).toHaveLength(2);
  });

  it('retorna fallback quando o runner retorna JSON inválido', async () => {
    const fakeRunner = async () => 'resposta inválida';
    const result = await generateWalkthrough('+x', 'model', fakeRunner);
    expect(result.walkthrough).toContain('Não foi possível');
    expect(result.changes).toHaveLength(0);
    expect(result.effort.score).toBeGreaterThanOrEqual(1);
  });

  it('passa o título e o context-pack no user prompt', async () => {
    let capturedUser = '';
    const fakeRunner = async (_model: string, _system: string, user: string) => {
      capturedUser = user;
      return JSON.stringify(VALID_RESULT);
    };
    await generateWalkthrough('+x', 'model', fakeRunner, 'pack-content', 'PR title');
    expect(capturedUser).toContain('PR title');
    expect(capturedUser).toContain('pack-content');
  });
});
