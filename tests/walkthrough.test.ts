import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  parseWalkthroughResult,
  formatWalkthroughComment,
  buildWalkthroughPrompts,
  generateWalkthrough,
  readWalkthroughModel,
  WALKTHROUGH_MARKER,
} from '../lib/walkthrough.js';
import type { WalkthroughResult } from '../lib/types.js';

const DEFAULTS_YML = join(import.meta.dirname, '..', 'config', 'defaults.yml');

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

describe('WALKTHROUGH_MARKER', () => {
  it('é o marker estável de idempotência exportado como const', () => {
    expect(WALKTHROUGH_MARKER).toContain('movvia-ai-review:walkthrough');
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

  it('coage effort.score em STRING vinda do LLM e deriva label/minutes', () => {
    // LLMs frequentemente retornam "score": "3" (string). Trava a regressão de
    // remover o Number(...) em normalizeEffort, que faria "3" virar NaN -> score errado.
    const raw = JSON.stringify({ ...VALID_RESULT, effort: { score: '3', label: '', minutes: 0 } });
    const result = parseWalkthroughResult(raw);
    expect(result!.effort.score).toBe(3);
    // label/minutes são reconstruídos de EFFORT_LABELS, não vindos do LLM.
    expect(result!.effort.label).toBe('Medium');
    expect(result!.effort.minutes).toBe(20);
  });

  it('coage e limita effort.score string fora do intervalo', () => {
    const raw = JSON.stringify({ ...VALID_RESULT, effort: { score: '99', label: '', minutes: 0 } });
    const result = parseWalkthroughResult(raw);
    expect(result!.effort.score).toBe(5);
  });

  it('cai no fallback (score=2) quando effort.score é string não-numérica', () => {
    // Caso patológico: o LLM devolve um label textual no campo score ("alto").
    // Number('alto') -> NaN -> || 2; trava a regressão de remover o fallback de normalizeEffort.
    const raw = JSON.stringify({ ...VALID_RESULT, effort: { score: 'alto', label: '', minutes: 0 } });
    const result = parseWalkthroughResult(raw);
    expect(result!.effort.score).toBe(2);
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
    const valido = 'sequenceDiagram\n  A->>B: x';
    const raw = JSON.stringify({ ...VALID_RESULT, diagrams: [valido, 123, null] });
    const result = parseWalkthroughResult(raw);
    expect(result!.diagrams).toHaveLength(1);
    expect(result!.diagrams[0]).toBe(valido);
  });

  it('descarta diagrams que não começam com tipo Mermaid conhecido (prosa do LLM)', () => {
    const valido = 'sequenceDiagram\n  A->>B: x';
    const raw = JSON.stringify({
      ...VALID_RESULT,
      diagrams: [valido, 'Aqui o fluxo de chamadas...', 'flowchart TD\n  A-->B'],
    });
    const result = parseWalkthroughResult(raw);
    expect(result!.diagrams).toHaveLength(2);
    expect(result!.diagrams).toContain(valido);
    expect(result!.diagrams).toContain('flowchart TD\n  A-->B');
  });

  it('zera diagrams quando TODOS são prosa, e a seção some do comentário', () => {
    // Fronteira da validação Mermaid: se nada sobrevive, formatWalkthroughComment
    // deve omitir a seção em vez de renderizar um bloco mermaid vazio/quebrado no GitHub.
    const raw = JSON.stringify({
      ...VALID_RESULT,
      diagrams: ['Aqui o fluxo de chamadas...', 'Outra explicação em prosa'],
    });
    const result = parseWalkthroughResult(raw);
    expect(result!.diagrams).toHaveLength(0);
    expect(formatWalkthroughComment(result!)).not.toContain('Diagrama(s) de sequência');
  });
});

describe('formatWalkthroughComment', () => {
  it('contém a seção Walkthrough', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Walkthrough');
    expect(body).toContain(VALID_RESULT.walkthrough);
  });

  it('contém a tabela de Mudanças com cabeçalho', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Mudanças');
    expect(body).toContain('| Camada / Arquivo(s) | Resumo |');
    expect(body).toContain('Templates de notificação');
    expect(body).toContain('templates/email/vehicle-transfer.hbs');
  });

  it('formata arquivos com backtick dentro da célula da tabela', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('`templates/email/vehicle-transfer.hbs`');
  });

  it('inclui o bloco Mermaid quando há diagrams', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Diagrama(s) de sequência');
    expect(body).toContain('```mermaid');
    expect(body).toContain('sequenceDiagram');
  });

  it('omite seção de Diagrama de sequência quando diagrams está vazio', () => {
    const body = formatWalkthroughComment({ ...VALID_RESULT, diagrams: [] });
    expect(body).not.toContain('Diagrama(s) de sequência');
  });

  it('inclui a linha de esforço com emoji e tempo', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body).toContain('## Esforço estimado de review');
    expect(body).toContain('🍕');
    expect(body).toContain('Simple');
    expect(body).toContain('~10 minutos');
  });

  it('termina com o marker de idempotência', () => {
    const body = formatWalkthroughComment(VALID_RESULT);
    expect(body.trimEnd().endsWith(WALKTHROUGH_MARKER)).toBe(true);
  });

  it('omite tabela de changes quando lista está vazia', () => {
    const body = formatWalkthroughComment({ ...VALID_RESULT, changes: [] });
    expect(body).not.toContain('| Camada / Arquivo(s) |');
  });
});

describe('readWalkthroughModel', () => {
  it('lê walkthrough.model do defaults.yml', () => {
    expect(readWalkthroughModel(DEFAULTS_YML)).toBe('google/gemini-2.5-flash-lite');
  });

  it('retorna undefined (sem crash) quando o arquivo não existe', () => {
    const missing = join(import.meta.dirname, '..', 'config', 'nao-existe.yml');
    expect(readWalkthroughModel(missing)).toBeUndefined();
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

  it('trunca o diff acima do limite e anexa marcador visível', () => {
    const original = process.env.LLM_MAX_DIFF_CHARS;
    process.env.LLM_MAX_DIFF_CHARS = '100';
    try {
      const grande = 'x'.repeat(500);
      const { user } = buildWalkthroughPrompts(grande);
      expect(user).toContain('[diff truncado: 100 de 500 chars]');
      // O conteúdo após o cap não deve estar presente integralmente.
      expect(user).not.toContain('x'.repeat(200));
    } finally {
      if (original === undefined) delete process.env.LLM_MAX_DIFF_CHARS;
      else process.env.LLM_MAX_DIFF_CHARS = original;
    }
  });

  it('não trunca diff abaixo do limite (sem marcador)', () => {
    const { user } = buildWalkthroughPrompts(diff);
    expect(user).not.toContain('diff truncado');
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

  it('retorna fallback (sem rejeitar) quando o runner lança erro de rede/HTTP', async () => {
    const fakeRunner = async () => { throw new Error('chat-completion falhou: HTTP 500'); };
    const result = await generateWalkthrough('+x', 'model', fakeRunner);
    expect(result.walkthrough).toContain('Não foi possível');
    expect(result.changes).toHaveLength(0);
    expect(result.diagrams).toHaveLength(0);
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
