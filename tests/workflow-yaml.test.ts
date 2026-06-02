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

// FIX P0: o opencode precisa receber a credencial do LLM em runtime. Ele resolve o
// provider OpenAI-compatible de opencode.json via {env:LLM_API_KEY}/{env:LLM_BASE_URL},
// entao os steps que invocam o agente (review) e a etapa adversarial (gatekeeper)
// DEVEM exportar LLM_API_KEY ao ambiente do processo. Estes asserts travam o bug.
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

describe('credencial do LLM chega ao opencode em runtime', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  it('o step de review exporta LLM_API_KEY ao ambiente do opencode', () => {
    const step = findStep(wf, 'review', 'Rodar agente');
    expect(step.env).toBeDefined();
    expect(Object.keys(step.env!)).toContain('LLM_API_KEY');
    expect(String(step.env!.LLM_API_KEY)).toContain('secrets.LLM_API_KEY');
    // LLM_BASE_URL tambem precisa estar no env (com default quando o secret falta).
    expect(Object.keys(step.env!)).toContain('LLM_BASE_URL');
  });

  it('o step adversarial do gatekeeper exporta LLM_API_KEY ao ambiente do opencode', () => {
    const step = findStep(wf, 'gatekeeper', 'Consolidar');
    expect(step.env).toBeDefined();
    expect(Object.keys(step.env!)).toContain('LLM_API_KEY');
    expect(String(step.env!.LLM_API_KEY)).toContain('secrets.LLM_API_KEY');
    expect(Object.keys(step.env!)).toContain('LLM_BASE_URL');
  });

  it('o job gatekeeper instala o opencode (a etapa adversarial o invoca)', () => {
    const steps = wf.jobs?.gatekeeper?.steps ?? [];
    const installs = steps.some((s) => (s.run ?? '').includes('opencode-ai'));
    expect(installs).toBe(true);
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

describe('opencode.json configura um provider OpenAI-compatible para o LLM', () => {
  interface OpencodeProvider {
    npm?: string;
    options?: { baseURL?: string; apiKey?: string };
    models?: Record<string, unknown>;
  }
  interface OpencodeConfig {
    model?: string;
    provider?: Record<string, OpencodeProvider>;
  }
  const cfg = JSON.parse(
    readFileSync(resolve(repoRoot, 'opencode.json'), 'utf8'),
  ) as OpencodeConfig;

  it('define o model default e o provider que o resolve', () => {
    // Default do piloto: Gemini 2.5 Flash-Lite via OpenRouter (provider OpenAI-compat).
    expect(cfg.model).toBe('llm/google/gemini-2.5-flash-lite');
    const providerId = cfg.model!.split('/')[0]!;
    const provider = cfg.provider?.[providerId];
    expect(provider).toBeDefined();
    expect(provider!.npm).toBe('@ai-sdk/openai-compatible');
  });

  it('interpola LLM_BASE_URL e LLM_API_KEY no provider (credencial em runtime)', () => {
    const providerId = cfg.model!.split('/')[0]!;
    const opts = cfg.provider![providerId]!.options ?? {};
    expect(opts.apiKey).toBe('{env:LLM_API_KEY}');
    expect(opts.baseURL).toBe('{env:LLM_BASE_URL}');
  });

  it('declara o model referenciado por provider/model', () => {
    // O model id do OpenRouter contem '/' (ex: google/gemini-2.5-flash-lite), entao
    // o providerId e o 1o segmento e o modelId e o RESTO apos o 1o '/'.
    const segments = cfg.model!.split('/');
    const providerId = segments[0]!;
    const modelId = segments.slice(1).join('/');
    expect(cfg.provider![providerId]!.models).toHaveProperty(modelId);
  });
});
