import { Octokit } from '@octokit/rest';

export interface PostTarget { owner: string; repo: string; prNumber: number; }

/** Cria um check run review-bot/verdict. Borda externa: nao coberto por unit test. */
export async function emitCheckRun(
  octokit: Octokit,
  t: PostTarget,
  headSha: string,
  conclusion: 'success' | 'failure',
  summary: string,
): Promise<void> {
  await octokit.checks.create({
    owner: t.owner,
    repo: t.repo,
    name: 'review-bot/verdict',
    head_sha: headSha,
    status: 'completed',
    conclusion,
    output: { title: 'movvia-ai-review', summary },
  });
}
