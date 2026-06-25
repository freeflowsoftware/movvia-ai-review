/**
 * CLI: tsx lib/walkthrough-cli.ts <diffPath> [packPath]
 *
 * Env obrigatórias: LLM_API_KEY, GH_TOKEN, PR_NUMBER, GH_REPO
 * Env opcionais:    LLM_BASE_URL, WALKTHROUGH_MODEL, PR_TITLE
 *
 * Gera o walkthrough via LLM e posta (ou atualiza) um comentário top-level no PR.
 * Escreve o WalkthroughResult JSON em stdout (para upload como artefato).
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Octokit } from '@octokit/rest';
import { realChatRunner } from './run-agent.js';
import {
  generateWalkthrough,
  formatWalkthroughComment,
  walkthroughMarker,
  readWalkthroughModel,
} from './walkthrough.js';

const DEFAULT_MODEL = 'gemini/gemini-flash-lite';

function readFileSafe(path: string): string | undefined {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : undefined; }
  catch { return undefined; }
}

function parseRepo(ghRepo: string): { owner: string; repo: string } {
  const [owner = '', repo = ''] = ghRepo.split('/');
  if (!owner || !repo) throw new Error(`GH_REPO inválido: "${ghRepo}" (esperado "owner/repo")`);
  return { owner, repo };
}

/**
 * Busca o id do comentário de walkthrough existente no PR.
 * Usa o marker invisível para idempotência — sem SHA, sempre sobrescreve.
 */
async function findExistingWalkthroughComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
): Promise<number | null> {
  const marker = walkthroughMarker();
  // Itera páginas de comentários até encontrar o marker ou esgotar
  let page = 1;
  while (true) {
    const { data } = await octokit.issues.listComments({
      owner, repo, issue_number: prNumber, per_page: 100, page,
    });
    if (data.length === 0) break;
    const found = data.find((c) => c.body?.includes(marker));
    if (found) return found.id;
    if (data.length < 100) break;
    page++;
  }
  return null;
}

async function upsertWalkthroughComment(
  octokit: Octokit,
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
): Promise<void> {
  const existingId = await findExistingWalkthroughComment(octokit, owner, repo, prNumber);
  if (existingId !== null) {
    await octokit.issues.updateComment({ owner, repo, comment_id: existingId, body });
  } else {
    await octokit.issues.createComment({ owner, repo, issue_number: prNumber, body });
  }
}

if (process.argv[1]?.endsWith('walkthrough-cli.ts')) {
  const diffPath = process.argv[2] ?? '';
  const packPath = process.argv[3];

  if (!diffPath) {
    process.stderr.write('Uso: tsx lib/walkthrough-cli.ts <diffPath> [packPath]\n');
    process.exit(1);
  }

  const diff = readFileSync(diffPath, 'utf8');
  const contextPack = packPath ? readFileSafe(packPath) : undefined;
  const prTitle = process.env.PR_TITLE;

  // Precedência: env (CI seta WALKTHROUGH_MODEL fixo) > defaults.yml (execução local) > hardcoded.
  const yamlModel = readWalkthroughModel(join(import.meta.dirname, '..', 'config', 'defaults.yml'));
  const model = process.env.WALKTHROUGH_MODEL || yamlModel || DEFAULT_MODEL;
  const result = await generateWalkthrough(diff, model, realChatRunner, contextPack, prTitle);

  const ghRepo = process.env.GH_REPO ?? '';
  const prNumber = Number(process.env.PR_NUMBER);
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

  if (ghRepo && prNumber && token) {
    const { owner, repo } = parseRepo(ghRepo);
    // `||` e não `??`: secrets ausentes no Actions chegam como string vazia
    const octokit = new Octokit({ auth: token });
    const body = formatWalkthroughComment(result);
    await upsertWalkthroughComment(octokit, owner, repo, prNumber, body);
  } else {
    process.stderr.write(
      'Aviso: GH_TOKEN, PR_NUMBER ou GH_REPO ausente — walkthrough gerado mas não postado.\n',
    );
  }

  process.stdout.write(JSON.stringify(result));
}
