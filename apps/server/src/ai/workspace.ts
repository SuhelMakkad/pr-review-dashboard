import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x } from 'tar';
import type { ReviewInputs } from '@review-desk/shared/ai';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { GitHubApi } from '@/github/api.js';
import { parseAccount } from '@review-desk/shared/accounts';
import { ghCredentials, type CredentialSource } from '@/github/credentials.js';
import { safeError } from '@/github/errors.js';
import { baseGlabEnvironment, glabCwd } from '@/gitlab/transport.js';
import { AgentError } from '@/ai/provider.js';
import { log } from '@/log.js';
import { observeInputs } from '@/ai/inputs.js';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;

/**
 * Whose a review's archives are, and, for GitHub, the credentials its downloads use: settled when
 * the run starts and kept to its end, whatever is selected meanwhile.
 */
export interface ArchiveAccess {
  account: string | null;
  /** GitHub's credentials for the run; GitLab's CLI signs each request in for itself. */
  credentials: CredentialSource | null;
}

/** The archive access of a run for `account`; with none, the selected account's. */
export function archiveAccess(account: string | null): ArchiveAccess {
  if (!account) return { account: null, credentials: ghCredentials };

  return {
    account,
    credentials: parseAccount(account).forge === 'github' ? ghCredentials.bind(account) : null,
  };
}

export type RepositoryExporter = (
  repository: string,
  oid: string,
  directory: string,
  signal: AbortSignal,
  access: ArchiveAccess,
) => Promise<string[]>;

/** Extract regular files only; repository symlinks must never lead outside the review workspace. */
export async function extractRepository(
  archive: string,
  directory: string,
  signal: AbortSignal,
): Promise<string[]> {
  const omitted: string[] = [];
  let extracted = 0;

  signal.throwIfAborted();
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await x({
    file: archive,
    cwd: directory,
    strip: 1,
    strict: true,
    preservePaths: false,
    filter: (path, entry) => {
      if (signal.aborted) return false;

      const regular = 'type' in entry && (entry.type === 'File' || entry.type === 'Directory');
      const safe = !isAbsolute(path) && !path.split(/[\\/]/).includes('..');

      if (!regular || !safe || extracted + entry.size > MAX_EXTRACTED_BYTES) {
        // As extracted: relative to the snapshot's root, like the paths in the PR's diff.
        omitted.push(path.split(/[\\/]/).slice(1).join('/') || path);
        return false;
      }

      extracted += entry.size;
      return true;
    },
  });
  signal.throwIfAborted();

  return omitted;
}

interface ArchiveCommand {
  command: 'gh' | 'glab';
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

const COMMIT = /^[a-f0-9]{40,64}$/i;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** GitLab projects can sit in nested groups: `group/subgroup/project`. */
const GITLAB_PROJECT = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/;

async function archiveCommand(
  repository: string,
  oid: string,
  access: ArchiveAccess,
): Promise<ArchiveCommand> {
  const account = parseAccount(access.account ?? '');

  if (account.forge === 'gitlab') {
    if (!GITLAB_PROJECT.test(repository) || !COMMIT.test(oid)) throw invalidRepository();

    return {
      command: 'glab',
      args: [
        'api',
        '--hostname',
        account.host,
        `projects/${encodeURIComponent(repository)}/repository/archive.tar.gz?sha=${oid}`,
      ],
      env: baseGlabEnvironment(),
      cwd: glabCwd(),
    };
  }

  if (!GITHUB_REPOSITORY.test(repository) || !COMMIT.test(oid)) throw invalidRepository();

  return {
    command: 'gh',
    args: ['api', '--hostname', 'github.com', `repos/${repository}/tarball/${oid}`],
    env: await (access.credentials ?? ghCredentials).environment(),
  };
}

const invalidRepository = () =>
  new AgentError('The repository or commit is invalid. Refresh this PR and try again.');

/**
 * The server downloads immutable snapshots using gh or glab, as the account the review belongs to;
 * no GitHub or GitLab credentials reach the agent.
 */
export const downloadRepository: RepositoryExporter = async (
  repository,
  oid,
  directory,
  signal,
  access,
) => {
  const { command, args, env, cwd } = await archiveCommand(repository, oid, access);
  const archive = `${directory}.tar.gz`;
  const started = performance.now();
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120_000)]);

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const child = spawn(command, args, {
    env,
    cwd,
    signal: combined,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let bytes = 0;
  let stderr = '';
  const limit = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;

      if (bytes > MAX_ARCHIVE_BYTES) {
        callback(new AgentError('This repository snapshot exceeds the 100 MB download limit.'));
        return;
      }

      callback(null, chunk);
    },
  });

  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-20_000);
  });

  const finished = new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new AgentError(safeError(stderr.trim() || 'Could not download the review repository.')),
        );
    });
  });

  try {
    await Promise.all([
      finished,
      pipeline(child.stdout, limit, createWriteStream(archive, { mode: 0o600 }), {
        signal: combined,
      }),
    ]);

    const downloaded = performance.now();
    const omitted = await extractRepository(archive, directory, combined);

    // How big each snapshot is and where its time goes, for deciding whether to cache them.
    log.event('info', 'ai.archive', {
      side: basename(directory) === 'before' ? 'before' : 'after',
      bytes,
      downloadMs: downloaded - started,
      extractMs: performance.now() - downloaded,
    });

    return omitted;
  } catch (error) {
    const timedOut = combined.aborted && !signal.aborted;

    controller.abort();

    if (signal.aborted) throw new AgentError('Cancelled.');
    if (timedOut) throw new AgentError('Downloading the review repository timed out.');

    throw error;
  } finally {
    await rm(archive, { force: true });
  }
};

/** Prepares the snapshots a full review reads, and returns what they hold of the change. */
export async function prepareReviewWorkspace(
  github: GitHubApi,
  pr: PullRequestSnapshot,
  diff: DiffManifest,
  directory: string,
  signal: AbortSignal,
  exportRepository: RepositoryExporter,
  access: ArchiveAccess,
): Promise<ReviewInputs> {
  if (!pr.baseOid)
    throw new AgentError('The PR base commit is unavailable. Refresh and try again.');

  // glab signs each request in with its own sign-in: the compare and both downloads count as this
  // account's only between checks that glab still is it, or the agent would read someone else's.
  const check = async () => {
    if (access.account) await github.verifyAccount?.(access.account);
  };

  await check();

  const comparison = await github.compare(pr.repository, pr.baseOid, pr.headOid);
  const mergeBase = comparison?.mergeBaseOid;

  if (!mergeBase)
    throw new AgentError('The PR merge base could not be found. Refresh and try again.');

  const omittedBefore = await exportRepository(
    pr.repository,
    mergeBase,
    join(directory, 'before'),
    signal,
    access,
  );

  await check();

  const omittedAfter = await exportRepository(
    pr.repository,
    pr.headOid,
    join(directory, 'after'),
    signal,
    access,
  );

  await check();
  signal.throwIfAborted();

  const { inputs, files } = await observeInputs(directory, pr, diff, comparison, mergeBase);

  await writeFile(
    join(directory, 'review.json'),
    JSON.stringify(
      {
        repository: pr.repository,
        number: pr.number,
        title: pr.title,
        description: pr.body,
        baseOid: mergeBase,
        headOid: pr.headOid,
        files,
        expectedChangedFiles: pr.changedFiles,
        threads: pr.threads,
        reviews: pr.reviews,
        conversation: pr.conversation,
        omittedBefore,
        omittedAfter,
        inputs,
        notes: [
          inputs.inventory === 'verified'
            ? 'Compare before/ and after/ for missing or truncated patches. Neither snapshot contains Git credentials.'
            : 'The changed files could not be confirmed for these commits, so no patches are included: read before/ and after/ to see what changed. Neither snapshot contains Git credentials.',
          'Symlinks and submodule contents are unavailable; report any material coverage gaps.',
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );

  return inputs;
}
