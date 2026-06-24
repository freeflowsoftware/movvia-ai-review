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

// --- Walkthrough ---

/** Uma camada lógica de mudança agrupada por responsabilidade (não por arquivo). */
export interface WalkthroughChange {
  layer: string;
  files: string[];
  summary: string;
}

/** Estimativa de esforço de review (1 = Trivial … 5 = Very Complex). */
export interface WalkthroughEffort {
  score: number;
  label: string;
  minutes: number;
}

/** Saída do gerador de walkthrough — narrativa + tabela de camadas + diagramas + esforço. */
export interface WalkthroughResult {
  walkthrough: string;
  changes: WalkthroughChange[];
  /** Strings Mermaid puras (sem os ``` fences). Vazio quando não há fluxo relevante. */
  diagrams: string[];
  effort: WalkthroughEffort;
}
