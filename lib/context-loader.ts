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
  repoRules: string;
  langPacks: string[];
  adrs: string;
  diff: string;
  /** US do Jira; quando presente, o agente de requisitos confronta os criterios de aceite. */
  ticket?: JiraTicket;
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
 * SYSTEM prompt: a persona da dimensao + calibracao de severidade + as INSTRUCOES
 * OBRIGATORIAS (schema JSON camelCase, citar linha, PT-BR). Vai como role:'system' na
 * chat-completion para o modelo fixar a persona da dimensao e nao diluir o foco — antes
 * isso ia junto do contexto num prompt unico e o agente perdia identidade.
 */
export function buildSystemPrompt(spec: AgentSpec): string {
  const hints = Object.entries(spec.severityHints)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n');
  return [
    spec.persona,
    '',
    '## Calibracao de severidade',
    hints || '(sem hints)',
    '',
    '## INSTRUCOES OBRIGATORIAS',
    '- Avalie SOMENTE linhas adicionadas (+) do diff.',
    '- Para CADA problema, cite OBRIGATORIAMENTE [arquivo:linha_inicio-linha_fim] de uma linha adicionada.',
    '- NAO invente APIs, metodos ou arquivos. NAO flague o que o framework ja garante.',
    '- Responda em PT-BR.',
    '- Saida: UNICO objeto JSON, sem texto fora do JSON, EXATAMENTE neste schema (nomes de campo em camelCase):',
    '  {"agent":"<nome>","findings":[{"file":"caminho","startLine":N,"endLine":N,"severity":"P0|P1|P2","category":"slug","title":"...","rationale":"...","suggestion":"...","cite":"caminho:N-N"}]}',
  ].join('\n');
}

/**
 * USER prompt: o contexto especifico deste PR — regras do repo, lang-packs, ADRs,
 * US do Jira e o diff. Vai como role:'user' na chat-completion.
 */
export function buildUserPrompt(p: UserPromptParts): string {
  return [
    ...jiraSection(p.ticket),
    '## Regras do repositorio alvo (.claude/rules, CLAUDE.md, AGENTS.md)',
    p.repoRules || '(nenhuma regra encontrada — use best practices da stack)',
    '',
    '## Convencoes por linguagem (aplique a regra da linguagem de CADA arquivo)',
    p.langPacks.join('\n\n') || '(nenhuma)',
    '',
    '## ADRs relevantes (decisoes arquiteturais ja tomadas)',
    p.adrs || '(nenhum)',
    '',
    '## DIFF DO PR',
    p.diff,
  ].join('\n');
}

/** Wrapper legado: system + '\n' + user num unico prompt (mantem testes/callers antigos). */
export function buildPrompt(p: PromptParts): string {
  return `${buildSystemPrompt(p.spec)}\n${buildUserPrompt(p)}`;
}
