export type Severity = 'P0' | 'P1' | 'P2';

/** Um problema apontado por um agente, ancorado em linhas reais do diff. */
export interface Finding {
  agent: string;
  file: string;
  startLine: number;
  endLine: number;
  severity: Severity;
  category: string;
  title: string;
  rationale: string;
  suggestion: string;
  /** Âncora "file:start-end" validada mecanicamente contra o diff. */
  cite: string;
}

/** Saída crua de um agente (uma dimensão de review). */
export interface AgentResult {
  agent: string;
  findings: Finding[];
}

/** Definição de um agente lida de agents/<name>.md. */
export interface AgentSpec {
  name: string;
  dimension: string;
  /** Vazio = usa o modelo default do CI. */
  model: string;
  /** Globs; o agente só roda se o PR tocar algum. ["**\/*"] = sempre. */
  paths: string[];
  severityHints: Record<string, string>;
  /** Corpo do .md (a persona/instruções). */
  persona: string;
  /** Caminho de origem do arquivo (para mensagens de erro). */
  file: string;
}

/** Linha do veredicto final agregado. */
export interface Verdict {
  event: 'APPROVE' | 'REQUEST_CHANGES';
  conclusion: 'success' | 'failure';
  counts: Record<Severity, number>;
}
