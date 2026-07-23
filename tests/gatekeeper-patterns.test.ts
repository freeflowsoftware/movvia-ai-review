// tests/gatekeeper-patterns.test.ts
//
// Cobertura ampla das alternativas dos padrões BEHAVIORAL_VERB/COPULA/KEYWORD que vivem
// em lib/gatekeeper-patterns.ts. Antes desse arquivo, só 1 de 16 verbos e ~2 de 15 keywords
// eram exercitados via refuteByPresence — o comentário do próprio módulo declara que a
// extração serve para "testar a heurística isolada", mas o teste dedicado não existia.
// Um refactor futuro dessas regexes podia quebrar silenciosamente uma alternativa e
// reintroduzir a classe de bug SEO-153 (supressão indevida de finding comportamental P0)
// sem que nenhum teste acusasse. Este arquivo trava recall exemplar-por-exemplar.

import { describe, it, expect } from 'vitest';
import { presenceHit } from '../lib/gatekeeper-patterns.js';
import type { Finding } from '../lib/types.js';

/** Symbol/test/env sets padrão: contém "Alvo" para testar que a presença NÃO suprime comportamental. */
const symbols = new Set(['Alvo', 'LockService', 'Component', 'Handler']);
const tests = new Set<string>();
const envs = new Set<string>();

function findingWith(rationale: string, title = 'Titulo'): Finding {
  return {
    file: 'src/algum.ts',
    startLine: 10, endLine: 10,
    severity: 'P1', category: 'behavioral',
    title, rationale, suggestion: '', cite: 'src/algum.ts:10',
    agent: 'test',
  };
}

// PT-BR "não <verbo>" direto — cada alternativa de BEHAVIORAL_VERB_ABSENCE. Se qualquer
// uma dessas voltar a ser suprimida, é regressão do SEO-153 na sua dimensão comportamental.
describe('BEHAVIORAL_VERB_ABSENCE (PT-BR) — presenceHit devolve null (não suprime)', () => {
  const cases = [
    'O servico nao usa Alvo no fluxo',
    'O metodo nao utiliza Alvo corretamente',
    'A rota nao chama Alvo antes de responder',
    'O handler nao invoca Alvo no path critico',
    'A query nao filtra por Alvo (multi-tenant)',
    'O input nao valida Alvo antes de gravar',
    'O consumer nao trata Alvo em caso de erro',
    'O guard nao verifica Alvo antes de liberar',
    'O reducer nao aplica Alvo na mutation',
    'O lock nao adquire Alvo antes da operacao',
    'O lock nao libera Alvo no finally',
    'A rota nao protege Alvo com auth',
    'O calculo nao considera Alvo na soma',
    'A pagina nao renderiza Alvo no fluxo',
    'O layout nao monta Alvo em produção',
    'O bundle nao inclui Alvo no build',
    'O module nao importa Alvo apesar de declarado',
    'O template nao referencia Alvo em nenhum lugar',
  ];
  it.each(cases)('preserva: %s', (rationale) => {
    expect(presenceHit(findingWith(rationale), symbols, tests, envs)).toBeNull();
  });
});

// PT-BR "não é/está/foi <particípio>" e EN copular. Todas variantes de forma copular.
describe('BEHAVIORAL_COPULA_ABSENCE (PT-BR/EN) — preserva mesmo com símbolo no índice', () => {
  const cases = [
    'Alvo nao e renderizado no fluxo (sem acento)',
    'Alvo não é renderizado no fluxo (com acento)',
    'Alvo nao esta montado no layout',
    'Alvo não está incluído no bundle',
    'Alvo nao foi importado no barrel',
    'Alvo nao sera referenciado por ninguem',
    'Alvo nao será chamado nesse ciclo',
    'Alvo nao foi invocado no handler',
    'Alvo nao esta utilizado em nenhum caller',
    'Alvo nao foi usado no fluxo apesar de exportado',
  ];
  it.each(cases)('preserva: %s', (rationale) => {
    expect(presenceHit(findingWith(rationale), symbols, tests, envs)).toBeNull();
  });
});

// Palavras-chave inequívocas: "sem X", "race", "idempot", "multi-tenant", "clienteid",
// "correlation", "does not X", "is not X", "without X". Todas devem preservar.
describe('BEHAVIORAL_KEYWORD_ABSENCE — preserva mesmo com símbolo no índice', () => {
  const cases = [
    'Operacao de saldo sem lock distribuido',
    'Query sem filtro por clienteId',
    'Endpoint sem validacao de payload',
    'Consumer sem controle de reprocessamento',
    'Servico sem isolamento entre tenants',
    'Handler sem idempotencia',
    'Recurso sem trava de concorrencia',
    'Ha race condition entre requests concorrentes',
    'Operacao nao e idempotente',
    'Vazamento multi-tenant no findMany',
    'Ausencia de correlation id nos logs',
    'Falta filtro por clienteId no where',
    'Endpoint does not use LockService',
    'Method does not call Alvo',
    'Query does not filter by clienteId',
    'Input does not validate before write',
    'Handler does not acquire lock',
    'Guard does not check auth',
    'Reducer does not consider Alvo',
    'Page does not render Alvo',
    'Layout does not mount Alvo',
    'Bundle does not include Alvo',
    'Module does not import Alvo',
    'Template does not reference Alvo',
    'Alvo is not rendered in the flow',
    'Alvo is not mounted anywhere',
    'Alvo is not included in the bundle',
    'Alvo is not imported',
    'Alvo is not referenced',
    'Alvo is not called by anyone',
    'Alvo is not invoked in path',
    'Alvo is not used',
    'Operation without a lock',
    'Query without a filter',
    'Endpoint without validation',
  ];
  it.each(cases)('preserva: %s', (rationale) => {
    expect(presenceHit(findingWith(rationale), symbols, tests, envs)).toBeNull();
  });
});

// EXISTENCE_ABSENCE — o ramo que SUPRIME finding. Regressão aqui é PERIGOSA (some
// finding real). Cobertura exemplar-por-exemplar de cada alternativa da regex, mesmo
// padrão do BEHAVIORAL_* para travar recall se a regex for refatorada.
describe('EXISTENCE_ABSENCE — suprime quando símbolo existe no índice', () => {
  // Note: candidateSymbols só extrai "Alvo" quando está entre crases/aspas OU casa
  // PascalCase composto ("AlvoService"). Como "Alvo" simples não bate PascalCase composto,
  // usamos sempre `Alvo` (com crases) nos rationales pra garantir que a hit é sobre o guard.
  const cases = [
    'O componente `Alvo` nao foi implementado no repo',
    'O componente `Alvo` esta ausente do repositorio',
    'O componente `Alvo` e inexistente',
    'O componente `Alvo` nao existe no schema',
    'O modelo `Alvo` nao foi criado',
    'O middleware `Alvo` nao foi adicionado',
    'O tipo `Alvo` nao foi declarado',
    'A funcao `Alvo` nao foi definida',
    'O helper `Alvo` nao foi encontrado',
    'Component `Alvo` does not exist in the project',
    "Component `Alvo` doesn't exist",
    'Class `Alvo` is not defined',
    'Model `Alvo` is not declared',
    'Handler `Alvo` is not implemented',
    'Helper `Alvo` not defined at expected path',
    'Helper `Alvo` not declared in module',
    'Helper `Alvo` not implemented',
    'Helper `Alvo` not found',
  ];
  it.each(cases)('suprime: %s (Alvo esta no indice)', (rationale) => {
    const reason = presenceHit(findingWith(rationale), symbols, tests, envs);
    expect(reason).toContain('Alvo');
  });
  it('NAO suprime quando símbolo NAO esta no indice (recall preservado)', () => {
    const reason = presenceHit(
      findingWith('O componente `FantasmaNaoExiste` nao foi implementado'),
      symbols, tests, envs,
    );
    expect(reason).toBeNull();
  });
});
