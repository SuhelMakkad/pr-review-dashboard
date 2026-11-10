import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { x } from 'tar';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { PullRequestSnapshot } from '@review-desk/shared/types';
import type { GitHubApi } from '@/github/api.js';
import { ghCredentials } from '@/github/credentials.js';
import { safeError } from '@/github/errors.js';
import { AgentError } from '@/ai/provider.js';

const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXTRACTED_BYTES = 512 * 1024 * 1024;

export type RepositoryExporter = (
  repository: string,
  oid: string,
  directory: string,
  signal: AbortSignal,
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
        omitted.push(path);
        return false;
      }

      extracted += entry.size;
      return true;
    },
  });
  signal.throwIfAborted();

  return omitted;
}

/**
 * The server downloads immutable snapshots using gh, as the account the review belongs to; no
 * GitHub credentials reach Codex.
 */
export const downloadRepository: RepositoryExporter = async (
  repository,
  oid,
  directory,
  signal,
) => {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40,64}$/i.test(oid)) {
    throw new AgentError('The repository or commit is invalid. Refresh this PR and try again.');
  }

  const archive = `${directory}.tar.gz`;
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal, AbortSignal.timeout(120_000)]);
  const env = await ghCredentials.environment();

  await mkdir(directory, { recursive: true, mode: 0o700 });

  const child = spawn(
    'gh',
    ['api', '--hostname', 'github.com', `repos/${repository}/tarball/${oid}`],
    {
      env,
      signal: combined,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
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

    return await extractRepository(archive, directory, combined);
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

export async function prepareReviewWorkspace(
  github: GitHubApi,
  pr: PullRequestSnapshot,
  diff: DiffManifest,
  directory: string,
  signal: AbortSignal,
  exportRepository: RepositoryExporter,
): Promise<void> {
  if (!pr.baseOid)
    throw new AgentError('The PR base commit is unavailable. Refresh and try again.');

  const comparison = await github.compare(pr.repository, pr.baseOid, pr.headOid);
  const mergeBase = comparison?.mergeBaseOid;

  if (!mergeBase)
    throw new AgentError('The PR merge base could not be found. Refresh and try again.');

  const omittedBefore = await exportRepository(
    pr.repository,
    mergeBase,
    join(directory, 'before'),
    signal,
  );
  const omittedAfter = await exportRepository(
    pr.repository,
    pr.headOid,
    join(directory, 'after'),
    signal,
  );

  signal.throwIfAborted();
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
        files: diff.files,
        expectedChangedFiles: pr.changedFiles,
        threads: pr.threads,
        reviews: pr.reviews,
        conversation: pr.conversation,
        omittedBefore,
        omittedAfter,
        notes: [
          'Compare before/ and after/ for missing or truncated patches. Neither snapshot contains Git credentials.',
          'Symlinks and submodule contents are unavailable; report any material coverage gaps.',
        ],
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}
