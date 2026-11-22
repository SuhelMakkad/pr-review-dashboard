import { readFileSync } from 'node:fs';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { Evidence } from '@/ai/tasks.js';
import { DiffService } from '@/diff/service.js';
import type { GitHubApi } from '@/github/api.js';
import type { RemoteFile } from '@/forge/types.js';

/** A fixed PR, and what the forge holds for it: prompts built from it change only with the code. */
const sample = JSON.parse(
  readFileSync(new URL('../../../tests/fixtures/ai/prompt-sample.json', import.meta.url), 'utf8'),
) as Omit<Evidence, 'pr' | 'diff'> & {
  pr: PullRequestSnapshot;
  files: RemoteFile[];
  /** The changed file as reviewed before a rebase, and as it is now. */
  before: string;
  after: string;
};

/** The commits the sample PR was reviewed at: one for each way a since-review diff is built. */
const reviewed = { fastForward: 'a'.repeat(40), rebased: 'b'.repeat(40), gone: 'c'.repeat(40) };

/** Just enough forge for the diff service to build the sample's diffs, whatever the demo holds. */
function forge(): GitHubApi {
  const merge = {
    oid: 'd'.repeat(40),
    parents: ['e'.repeat(40), 'f'.repeat(40)],
    committedAt: null,
  };
  const baseOnly: RemoteFile = {
    path: 'docs/base-only.md',
    status: 'modified',
    additions: 1,
    deletions: 0,
    patch: '@@ -1 +1,2 @@\n line\n+added on main',
    sha: null,
  };

  return {
    pullFiles: async () => sample.files,
    compare: async (_repository: string, base: string) => {
      // The reviewed commit is gone from the forge.
      if (base === reviewed.gone) return null;
      // Pushed on top, with a merge of main that brought a file of its own.
      if (base === reviewed.fastForward)
        return {
          status: 'ahead',
          mergeBaseOid: base,
          filesComplete: true,
          files: [...sample.files, baseOnly],
          commits: [merge],
        };
      // Rebased: history rewritten since the review.
      if (base === reviewed.rebased)
        return { status: 'diverged', mergeBaseOid: null, files: [], commits: [] };

      // Main as the rebased review saw it.
      return { status: 'ahead', mergeBaseOid: null, files: sample.files, commits: [] };
    },
    blobs: async (_repository: string, requests: { oid: string }[]) =>
      requests.map(({ oid }) => ({
        text: oid === reviewed.rebased ? sample.before : sample.after,
        isBinary: false,
      })),
  } as unknown as GitHubApi;
}

/**
 * The sample's evidence for each diff a task can declare, built by the real diff service: the
 * full diff, and the since-review diff identical, fast-forwarded, rebased, and unavailable.
 */
export async function promptSamples(): Promise<Record<'full' | 'since-review', Evidence[]>> {
  const diffs = new DiffService(forge());
  const { pr } = sample;
  const evidence = (diff: DiffManifest): Evidence => ({
    pr,
    diff,
    draft: sample.draft,
    completedReview: sample.completedReview,
    login: sample.login,
  });
  const since = await Promise.all(
    [pr.headOid, reviewed.fastForward, reviewed.rebased, reviewed.gone].map((oid) =>
      diffs.manifest(pr, 'since-review', oid),
    ),
  );

  return {
    full: [evidence(await diffs.manifest(pr, 'full', null))],
    'since-review': since.map(evidence),
  };
}

/** The samples a task's prompt is rendered from, by the diff it declares. */
export const samplesFor = (
  samples: Record<'full' | 'since-review', Evidence[]>,
  diff: 'full' | 'since-review' | null,
) => samples[diff ?? 'full'];
