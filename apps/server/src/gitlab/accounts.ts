import { spawn } from 'node:child_process';
import { gitlabAccountKey } from '@review-desk/shared/accounts';
import type { CliAccount } from '@/github/credentials.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { baseGlabEnvironment, glabCwd, glabUnavailable } from '@/gitlab/transport.js';

type Run = (args: string[]) => Promise<{ code: number | null; stdout: string; stderr: string }>;

interface RawHost {
  host?: string;
  state?: string;
  user?: string;
  username?: string;
}

const runGlab: Run = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('glab', args, {
      cwd: glabCwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      env: baseGlabEnvironment(),
    });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 30_000);

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({ code, stdout, stderr });
    });
  });

/**
 * The accounts signed in to the GitLab CLI, one per GitLab host (glab keeps a single sign-in per
 * host). Hosts come from glab's own configuration, so self-managed instances, custom ports and
 * relative URL roots work as glab is set up for them.
 */
export class GlabAccounts {
  constructor(private readonly run: Run = runGlab) {}

  async list(): Promise<CliAccount[]> {
    let result: Awaited<ReturnType<Run>>;

    try {
      result = await this.run(['auth', 'status', '--all', '--output', 'json']);
    } catch (error) {
      throw glabUnavailable(error);
    }

    // glab exits non-zero when any host fails verification, but still prints every host.
    let parsed: { hosts?: RawHost[] };

    try {
      parsed = JSON.parse(result.stdout) as typeof parsed;
    } catch {
      throw new GitHubError(
        safeError(
          result.stderr.trim() ||
            'Could not list GitLab CLI accounts. Update glab: Review Desk needs glab auth status --output json.',
        ),
        null,
        null,
        'unavailable',
      );
    }

    const accounts: CliAccount[] = [];

    for (const raw of parsed.hosts ?? []) {
      const user = raw.user ?? raw.username;

      // A host glab lists without a user has no sign-in (a missing or rejected token).
      if (!raw.host || !user) continue;

      // Kept as glab spells it: `--hostname` must match glab's configuration.
      const host = raw.host;

      accounts.push({
        login: gitlabAccountKey(user, host),
        forge: 'gitlab',
        host,
        cliActive: true,
        ok: raw.state === 'success',
      });
    }

    return accounts;
  }
}
