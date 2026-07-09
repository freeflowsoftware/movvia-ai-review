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
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface WorkflowJob {
  needs?: string | string[];
  steps?: WorkflowStep[];
}
interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

// `needs` aceita string unica ou lista no YAML do Actions; normaliza para array para os asserts.
function jobNeeds(wf: Workflow, jobId: string): string[] {
  const needs = wf.jobs?.[jobId]?.needs;
  if (!needs) return [];
  return Array.isArray(needs) ? needs : [needs];
}

// Procura um step do job que use `actions/<up|down>load-artifact` com `with.name` esperado.
function hasArtifactStep(wf: Workflow, jobId: string, action: string, name: string): boolean {
  const steps = wf.jobs?.[jobId]?.steps ?? [];
  return steps.some(
    (s) => (s.uses ?? '').includes(action) && String(s.with?.name ?? '') === name,
  );
}

// Fase 0: o que derruba ~3min do tempo NAO e o binario do pnpm (npm i -g pnpm@9 baixa o
// CLI em ~2s), e sim o cache do STORE (deps do projeto) via actions/setup-node cache:pnpm.
// NAO usamos pnpm/action-setup: em jobs que fazem checkout do repo ALVO no cwd, ele le o
// package.json do alvo (packageManager) e conflita com a versao -> "Multiple versions of pnpm".
function jobUsesPnpmCache(wf: Workflow, jobId: string): boolean {
  const steps = wf.jobs?.[jobId]?.steps ?? [];
  return steps.some((s) => String(s.with?.cache ?? '') === 'pnpm');
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

// I2: o resolve de threads (resolveReviewThreads/listFindingThreads) precisa de um token
// que RESOLVE — o GITHUB_TOKEN nativo do bot NAO resolve threads, mas o PAT/App resolve.
// O step de post deve exportar AI_REVIEW_REPO_TOKEN (PAT) ao ambiente para o CLI montar
// o resolveOctokit com identidade que resolve.
describe('o step de post expoe um PAT para o resolve de threads (I2)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  it('o step Postar review exporta AI_REVIEW_REPO_TOKEN ao ambiente', () => {
    const step = findStep(wf, 'post', 'Postar review');
    const keys = Object.keys(step.env ?? {});
    expect(keys).toContain('AI_REVIEW_REPO_TOKEN');
    expect(String(step.env!.AI_REVIEW_REPO_TOKEN)).toContain('secrets.AI_REVIEW_REPO_TOKEN');
  });

  it('o step de post exporta LLM_API_KEY + VERIFY_MODEL ao verificador de codigo (fecha-zumbi)', () => {
    // verifyZombieThreads roda no job post via realChatRunner -> precisa de LLM_API_KEY no
    // ambiente; VERIFY_MODEL e o modelo de raciocinio (deepseek-v4-flash, nao Flash-Lite).
    const step = findStep(wf, 'post', 'Postar review');
    const keys = Object.keys(step.env ?? {});
    expect(keys).toContain('LLM_API_KEY');
    expect(keys).toContain('VERIFY_MODEL');
    expect(String(step.env!.VERIFY_MODEL)).toBe('deepseek/deepseek-v4-flash');
  });
});

// O verificador de codigo le/fecha threads contra o head; um run velho contra estado
// obsoleto e perigoso. concurrency top-level serializa por PR e cancela o run velho.
describe('ai-review tem concurrency por PR (serializa o verificador de codigo)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow & { concurrency?: { group?: string; 'cancel-in-progress'?: boolean } };

  it('grupo COMPARTILHADO por PR (sem o event) + cancel-in-progress false (serializa pipeline x judge)', () => {
    // group sem o event -> pipeline (push) e judge (review_comment) do mesmo PR serializam
    // as escritas do store/threads. false: nao mata um julgamento/pipeline em curso (enfileira).
    expect(wf.concurrency).toBeDefined();
    expect(String(wf.concurrency!.group)).toContain('inputs.pr_number');
    expect(String(wf.concurrency!.group)).not.toContain('event');
    expect(wf.concurrency!['cancel-in-progress']).toBe(false);
  });
});

describe('judge-pushback: caminho paralelo isolado por evento', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow & { jobs?: Record<string, { if?: string; steps?: Array<{ run?: string; env?: Record<string, string> }> }> };

  it('o reusable aceita inputs event + comment_id', () => {
    const inputs = (wf as unknown as { on?: { workflow_call?: { inputs?: Record<string, unknown> } } }).on?.workflow_call?.inputs ?? {};
    expect(Object.keys(inputs)).toEqual(expect.arrayContaining(['event', 'comment_id']));
  });

  it('job judge-pushback so roda no review_comment; pipeline (gates/discover) so fora dele', () => {
    expect(wf.jobs!['judge-pushback']?.if).toContain("inputs.event == 'review_comment'");
    expect(wf.jobs!.gates?.if).toContain("inputs.event != 'review_comment'");
    expect(wf.jobs!.discover?.if).toContain("inputs.event != 'review_comment'");
  });

  it('judge-pushback roda lib/judge.ts com JUDGE_MODEL de raciocinio (deepseek)', () => {
    const steps = wf.jobs!['judge-pushback']?.steps ?? [];
    const judgeStep = steps.find((s) => (s.run ?? '').includes('lib/judge.ts'));
    expect(judgeStep).toBeDefined();
    expect(String(judgeStep!.env!.JUDGE_MODEL)).toBe('deepseek/deepseek-v4-flash');
    expect(Object.keys(judgeStep!.env!)).toEqual(expect.arrayContaining(['COMMENT_ID', 'LLM_API_KEY']));
  });
});

// Fase 0: todos os jobs do ai-review.yml usam cache de pnpm (pnpm/action-setup +
// setup-node cache:pnpm) e nenhum reinstala o pnpm global, que invalidaria o cache.
describe('jobs do ai-review usam cache de pnpm (Fase 0)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  const jobIds = ['gates', 'discover', 'context-pack', 'review', 'gatekeeper', 'post'];

  for (const jobId of jobIds) {
    it(`o job ${jobId} cacheia o pnpm store (setup-node cache:pnpm)`, () => {
      expect(jobUsesPnpmCache(wf, jobId)).toBe(true);
    });
  }
});

// Fase 0: o self-test (que roda no proprio repo) tambem migra para o cache de pnpm.
describe('self-test usa cache de pnpm (Fase 0)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/self-test.yml'), 'utf8'),
  ) as Workflow;

  it('o job test cacheia o pnpm store (setup-node cache:pnpm)', () => {
    expect(jobUsesPnpmCache(wf, 'test')).toBe(true);
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

// Fase 1c: o job `context-pack` roda o context-pack-cli no repo alvo e publica o pack como
// artefato; o job `review` passa a depender dele, baixa o artefato e o repassa ao agente.
// Estes asserts travam a fiacao do pack determinístico no pipeline (sem eles o pack fica
// gerado mas nunca chega ao prompt do agente).
describe('job context-pack alimenta o review (Fase 1c)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  it('o job context-pack existe e depende do discover', () => {
    expect(wf.jobs?.['context-pack']).toBeDefined();
    expect(jobNeeds(wf, 'context-pack')).toContain('discover');
  });

  it('o job context-pack roda o context-pack-cli a partir do checkout central', () => {
    const step = findStep(wf, 'context-pack', 'context-pack');
    expect(step.run ?? '').toContain('_review/lib/context-pack-cli.ts');
    expect(step.run ?? '').toContain('"$GITHUB_WORKSPACE"');
  });

  it('o job context-pack captura o diff forcando o repo alvo (GH_REPO)', () => {
    const step = findStep(wf, 'context-pack', 'Capturar diff');
    expect(String(step.env?.GH_REPO ?? '')).toContain('github.repository');
  });

  it('o job context-pack publica o artefato context-pack', () => {
    expect(hasArtifactStep(wf, 'context-pack', 'upload-artifact', 'context-pack')).toBe(true);
  });

  it('o job review depende de discover E context-pack', () => {
    const needs = jobNeeds(wf, 'review');
    expect(needs).toContain('discover');
    expect(needs).toContain('context-pack');
  });

  it('o job review baixa o artefato context-pack', () => {
    expect(hasArtifactStep(wf, 'review', 'download-artifact', 'context-pack')).toBe(true);
  });

  it('o step de review passa o caminho do pack como 4o argumento ao agent-runner-cli', () => {
    const step = findStep(wf, 'review', 'Rodar agente');
    const run = step.run ?? '';
    expect(run).toContain('agent-runner-cli.ts');
    // 4o argv: <agentName> <repoDir> <diffPath> <packPath>. O caminho do pack baixado
    // deve aparecer depois de /tmp/pr.diff na linha de invocacao.
    expect(run).toMatch(/agent-runner-cli\.ts.*\/tmp\/pr\.diff.*context-pack\.json/s);
  });
});

// FIX issue_comment: no re-run via /ai-review o github.ref e o default branch, entao o
// checkout do repo ALVO sem `ref` leria a main — o context-pack (camada 1: arquivo inteiro,
// irmaos, imports) e o repoDir do agente refletiriam codigo SEM as mudancas do PR, e o
// refuter refutaria findings contra excerpts velhos. Travamos o ref explicito no head do PR
// (refs/pull/N/head, nao /merge — o merge ref some quando o PR conflita).
describe('checkout do repo alvo aponta pro head do PR (re-run via /ai-review)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  for (const jobId of ['context-pack', 'review']) {
    it(`o job ${jobId} faz checkout do alvo com ref refs/pull/N/head`, () => {
      const step = findStep(wf, jobId, 'Checkout repo alvo');
      expect(String(step.with?.ref ?? '')).toBe('refs/pull/${{ inputs.pr_number }}/head');
    });
  }
});

// Fase 2: o refuter adversarial do gatekeeper passa a ser context-aware. O job gatekeeper
// baixa o artefato context-pack e repassa o caminho ao gatekeeper.ts (3o argv). Sem esta
// fiacao o pack seria gerado mas nunca chegaria ao prompt do cetico (refuta no escuro).
describe('context-pack alimenta o refuter do gatekeeper (Fase 2)', () => {
  const wf = YAML.parse(
    readFileSync(resolve(repoRoot, '.github/workflows/ai-review.yml'), 'utf8'),
  ) as Workflow;

  it('o job gatekeeper baixa o artefato context-pack', () => {
    expect(hasArtifactStep(wf, 'gatekeeper', 'download-artifact', 'context-pack')).toBe(true);
  });

  it('o step Consolidar passa o caminho do pack como 3o argumento ao gatekeeper.ts', () => {
    const step = findStep(wf, 'gatekeeper', 'Consolidar');
    const run = step.run ?? '';
    expect(run).toContain('gatekeeper.ts');
    // 3o argv: <findingsDir> <diffPath> <packPath>. O caminho do pack baixado deve aparecer
    // depois de /tmp/pr.diff na linha de invocacao.
    expect(run).toMatch(/gatekeeper\.ts.*\/tmp\/pr\.diff.*context-pack\.json/s);
  });
});
