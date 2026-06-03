import { minimatch } from 'minimatch';
import type { AgentSpec } from './types.js';
import type { JiraTicket } from './jira.js';

const EXT_TO_LANG: Record<string, string> = {
  ts: 'javascript-typescript', tsx: 'javascript-typescript',
  js: 'javascript-typescript', jsx: 'javascript-typescript',
  java: 'java',
  py: 'python',
};

export function detectLanguages(files: string[]): string[] {
  const set = new Set<string>();
  for (const f of files) {
    const ext = f.split('.').pop()?.toLowerCase() ?? '';
    const lang = EXT_TO_LANG[ext];
    if (lang) set.add(lang);
  }
  return [...set].sort();
}

/** Contexto do PR que vai no USER prompt (sem a persona, que e SYSTEM). */
export interface UserPromptParts {
  /**
   * Regras COMPARTILHADAS da Movvia (org-rules), roteadas por stack e injetadas do repo
   * CENTRAL — viajam com a Action, ao contrario das .claude/rules que vivem no super-repo
   * nao-versionado. Opcional: callers legados/testes sem org-rules caem so no repoRules.
   */
  orgRules?: string[];
  repoRules: string;
  langPacks: string[];
  adrs: string;
  diff: string;
  /** US do Jira; quando presente, o agente de requisitos confronta os criterios de aceite. */
  ticket?: JiraTicket;
  /**
   * Context-pack determinístico (arquivos reais, vizinhos, padrões) dos arquivos alterados.
   * Quando presente, injeta a secao "## CONTEXTO DO CODEBASE" para o agente confirmar se o
   * que parece ausente ja segue o padrao do repo ANTES de reportar (anti-falso-positivo).
   */
  contextPack?: string;
}

/** Mantido para nao quebrar callers/testes legados: persona (system) + contexto (user). */
export interface PromptParts extends UserPromptParts {
  spec: AgentSpec;
}

/**
 * Seccao "## US do Jira" do prompt. So existe quando ha ticket: sem ela o agente de
 * requisitos opera sem a US e o gating de dominio (diferencial do produto) cai. Vazia
 * (sem ticket) para nao adicionar linhas em branco/ruido no prompt dos demais agentes.
 */
function jiraSection(ticket: JiraTicket | undefined): string[] {
  if (!ticket) return [];
  return ['## US do Jira', `${ticket.summary}\n\n${ticket.description}`.trim(), ''];
}

/**
 * Seccao "## CONTEXTO DO CODEBASE" do prompt — arquivos reais, vizinhos e padrões dos
 * arquivos alterados (context-pack determinístico). So existe quando ha pack: vazia para
 * nao adicionar linhas em branco/ruido nos PRs/jobs sem context-pack. Vai ENTRE os ADRs
 * (regra documentada) e o DIFF, deliberadamente abaixo das regras: "regra documentada
 * vence padrao observado" (blueprint Fase 1), entao o agente le a regra antes do padrao.
 */
function contextoSection(contextPack: string | undefined): string[] {
  if (!contextPack) return [];
  return ['## CONTEXTO DO CODEBASE (arquivos reais, vizinhos, padroes)', contextPack, ''];
}

/**
 * Bloco de EXCLUSIVIDADE da dimensao. Vai no topo do system prompt para travar o agente
 * na sua dimensao: cada revisor reportava problemas de outras dimensoes (credencial
 * hardcoded aparecia no agente de performance, `any` aparecia no de requisitos), gerando
 * findings off-dimension que poluem o veredicto. A regra e dura de proposito — "melhor
 * zero findings que findings fora da sua dimensao" — porque o gatekeeper depois dedupa e
 * a sobreposicao entre agentes so adiciona ruido, nunca recall.
 */
function exclusivityBlock(dimension: string): string[] {
  return [
    '## EXCLUSIVIDADE DA SUA DIMENSAO (REGRA DURA)',
    `Voce e EXCLUSIVAMENTE o revisor da dimensao ${dimension}. Reporte SOMENTE problemas desta dimensao.`,
    'Se um problema pertence a outra dimensao (ex: credencial hardcoded e SEGURANCA, nao performance;',
    'tipo any e ARQUITETURA/qualidade, nao requisitos), NAO reporte.',
    `Se nao houver problema da SUA dimensao (${dimension}) no diff, retorne findings vazio [].`,
    'E melhor zero findings que findings fora da sua dimensao.',
  ];
}

/**
 * SYSTEM prompt: o bloco de exclusividade da dimensao + a persona + calibracao de
 * severidade + as INSTRUCOES OBRIGATORIAS (schema JSON camelCase, citar linha, PT-BR).
 * Vai como role:'system' na chat-completion para o modelo fixar a persona da dimensao e
 * nao diluir o foco — antes isso ia junto do contexto num prompt unico e o agente perdia
 * identidade, alem de reportar problemas de outras dimensoes.
 */
export function buildSystemPrompt(spec: AgentSpec): string {
  const hints = Object.entries(spec.severityHints)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return [
    ...exclusivityBlock(spec.dimension),
    '',
    spec.persona,
    '',
    '## Calibracao de severidade',
    hints || '(sem hints)',
    '',
    // Calibracao GERAL de precisao: o modelo barato (Flash-Lite) inflava severidade e
    // reportava o que JA estava coberto (ex: "teste ausente" num PR que inclui o .spec.ts;
    // "validacao ausente" num campo com decorators). O check de merge so bloqueia em P0/P1,
    // entao findings incertos DEVEM cair para P2 (nao-bloqueante) ou sumir — senao um
    // falso-positivo trava o loop do dev para sempre. Prefira PRECISAO a recall.
    '## PRECISAO E SEVERIDADE (anti-falso-positivo, OBRIGATORIO)',
    '- Reporte APENAS problemas REAIS e acionaveis. Antes de reportar, confirme no DIFF e no CONTEXTO DO CODEBASE que o problema existe DE FATO.',
    '- Se o codigo alterado JA resolve/cobre o ponto, NAO reporte: ex. o PR inclui o arquivo de teste (*.spec.ts/*Test.java) que cobre o codigo; o campo ja tem os decorators de validacao; o lock/idempotencia ja esta presente.',
    '- Severidade: P0 = bug certo / vulnerabilidade / quebra. P1 = problema real, acionavel, de impacto claro E do qual voce tem CERTEZA. P2 = melhoria, estilo, nitpick, ou qualquer coisa incerta/discutivel.',
    '- NA DUVIDA, use P2 ou NAO reporte. So use P0/P1 quando um engenheiro senior concordaria que aquilo BLOQUEIA o merge. Um P0/P1 falso-positivo custa mais que um P2 perdido.',
    '',
    '## INSTRUCOES OBRIGATORIAS',
    '- Avalie SOMENTE linhas adicionadas (+) do diff.',
    '- Para CADA problema, cite OBRIGATORIAMENTE [arquivo:linha_inicio-linha_fim] de uma linha adicionada.',
    '- NAO invente APIs, metodos ou arquivos. NAO flague o que o framework ja garante.',
    // Anti-falso-positivo da Fase 1b: o pack ensina o padrao do repo; a regra documentada
    // ainda vence o padrao observado (senao o pack normalizaria anti-padroes, ex: "vizinhos
    // tem any => para de reportar any"). Texto fixado por teste (deve casar literalmente).
    '- Use o CONTEXTO DO CODEBASE para confirmar se o que parece ausente ja segue o padrao do repo ANTES de reportar. Regra documentada vence padrao observado: se uma regra exige X, reporte mesmo que os vizinhos nao facam X.',
    '- Responda em PT-BR.',
    '- Saida: UNICO objeto JSON, sem texto fora do JSON, EXATAMENTE neste schema (nomes de campo em camelCase):',
    '  {"agent":"<nome>","findings":[{"file":"caminho","startLine":N,"endLine":N,"severity":"P0|P1|P2","category":"slug","title":"...","rationale":"...","suggestion":"...","cite":"caminho:N-N"}]}',
  ].join('\n');
}

/**
 * Roteamento por paths: true se ALGUM arquivo alterado casa ALGUM glob do agente.
 * Usado pelo CLI para nao chamar o LLM em agentes cujos paths nao tocam o diff (economia
 * de tokens + evita findings off-dimension de quem nao deveria nem rodar). O glob ['**\/*']
 * casa tudo via minimatch, entao agentes "globais" continuam rodando sempre.
 */
export function agentMatchesPaths(changedFiles: string[], paths: string[]): boolean {
  return changedFiles.some((file) => paths.some((glob) => minimatch(file, glob)));
}

/**
 * USER prompt: o contexto especifico deste PR — regras do repo, lang-packs, ADRs,
 * US do Jira e o diff. Vai como role:'user' na chat-completion.
 */
export function buildUserPrompt(p: UserPromptParts): string {
  return [
    ...jiraSection(p.ticket),
    // Org-rules ANTES das do repo: a base compartilhada da Movvia (lock financeiro, sem
    // enum nativo, skeleton...) primeiro; as do repo alvo refinam/complementam depois.
    '## Regras compartilhadas da Movvia (org-rules, roteadas por stack)',
    (p.orgRules ?? []).join('\n\n') || '(nenhuma aplicavel a este diff)',
    '',
    '## Regras do repositorio alvo (.claude/rules, CLAUDE.md, AGENTS.md)',
    p.repoRules || '(nenhuma regra encontrada — use best practices da stack)',
    '',
    '## Convencoes por linguagem (aplique a regra da linguagem de CADA arquivo)',
    p.langPacks.join('\n\n') || '(nenhuma)',
    '',
    '## ADRs relevantes (decisoes arquiteturais ja tomadas)',
    p.adrs || '(nenhum)',
    '',
    // Context-pack ENTRE ADRs e DIFF: regra documentada acima do padrao observado.
    ...contextoSection(p.contextPack),
    '## DIFF DO PR',
    p.diff,
  ].join('\n');
}

/** Wrapper legado: system + '\n' + user num unico prompt (mantem testes/callers antigos). */
export function buildPrompt(p: PromptParts): string {
  return `${buildSystemPrompt(p.spec)}\n${buildUserPrompt(p)}`;
}
