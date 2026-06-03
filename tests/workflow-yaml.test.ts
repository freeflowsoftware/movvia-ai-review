import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import YAML from 'yaml';

// Os arquivos de workflow sao o artefato sob teste: o GitHub Actions usa um parser
// proprio tolerante, mas yamllint/pre-commit/actionlint-via-yaml usam YAML 1.2 estrito.
// Expressoes ${{ }} dentro de flow-mappings ({ k: ${{ x }} }) sao rejeitadas como
// flow-map-start inesperado. Este teste garante que os YAMLs commitados sejam validos
// sob YAML 1.2 (block style nas linhas com expressao).
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const yamlFiles = [
  '.github/workflows/ai-review.yml',
  '.github/workflows/self-test.yml',
  '.github/caller-template.yml',
  'config/defaults.yml',
];

describe('YAMLs do projeto parseiam sob YAML 1.2 estrito', () => {
  for (const relPath of yamlFiles) {
    it(`${relPath} e valido em YAML 1.2`, () => {
      const src = readFileSync(resolve(repoRoot, relPath), 'utf8');
      expect(() => YAML.parse(src)).not.toThrow();
    });
  }
});

// FIX P0: o realChatRunner (lib/run-agent.ts) le a credencial do LLM direto do ambiente
// (process.env.LLM_API_KEY/LLM_BASE_URL) ao fazer a chat-completion via fetch nativo —
// NAO ha mais opencode resolvendo opencode.json. Por isso os steps que disparam o LLM
// (agente em review e a etapa adversarial em gatekeeper) DEVEM exportar LLM_API_KEY ao
// ambiente do processo. Estes asserts travam o bug.
interface WorkflowStep {
  name?: string;
  run?: string;
  env?: Record<string, unknown>;
}
interface WorkflowJob {
  steps?: WorkflowStep[];
}
interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

function findStep(wf: Workflow, jobId: string, namePart: string): WorkflowStep {
  const steps = wf.jobs?.[jobId]?.steps ?? [];
  const step = steps.find((s) => (s.name ?? '').includes(namePart));
  if (!step) throw new Error(`step "${namePart}" nao encontrado no job "${jobId}"`);
  return step;
}

describe('credencial do LLM chega ao realChatRunner em runtime', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  it('o step de review exporta LLM_API_KEY ao ambiente do agente', () => {
    const step = findStep(wf, 'review', 'Rodar agente');
    expect(step.env).toBeDefined();
    expect(Object.keys(step.env!)).toContain('LLM_API_KEY');
    expect(String(step.env!.LLM_API_KEY)).toContain('secrets.LLM_API_KEY');
    // LLM_BASE_URL tambem precisa estar no env (com default quando o secret falta).
    expect(Object.keys(step.env!)).toContain('LLM_BASE_URL');
  });

  it('o step adversarial do gatekeeper exporta LLM_API_KEY ao ambiente do realChatRunner', () => {
    const step = findStep(wf, 'gatekeeper', 'Consolidar');
    expect(step.env).toBeDefined();
    expect(Object.keys(step.env!)).toContain('LLM_API_KEY');
    expect(String(step.env!.LLM_API_KEY)).toContain('secrets.LLM_API_KEY');
    expect(Object.keys(step.env!)).toContain('LLM_BASE_URL');
  });

  it('o step Consolidar do gatekeeper expoe DEDUP_MODEL para a consolidacao final', () => {
    // consolidateFindings (lib/gatekeeper.ts) le DEDUP_MODEL do ambiente para usar um
    // modelo melhor (DeepSeek) na fusao semantica final. O workflow precisa exporta-lo.
    const step = findStep(wf, 'gatekeeper', 'Consolidar');
    expect(Object.keys(step.env ?? {})).toContain('DEDUP_MODEL');
    expect(String(step.env!.DEDUP_MODEL)).toBe('deepseek/deepseek-v4-flash');
  });

  it('o job review NAO instala o opencode (o agente usa realChatRunner via fetch)', () => {
    // O agente faz chat-completion direta via fetch nativo (realChatRunner); o binario
    // opencode nao e mais usado, entao o install ficaria morto. Travamos a ausencia para
    // impedir que ele volte por copia/cola de outro job.
    const steps = wf.jobs?.review?.steps ?? [];
    const installs = steps.some((s) => (s.run ?? '').includes('opencode-ai'));
    expect(installs).toBe(false);
  });

  it('o job gatekeeper NAO instala o opencode (a etapa adversarial usa realChatRunner via fetch)', () => {
    // Apos a migracao para realChatRunner (chat-completion via fetch nativo), a etapa
    // adversarial nao invoca mais o binario opencode — o install ficaria morto. Travamos
    // a ausencia para impedir que ele volte por copia/cola de outro job.
    const steps = wf.jobs?.gatekeeper?.steps ?? [];
    const installs = steps.some((s) => (s.run ?? '').includes('opencode-ai'));
    expect(installs).toBe(false);
  });
});

// FIX F6: o agente de requisitos precisa da US do Jira. O step de review deve receber
// os secrets Jira e exportar PR_TITLE para extrair a chave (lib/jira.ts/agent-runner-cli).
describe('contexto da US do Jira chega ao agente de requisitos', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  it('o step de review exporta os secrets Jira ao agente', () => {
    const step = findStep(wf, 'review', 'Rodar agente');
    const keys = Object.keys(step.env ?? {});
    expect(keys).toContain('JIRA_BASE_URL');
    expect(keys).toContain('JIRA_EMAIL');
    expect(keys).toContain('JIRA_API_TOKEN');
  });

  it('o step de review define PR_TITLE para extrair a chave Jira', () => {
    const step = findStep(wf, 'review', 'Rodar agente');
    expect(step.run ?? '').toContain('PR_TITLE');
  });
});

// FIX P0-seguranca: o caller usa `secrets: inherit`, entao o branch issue_comment do
// `if:` PRECISA exigir que o comentario seja em um PR e que o autor seja membro do repo,
// senao qualquer pessoa que abra um PR de fork dispara o pipeline com todos os org secrets.
// Estes asserts travam o guard de fork (author_association + github.event.issue.pull_request).
describe('caller-template tem guard de fork no gatilho issue_comment', () => {
  const callerSrc = readFileSync(
    resolve(repoRoot, '.github/caller-template.yml'),
    'utf8',
  );
  const caller = YAML.parse(callerSrc) as {
    jobs?: Record<string, { if?: string }>;
  };

  it('o YAML do caller continua valido em YAML 1.2', () => {
    expect(() => YAML.parse(callerSrc)).not.toThrow();
  });

  it('o `if:` do job exige autor membro (author_association)', () => {
    const condition = caller.jobs?.call?.if ?? '';
    expect(condition).toContain('github.event.comment.author_association');
    expect(condition).toContain('"OWNER","MEMBER","COLLABORATOR"');
    expect(condition).toContain('fromJson');
  });

  it('o `if:` do job exige que o comentario seja em um PR (issue.pull_request)', () => {
    const condition = caller.jobs?.call?.if ?? '';
    expect(condition).toContain('github.event.issue.pull_request');
  });

  it('mantem o branch pull_request normal', () => {
    const condition = caller.jobs?.call?.if ?? '';
    expect(condition).toContain("github.event_name == 'pull_request'");
  });
});
