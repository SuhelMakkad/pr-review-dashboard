import { AccountUnavailable } from '@/forge/account.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveItem, emptyTriage } from '@review-desk/shared/attention';
import { Store } from '@/db/store.js';
import { ForgeRouter } from '@/forge/router.js';
import type { GitHubApi } from '@/github/api.js';
import type { CliAccount } from '@/github/credentials.js';
import { GitHubError, safeError } from '@/github/errors.js';
import { GlabAccounts } from '@/gitlab/accounts.js';
import { commentPosition, locate, parseDiff } from '@/gitlab/positions.js';
import { GitLab } from '@/gitlab/read.js';
import { viewerReviews, type RawDiscussion, type RawMergeRequest } from '@/gitlab/snapshot.js';
import { reviewFingerprint } from '@/ai/freshness.js';
import {
  baseGlabEnvironment,
  glabCwd,
  GlabCli,
  paginate,
  type GitLabRequest,
  type GitLabTransport,
} from '@/gitlab/transport.js';
import { SyncService } from '@/sync/index.js';

const HOST = 'gitlab.example.com:8443';
const VIEWER = `rev@${HOST}`;
const BASE = 'b'.repeat(40);
const START = 's'.repeat(40).replace(/s/g, 'c');
const HEAD1 = '1'.repeat(40);
const HEAD2 = '2'.repeat(40);
const HEAD3 = '3'.repeat(40);
const WEB = `https://${HOST}/acme/platform/web/-/merge_requests/12`;

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 9, minutes)).toISOString();
const seconds = (minutes: number, extra: number) =>
  new Date(Date.UTC(2026, 10, 10, 9, minutes, extra)).toISOString();

const users = {
  dev: { id: 1, username: 'dev', avatar_url: null },
  rev: { id: 2, username: 'rev', avatar_url: null },
  ana: { id: 3, username: 'ana', avatar_url: null },
};

const APP_DIFF = '@@ -1,3 +1,4 @@\n line1\n-old2\n+new2\n+new3\n line3\n';

function note(
  id: number,
  author: keyof typeof users,
  body: string,
  created: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type: null,
    body,
    author: users[author],
    created_at: created,
    updated_at: created,
    system: false,
    resolvable: false,
    resolved: false,
    position: null,
    ...extra,
  };
}

function mergeRequest(overrides: Record<string, unknown> = {}) {
  return {
    id: 900,
    iid: 12,
    project_id: 7,
    title: 'Speed up the importer',
    description: 'Makes imports faster.',
    state: 'opened',
    created_at: at(0),
    updated_at: at(9),
    draft: false,
    author: users.dev,
    sha: HEAD2,
    diff_refs: { base_sha: BASE, start_sha: START, head_sha: HEAD2 },
    source_branch: 'feature/importer',
    target_branch: 'main',
    detailed_merge_status: 'not_approved',
    has_conflicts: false,
    user_notes_count: 4,
    reviewers: [users.rev, users.ana],
    assignees: [],
    web_url: WEB,
    references: { full: 'acme/platform/web!12' },
    head_pipeline: { id: 55, project_id: 7, status: 'running' },
    ...overrides,
  };
}

const position = (head: string, newLine: number | null, oldLine: number | null = null) => ({
  base_sha: BASE,
  start_sha: START,
  head_sha: head,
  old_path: 'src/app.ts',
  new_path: 'src/app.ts',
  position_type: 'text',
  old_line: oldLine,
  new_line: newLine,
  line_range: null,
});

function discussions() {
  return [
    {
      id: 'aa01',
      individual_note: true,
      notes: [note(101, 'dev', 'requested review from @rev and @ana', at(1), { system: true })],
    },
    {
      id: 'abc123',
      individual_note: false,
      notes: [
        note(102, 'rev', 'Can this loop exit early?', at(3), {
          type: 'DiffNote',
          position: position(HEAD1, 4),
          resolvable: true,
        }),
        note(105, 'dev', 'Done in the next commit.', at(5), {
          type: 'DiffNote',
          position: position(HEAD1, 4),
          resolvable: true,
        }),
      ],
    },
    {
      id: 'aa03',
      individual_note: true,
      notes: [note(103, 'rev', 'Summary: looks good overall.', seconds(3, 10))],
    },
    {
      id: 'aa04',
      individual_note: true,
      notes: [note(104, 'rev', 'approved this merge request', seconds(3, 20), { system: true })],
    },
    {
      id: 'aa05',
      individual_note: true,
      notes: [note(106, 'ana', '@rev can you check the retry path?', at(4))],
    },
    {
      id: 'aa06',
      individual_note: true,
      notes: [note(107, 'dev', 'requested review from @rev', at(6), { system: true })],
    },
  ];
}

interface Reply {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

/** A GitLab that answers from a table of `METHOD path` handlers (the query string is ignored). */
class FakeGitLab implements GitLabTransport {
  readonly host = HOST;
  readonly calls: GitLabRequest[] = [];
  readonly routes = new Map<string, (request: GitLabRequest) => Reply>();

  on(method: string, path: string, reply: Reply | ((request: GitLabRequest) => Reply)) {
    this.routes.set(`${method} ${path}`, typeof reply === 'function' ? reply : () => reply);

    return this;
  }

  async request<T>(request: GitLabRequest) {
    this.calls.push(request);

    const method = request.method ?? 'GET';
    const handler = this.routes.get(`${method} ${request.path.split('?')[0]}`);
    const reply = handler ? handler(request) : { status: 404, data: { message: '404 Not found' } };

    return {
      status: reply.status ?? 200,
      headers: reply.headers ?? { 'content-type': 'application/json' },
      data: reply.data as T,
    };
  }

  writes() {
    return this.calls.filter((call) => (call.method ?? 'GET') !== 'GET');
  }
}

const MR = 'projects/7/merge_requests/12';
const MR_BY_PATH = 'projects/acme%2Fplatform%2Fweb/merge_requests/12';

function gitlab(overrides: { mr?: Record<string, unknown>; diffs?: unknown[] } = {}) {
  const versions = [
    { id: 2, head_commit_sha: HEAD2, start_commit_sha: START, created_at: seconds(4, 30) },
    { id: 1, head_commit_sha: HEAD1, start_commit_sha: START, created_at: at(0) },
  ];
  const diffs = overrides.diffs ?? [
    {
      diff: APP_DIFF,
      new_path: 'src/app.ts',
      old_path: 'src/app.ts',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
    },
    {
      diff: '@@ -0,0 +1,2 @@\n+a\n+b\n',
      new_path: 'src/new.ts',
      old_path: 'src/new.ts',
      new_file: true,
      renamed_file: false,
      deleted_file: false,
    },
  ];
  const fake = new FakeGitLab()
    .on('GET', 'user', { data: users.rev })
    .on('GET', MR, { data: mergeRequest(overrides.mr) })
    .on('GET', `${MR}/discussions`, { data: discussions() })
    .on('GET', `${MR}/reviewers`, {
      data: [
        { user: users.rev, state: 'unreviewed', created_at: at(1) },
        { user: users.ana, state: 'requested_changes', created_at: at(1) },
      ],
    })
    .on('GET', `${MR}/approvals`, {
      data: { approved: false, user_has_approved: false, approved_by: [{ user: users.rev }] },
    })
    .on('GET', `${MR}/versions`, { data: versions })
    .on('GET', `${MR_BY_PATH}/versions`, { data: versions })
    .on('GET', `${MR_BY_PATH}/versions/2`, { data: { ...versions[0], diffs } })
    .on('GET', `${MR}/diffs`, { data: diffs })
    // The same merge request by its project path, as listing its files reads it.
    .on('GET', MR_BY_PATH, { data: mergeRequest(overrides.mr) })
    .on('GET', `${MR_BY_PATH}/diffs`, { data: diffs })
    .on('GET', `${MR}/draft_notes`, {
      data: [
        {
          id: 31,
          note: 'Pending thought',
          position: { head_sha: HEAD2, new_path: 'src/app.ts', new_line: 2 },
        },
      ],
    })
    .on('GET', 'projects/7/pipelines/55/jobs', {
      data: [
        { id: 1, name: 'unit', stage: 'test', status: 'running', web_url: 'https://ci/1' },
        { id: 2, name: 'lint', stage: 'test', status: 'success' },
        { id: 3, name: 'deploy', stage: 'deploy', status: 'manual', allow_failure: true },
      ],
    })
    .on('GET', `${MR}/notes`, { data: [note(107, 'dev', 'requested review from @rev', at(6))] })
    .on('GET', `projects/7/repository/commits/${HEAD2}`, {
      data: { committed_date: seconds(4, 30) },
    });
  const stores: Store[] = [];
  const store = new Store(':memory:');

  stores.push(store);
  cleanups.push(() => store.close());

  return { fake, client: new GitLab(fake, store.settings.forgeLocal), store };
}

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  vi.restoreAllMocks();
});

describe('GitLab CLI transport', () => {
  it('sends requests to one host through glab api and reads the included response', async () => {
    const run = vi.fn(async (_args: string[], _input: string | undefined) => ({
      code: 0,
      stdout: 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"id":5}',
      stderr: '',
      timedOut: false,
    }));
    const cli = new GlabCli(HOST, run);
    const response = await cli.request<{ id: number }>({
      method: 'POST',
      path: `${MR}/notes`,
      body: { body: 'Hi' },
    });

    expect(response).toMatchObject({ status: 201, data: { id: 5 } });
    expect(run).toHaveBeenCalledWith(
      ['api', '--hostname', HOST, '--include', '--method', 'POST', '--input', '-', `${MR}/notes`],
      '{"body":"Hi"}',
    );
  });

  it('reports rate limits with their reset time and sign-in failures as auth errors', async () => {
    const limited = new GlabCli(HOST, async () => ({
      code: 1,
      stdout: 'HTTP/2.0 429 Too Many Requests\nRetry-After: 30\n\n{"message":"slow down"}',
      stderr: '',
      timedOut: false,
    }));

    await expect(limited.request({ path: 'user' })).rejects.toMatchObject({
      outcome: 'rate_limit',
      status: 429,
    });

    const signedOut = new GlabCli(HOST, async () => ({
      code: 1,
      stdout: '',
      stderr: 'glab: 401 Unauthorized',
      timedOut: false,
    }));

    await expect(signedOut.request({ path: 'user' })).rejects.toMatchObject({ outcome: 'auth' });
  });
});

describe('GitLab CLI accounts', () => {
  it('lists one account per signed-in host, keyed by username and host', async () => {
    const accounts = new GlabAccounts(async () => ({
      code: 1,
      stdout: JSON.stringify({
        hosts: [
          { host: 'gitlab.com', state: 'error', token_source: 'none' },
          { host: 'Git.Example.com:8443', state: 'success', user: 'rev' },
          { host: 'old.example.com', state: 'error', user: 'rev' },
        ],
      }),
      stderr: '',
    }));

    expect(await accounts.list()).toEqual([
      {
        login: 'rev@Git.Example.com:8443',
        forge: 'gitlab',
        host: 'Git.Example.com:8443',
        cliActive: true,
        ok: true,
      },
      {
        login: 'rev@old.example.com',
        forge: 'gitlab',
        host: 'old.example.com',
        cliActive: true,
        ok: false,
      },
    ]);
  });

  it('runs glab without tokens or hosts from the environment, outside any repository', async () => {
    vi.stubEnv('GITLAB_TOKEN', 'test-gitlab-token');
    vi.stubEnv('GITLAB_API_HOST', 'elsewhere.example.com');
    vi.stubEnv('GLAB_API_PROTOCOL', 'http');
    vi.stubEnv('GITLAB_SUBFOLDER', 'other');
    vi.stubEnv('GLAB_DEBUG_HTTP', '1');
    vi.stubEnv('GIT_DIR', '/somewhere/.git');

    const env = baseGlabEnvironment();

    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.GITLAB_API_HOST).toBeUndefined();
    expect(env.GLAB_API_PROTOCOL).toBeUndefined();
    expect(env.GITLAB_SUBFOLDER).toBeUndefined();
    expect(env.GLAB_DEBUG_HTTP).toBeUndefined();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GLAB_NO_PROMPT).toBe('1');
    expect(glabCwd()).toMatch(/review-desk-glab-/);
    vi.unstubAllEnvs();
  });

  it('redacts GitLab tokens from messages', () => {
    expect(safeError(new Error('bad token glpat-AbCdEf0123456789xyz in request'))).toBe(
      'bad token [redacted] in request',
    );
    expect(safeError('runner GR1348941abcdefghijklmnop failed')).toBe('runner [redacted] failed');
    expect(safeError('a global-configuration-value stays')).toBe(
      'a global-configuration-value stays',
    );
  });
});

describe('comment positions', () => {
  const diff = parseDiff(APP_DIFF);

  it('numbers unchanged, removed and added lines as GitLab does', () => {
    expect(locate(diff, 'RIGHT', 4)).toMatchObject({ kind: 'context', oldLine: 3, newLine: 4 });
    expect(locate(diff, 'RIGHT', 2)).toMatchObject({
      kind: 'added',
      oldLine: null,
      newLine: 2,
      oldPos: 3,
    });
    expect(locate(diff, 'LEFT', 2)).toMatchObject({ kind: 'removed', oldLine: 2, newLine: null });

    // Expanded context after the hunk shifts by what the hunk added.
    expect(locate(diff, 'RIGHT', 10)).toMatchObject({ kind: 'context', oldLine: 9, newLine: 10 });
  });

  it('builds line, range and file positions against the diff refs', () => {
    const refs = { base_sha: BASE, start_sha: START, head_sha: HEAD2 };
    const file = { oldPath: 'src/app.ts', newPath: 'src/app.ts', diff: APP_DIFF };

    expect(
      commentPosition(file, refs, { path: 'src/app.ts', body: '', line: 4, side: 'RIGHT' }),
    ).toEqual({
      base_sha: BASE,
      start_sha: START,
      head_sha: HEAD2,
      old_path: 'src/app.ts',
      new_path: 'src/app.ts',
      position_type: 'text',
      old_line: 3,
      new_line: 4,
    });

    const range = commentPosition(file, refs, {
      path: 'src/app.ts',
      body: '',
      line: 4,
      startLine: 2,
      side: 'RIGHT',
    }) as { line_range: { start: Record<string, unknown>; end: Record<string, unknown> } };

    expect(range.line_range.start).toMatchObject({ type: 'new', old_line: null, new_line: 2 });
    expect(range.line_range.start.line_code).toMatch(/^[0-9a-f]{40}_3_2$/);
    expect(range.line_range.end).toMatchObject({ type: 'old', old_line: 3, new_line: 4 });

    expect(
      commentPosition(file, refs, { path: 'src/app.ts', body: '', subjectType: 'FILE' }),
    ).toMatchObject({ position_type: 'file' });
  });
});

describe('GitLab merge request snapshots', () => {
  it('reads where the target branch is last, after the rest of the merge request', async () => {
    const { client, fake } = gitlab();
    const branch = 'projects/7/repository/branches/main';
    let tip = BASE;

    fake.on('GET', branch, () => ({ data: { commit: { id: tip } } }));

    // The target moves while the snapshot's later requests are still out: the tip read last
    // sees it.
    for (const path of [`${MR}/diffs`, `${MR_BY_PATH}/diffs`]) {
      const listed = fake.routes.get(`GET ${path}`)!;

      fake.on('GET', path, (request) => {
        tip = HEAD1;

        return listed(request);
      });
    }

    expect((await client.snapshot('MR_7_12', VIEWER, ['requested'])).baseTipOid).toBe(HEAD1);
    expect(fake.calls.at(-1)?.path).toBe(branch);
  });

  it('reads the discussion after what is only shown, so a comment made meanwhile is seen', async () => {
    const { client, fake } = gitlab();
    const listed = fake.routes.get(`GET ${MR}/discussions`)!;
    let commented = false;

    // Someone comments while the diff is still being read.
    for (const path of [`${MR}/diffs`, `${MR_BY_PATH}/diffs`]) {
      const diffs = fake.routes.get(`GET ${path}`)!;

      fake.on('GET', path, (request) => {
        commented = true;

        return diffs(request);
      });
    }
    fake.on('GET', `${MR}/discussions`, (request) => {
      const reply = listed(request);

      return commented
        ? {
            ...reply,
            data: [
              ...(reply.data as unknown[]),
              {
                id: 'late',
                individual_note: true,
                notes: [
                  {
                    id: 999,
                    type: null,
                    body: 'Please wait for the security review.',
                    author: users.ana,
                    created_at: at(9),
                    updated_at: at(9),
                    system: false,
                    resolvable: false,
                    resolved: false,
                  },
                ],
              },
            ],
          }
        : reply;
    });

    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.conversation.map((comment) => comment.body)).toContain(
      'Please wait for the security review.',
    );
  });

  it('reads what is shown again when the merge request is pushed to while it is read', async () => {
    const { client, fake } = gitlab();
    const reads: string[] = [];
    let head = HEAD2;

    fake.on('GET', MR, () => ({ data: mergeRequest({ sha: head }) }));
    fake.on('GET', `projects/7/repository/commits/${HEAD2}`, () => {
      reads.push(HEAD2);
      head = HEAD3;

      return { data: { committed_date: at(5) } };
    });
    fake.on('GET', `projects/7/repository/commits/${HEAD3}`, () => {
      reads.push(HEAD3);

      return { data: { committed_date: at(6) } };
    });

    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(reads).toEqual([HEAD2, HEAD3]);
    expect(pr.headOid).toBe(HEAD3);
    expect(pr.headCommittedAt).toBe(at(6));
  });

  it('names reviewers and shows CI from the reads that go with them', async () => {
    const { client, fake } = gitlab();
    const shown = mergeRequest();
    let reads = 0;

    // An older GitLab without the reviewers endpoint: the merge request names them. While the
    // diff is read, a reviewer is added and a new pipeline starts on the same commit.
    fake.routes.delete(`GET ${MR}/reviewers`);
    fake.on('GET', MR, () =>
      ++reads === 1
        ? { data: shown }
        : {
            data: {
              ...shown,
              reviewers: [...(shown.reviewers ?? []), users.ana],
              head_pipeline: { id: 56, project_id: 7, status: 'success' },
            },
          },
    );

    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.reviewRequests.map((reviewer) => reviewer.login)).toContain('ana');
    // The jobs read were pipeline 55's, so its status is shown with them.
    expect(pr.ci).toBe('pending');
    expect(fake.calls.some((call) => call.path.startsWith('projects/7/pipelines/56'))).toBe(false);
  });

  it('keeps an approval summary with its approval, however long after, and nothing else', () => {
    const mr = { web_url: WEB } as RawMergeRequest;
    const note = (id: number, body: string, system: boolean, minute: number) => ({
      id,
      type: null,
      body,
      author: users.rev,
      created_at: seconds(10 + minute, 0),
      updated_at: seconds(10 + minute, 0),
      system,
    });
    const marker = '<!-- review-desk:ai-review run=run-1 -->';
    const summary = `${marker}\n<!-- review-desk:approval-summary -->\n**AI review** · No blocking findings`;
    const discussion = (id: string, ...notes: ReturnType<typeof note>[]): RawDiscussion => ({
      id,
      individual_note: true,
      notes,
    });
    const approval = discussion('approval', note(301, 'approved this merge request', true, 0));
    const versions = [{ id: 2, head_commit_sha: HEAD2, created_at: at(0) }];

    // Retried after GitLab refused it: five minutes after the approval.
    const reviews = viewerReviews(
      mr,
      [approval, discussion('summary', note(302, summary, false, 5))],
      versions,
      'rev',
    );

    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ state: 'APPROVED', body: summary, commitOid: HEAD2 });

    // So the review it came from is not out of date because of it.
    const pr = {
      baseOid: START,
      headOid: HEAD2,
      title: 'Title',
      body: '',
      reviews: [],
      threads: [],
      conversation: [],
      requestEvents: [],
    } as unknown as Parameters<typeof reviewFingerprint>[0];

    expect(reviewFingerprint({ ...pr, reviews }, 'rev')).toBe(reviewFingerprint(pr, 'rev'));

    // A comment-only AI post never joins an approval, nor does a summary after a push.
    const comment = `${marker}\n**AI review** · Changes recommended`;

    expect(
      viewerReviews(
        mr,
        [approval, discussion('comment', note(303, comment, false, 5))],
        versions,
        'rev',
      ),
    ).toEqual([expect.objectContaining({ state: 'APPROVED', body: '', commitOid: HEAD2 })]);
    expect(
      viewerReviews(
        mr,
        [approval, discussion('summary', note(304, summary, false, 5))],
        [...versions, { id: 3, head_commit_sha: HEAD3, created_at: seconds(12, 0) }],
        'rev',
      ),
    ).toEqual([expect.objectContaining({ state: 'APPROVED', body: '', commitOid: HEAD2 })]);
  });

  it('keeps your comment just before an automatic approval apart from it and its summary', () => {
    const mr = { web_url: WEB } as RawMergeRequest;
    const at = (minute: number, second = 0) => seconds(10 + minute, second);
    const summary =
      '<!-- review-desk:ai-review run=run-1 -->\n<!-- review-desk:approval-summary -->\nSummary';
    const discussions: RawDiscussion[] = [
      {
        id: 'code',
        individual_note: false,
        notes: [
          {
            id: 401,
            type: 'DiffNote',
            body: 'Consider a guard here.',
            author: users.rev,
            created_at: at(0),
            updated_at: at(0),
            system: false,
            position: {
              head_sha: HEAD2,
              base_sha: BASE,
              start_sha: START,
              new_path: 'a.ts',
              new_line: 3,
            },
          } as never,
        ],
      },
      {
        id: 'approval',
        individual_note: true,
        notes: [
          {
            id: 402,
            type: null,
            body: 'approved this merge request',
            author: users.rev,
            created_at: at(0, 30),
            updated_at: at(0, 30),
            system: true,
          },
        ],
      },
      {
        id: 'summary',
        individual_note: true,
        notes: [
          {
            id: 403,
            type: null,
            body: summary,
            author: users.rev,
            created_at: at(5),
            updated_at: at(5),
            system: false,
          },
        ],
      },
    ];
    const reviews = viewerReviews(
      mr,
      discussions,
      [{ id: 2, head_commit_sha: HEAD2, created_at: at(-1) }],
      'rev',
    );

    expect(reviews.map(({ state, body }) => ({ state, body }))).toEqual([
      { state: 'COMMENTED', body: '' },
      { state: 'APPROVED', body: summary },
    ]);
  });

  it('ends an approval’s review with its summary, on the commit it approved', () => {
    const mr = { web_url: WEB } as RawMergeRequest;
    const note = (id: number, body: string, system: boolean, minute: number, second = 0) => ({
      id,
      type: null,
      body,
      author: users.rev,
      created_at: seconds(10 + minute, second),
      updated_at: seconds(10 + minute, second),
      system,
    });
    const summary =
      '<!-- review-desk:ai-review run=run-1 -->\n<!-- review-desk:approval-summary -->\nSummary';
    const discussion = (id: string, ...notes: ReturnType<typeof note>[]): RawDiscussion => ({
      id,
      individual_note: true,
      notes,
    });
    const approval = discussion('approval', note(501, 'approved this merge request', true, 0));

    // Approved on HEAD2, its summary five minutes later, then a push to HEAD3 and a reply on
    // code thirty seconds after the summary.
    const reviews = viewerReviews(
      mr,
      [
        approval,
        discussion('summary', note(502, summary, false, 5)),
        {
          id: 'code',
          individual_note: false,
          notes: [
            {
              ...note(503, 'Fixed the guard.', false, 5, 30),
              type: 'DiffNote',
              position: {
                head_sha: HEAD3,
                base_sha: BASE,
                start_sha: START,
                new_path: 'a.ts',
                new_line: 3,
              },
            } as never,
          ],
        },
      ],
      [
        { id: 2, head_commit_sha: HEAD2, created_at: seconds(9, 0) },
        { id: 3, head_commit_sha: HEAD3, created_at: seconds(15, 10) },
      ],
      'rev',
    );

    expect(reviews.map(({ state, body, commitOid }) => ({ state, body, commitOid }))).toEqual([
      { state: 'APPROVED', body: summary, commitOid: HEAD2 },
      { state: 'COMMENTED', body: '', commitOid: HEAD3 },
    ]);

    // A push between the approval and its summary, however soon: the summary is not its review,
    // nor that of an approval of the new head given by hand right after it.
    const pushed = viewerReviews(
      mr,
      [
        approval,
        discussion('summary', note(504, summary, false, 0, 40)),
        discussion('manual', note(505, 'approved this merge request', true, 1, 10)),
      ],
      [
        { id: 2, head_commit_sha: HEAD2, created_at: seconds(9, 0) },
        { id: 3, head_commit_sha: HEAD3, created_at: seconds(10, 20) },
      ],
      'rev',
    );

    expect(pushed.map(({ state, body, commitOid }) => ({ state, body, commitOid }))).toEqual([
      { state: 'APPROVED', body: '', commitOid: HEAD2 },
      { state: 'APPROVED', body: '', commitOid: HEAD3 },
    ]);
  });

  it('finds a marked note on a later page, following GitLab’s Link header', async () => {
    const { client, fake } = gitlab();
    const notes = `${MR}/notes`;
    const older = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      type: null,
      body: 'added 1 commit',
      author: users.dev,
      created_at: at(1),
      updated_at: at(1),
      system: true,
    }));

    fake.on('GET', notes, (request) =>
      request.path.includes('cursor=2')
        ? {
            data: [
              {
                id: 501,
                type: null,
                body: '<!-- review-desk:ai-review run=run-1 -->\nSummary',
                author: users.rev,
                created_at: at(2),
                updated_at: at(2),
                system: false,
              },
            ],
          }
        : {
            data: older,
            headers: {
              'content-type': 'application/json',
              link: `<https://gitlab.example.com/api/v4/${notes}?cursor=2&per_page=100>; rel="next"`,
            },
          },
    );

    await expect(
      client.markedComment('MR_7_12', 'rev', '<!-- review-desk:ai-review run=run-1 -->'),
    ).resolves.toEqual({ id: '501', url: `${WEB}#note_501` });
    await expect(
      client.markedComment('MR_7_12', 'rev', '<!-- review-desk:ai-review run=other -->'),
    ).resolves.toBeNull();
  });

  it('tells a missing target branch from one that could not be read', async () => {
    const missing = gitlab();

    expect((await missing.client.snapshot('MR_7_12', VIEWER, [])).baseTipOid).toBeNull();

    const unreadable = gitlab();

    unreadable.fake.on('GET', 'projects/7/repository/branches/main', {
      status: 503,
      data: { message: 'Service unavailable' },
    });

    const pr = await unreadable.client.snapshot('MR_7_12', VIEWER, []);

    expect('baseTipOid' in pr).toBe(false);

    // A rate limit keeps GitLab's retry time, as glab reports it.
    const limited = gitlab();
    const retryAt = new Date(Date.now() + 120_000).toISOString();

    limited.fake.on('GET', 'projects/7/repository/branches/main', () => {
      throw new GitHubError('GitLab rate limit reached.', retryAt, 429, 'rate_limit');
    });

    await expect(limited.client.snapshot('MR_7_12', VIEWER, [])).rejects.toMatchObject({
      outcome: 'rate_limit',
      retryAt,
    });
  });

  it('maps reviewers, reviews, threads, CI and files onto the pull request model', async () => {
    const { client } = gitlab();
    const pr = await client.snapshot('MR_7_12', VIEWER, ['requested']);

    expect(pr).toMatchObject({
      id: 'MR_7_12',
      number: 12,
      repository: 'acme/platform/web',
      url: WEB,
      author: { login: 'dev' },
      headOid: HEAD2,
      baseOid: START,
      baseRefName: 'main',
      headRefName: 'feature/importer',
      additions: 4,
      deletions: 1,
      changedFiles: 2,
      ci: 'pending',
      mergeable: 'MERGEABLE',
      mergeStateStatus: 'BLOCKED',
      reviewDecision: 'CHANGES_REQUESTED',
      pendingReview: { id: 'MRR_7_12', commentCount: 1 },
    });

    // rev was asked again after approving, so is requested; ana requested changes, so is not.
    expect(pr.reviewRequests).toEqual([{ kind: 'user', login: 'rev', name: 'rev' }]);
    expect(pr.requestEvents.map((event) => [event.reviewer?.login, event.createdAt])).toEqual([
      ['rev', at(1)],
      ['ana', at(1)],
      ['rev', at(6)],
    ]);

    // The diff note, summary and approval within a minute are one review.
    expect(pr.reviews).toEqual([
      {
        id: 'MRN_102',
        state: 'APPROVED',
        submittedAt: seconds(3, 20),
        updatedAt: seconds(3, 20),
        commitOid: HEAD1,
        body: 'Summary: looks good overall.',
        url: `${WEB}#note_102`,
      },
    ]);
    // The approval note identifies its verdict; a request for changes without a note has no id.
    expect(pr.verdicts).toEqual([
      {
        id: '104',
        login: 'rev',
        state: 'APPROVED',
        submittedAt: seconds(3, 20),
        commitOid: HEAD1,
      },
      { login: 'ana', state: 'CHANGES_REQUESTED', submittedAt: at(1), commitOid: HEAD1 },
    ]);

    expect(pr.threads).toHaveLength(1);
    // Left on an older commit: GitLab moves a thread forward only while its line is unchanged.
    expect(pr.threads[0]).toMatchObject({
      id: 'MRD_7_12_abc123',
      isResolved: false,
      isOutdated: true,
      path: 'src/app.ts',
      line: 4,
      diffSide: 'RIGHT',
      subjectType: 'LINE',
    });
    expect(pr.threads[0].comments.map((comment) => [comment.id, comment.replyToId])).toEqual([
      ['102', null],
      ['105', '102'],
    ]);
    expect(pr.conversation.map((comment) => comment.id)).toEqual(['103', '106']);
    expect(pr.checks).toEqual([
      { name: 'test: unit', state: 'pending', url: 'https://ci/1' },
      { name: 'test: lint', state: 'success', url: null },
      { name: 'deploy: deploy', state: 'none', url: null },
    ]);
    expect(pr.files.map((file) => [file.path, file.changeType, file.viewerViewedState])).toEqual([
      ['src/app.ts', 'MODIFIED', 'UNVIEWED'],
      ['src/new.ts', 'ADDED', 'UNVIEWED'],
    ]);

    // The attention rules read it as for GitHub: asked again, changed since the review, a reply in
    // rev's thread and a mention of @rev, matched by username within the host-qualified account.
    const item = deriveItem(pr, emptyTriage(), VIEWER, []);

    expect(item.reasons.map((reason) => reason.kind).sort()).toEqual([
      'changed',
      'mention',
      'reply',
      'requested_again',
    ]);
  });

  it('works with GitLab versions that predate the diffs, draft notes and reviewers APIs', async () => {
    const { client, fake } = gitlab();
    const missing = { status: 404, data: { message: '404 Not found' } };

    fake
      .on('GET', `${MR}/diffs`, missing)
      .on('GET', `${MR}/draft_notes`, missing)
      .on('GET', `${MR}/reviewers`, missing)
      .on('GET', `${MR}/changes`, {
        data: {
          changes: [
            {
              diff: APP_DIFF,
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            },
          ],
        },
      });

    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.files.map((file) => file.path)).toEqual(['src/app.ts']);
    expect(pr.pendingReview).toBeNull();
    // Without reviewer states, a reviewer is requested until they review after being asked: rev
    // was asked again after approving; ana only commented in the conversation, which is no review.
    expect(pr.reviewRequests.map((reviewer) => reviewer.login)).toEqual(['rev', 'ana']);
  });

  it('keeps viewed marks locally until the file changes again', async () => {
    const { client, fake } = gitlab();

    // It says which revision and which diff of the file it marked, as a snapshot records them.
    const marked = await client.as(VIEWER).setFileViewed('MR_7_12', 'src/app.ts', true);

    expect(marked).toEqual({ headOid: HEAD2, baseOid: START, fileKey: expect.any(String) });

    let pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.files.find((file) => file.path === 'src/app.ts')).toMatchObject({
      viewerViewedState: 'VIEWED',
      viewedKey: marked!.fileKey,
    });

    fake.on('GET', `${MR}/diffs`, {
      data: [
        {
          diff: `${APP_DIFF}+more\n`,
          new_path: 'src/app.ts',
          old_path: 'src/app.ts',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
    });
    pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.files[0].viewerViewedState).toBe('DISMISSED');

    await client.as(VIEWER).setFileViewed('MR_7_12', 'src/app.ts', false);
    pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.files[0].viewerViewedState).toBe('UNVIEWED');
    expect(fake.writes()).toEqual([]);
  });

  it('says only which diff it marked viewed when commits land during the write', async () => {
    const { client, fake } = gitlab();
    let reads = 0;

    fake.on('GET', MR, () => {
      reads++;

      return reads === 1
        ? { data: mergeRequest() }
        : {
            data: mergeRequest({
              sha: HEAD3,
              diff_refs: { base_sha: BASE, start_sha: START, head_sha: HEAD3 },
            }),
          };
    });

    expect(await client.setFileViewed('MR_7_12', 'src/app.ts', true)).toEqual({
      headOid: HEAD2,
      baseOid: null,
      fileKey: expect.any(String),
    });
    expect(reads).toBe(2);
  });

  it('keeps a viewed mark that was saved when the revision cannot be read afterwards', async () => {
    const { client, fake } = gitlab();
    let reads = 0;

    fake.on('GET', MR, () => {
      reads++;

      return reads === 2
        ? { status: 503, data: { message: '503 Service Unavailable' } }
        : { data: mergeRequest() };
    });

    // Succeeds, so the outbox never sends it again; the diff it marked is still known.
    expect(await client.as(VIEWER).setFileViewed('MR_7_12', 'src/app.ts', true)).toMatchObject({
      baseOid: null,
      fileKey: expect.any(String),
    });

    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.files.find((file) => file.path === 'src/app.ts')?.viewerViewedState).toBe('VIEWED');
  });

  it('says only which diff it marked viewed while GitLab has no diff refs yet', async () => {
    const { client } = gitlab({ mr: { diff_refs: null } });

    expect(await client.setFileViewed('MR_7_12', 'src/app.ts', true)).toMatchObject({
      baseOid: null,
      fileKey: expect.any(String),
    });
  });

  it('refuses to mark a file viewed whose diff changed since you viewed it', async () => {
    const { client, fake } = gitlab();
    const viewed = await client.setFileViewed('MR_7_12', 'src/app.ts', false);

    expect(viewed).toBeNull();

    const pr = await client.snapshot('MR_7_12', VIEWER, []);
    const key = pr.files.find((file) => file.path === 'src/app.ts')!.viewedKey!;

    fake.on('GET', `${MR}/diffs`, {
      data: [
        {
          diff: `${APP_DIFF}+changed\n`,
          new_path: 'src/app.ts',
          old_path: 'src/app.ts',
          new_file: false,
          renamed_file: false,
          deleted_file: false,
        },
      ],
    });

    await expect(
      client.setFileViewed('MR_7_12', 'src/app.ts', true, { fileKey: key }),
    ).rejects.toThrow('changed after you viewed it');
    expect((await client.snapshot('MR_7_12', VIEWER, [])).files[0].viewerViewedState).toBe(
      'UNVIEWED',
    );
  });

  it('keys a diff GitLab leaves out to its revision, so a mark on it never outlasts a push', async () => {
    const binary = {
      diff: 'Binary files a/logo.png and b/logo.png differ\n',
      new_path: 'logo.png',
      old_path: 'logo.png',
      new_file: false,
      renamed_file: false,
      deleted_file: false,
    };
    const first = gitlab({ diffs: [binary] });
    const before = (await first.client.snapshot('MR_7_12', VIEWER, [])).files[0]!.viewedKey;
    const second = gitlab({
      diffs: [binary],
      mr: { sha: HEAD3, diff_refs: { base_sha: BASE, start_sha: START, head_sha: HEAD3 } },
    });
    const after = (await second.client.snapshot('MR_7_12', VIEWER, [])).files[0]!.viewedKey;

    expect(before).toBeDefined();
    expect(after).not.toBe(before);
  });

  it('lists the files of exactly the revision shown, from its diff version', async () => {
    const { client } = gitlab();
    const listed = await client.pinnedFiles('acme/platform/web', 12, {
      headOid: HEAD2,
      baseOid: START,
    });
    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(listed.pinned).toBe(true);
    expect(listed.files.map((file) => file.viewedKey)).toEqual(
      pr.files.map((file) => file.viewedKey),
    );
    expect(listed.files[0]?.viewedKey).toEqual(expect.any(String));
  });

  it('calls a diff version complete only where GitLab stored its whole list', async () => {
    const pinned = { headOid: HEAD2, baseOid: START };

    for (const [state, complete] of [
      ['collected', true],
      ['overflow_diff_files_limit', false],
    ] as const) {
      const { client, fake } = gitlab();

      fake.on('GET', `${MR_BY_PATH}/versions/2`, {
        data: {
          id: 2,
          head_commit_sha: HEAD2,
          start_commit_sha: START,
          base_commit_sha: BASE,
          state,
          created_at: seconds(4, 30),
          diffs: [
            {
              diff: APP_DIFF,
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            },
          ],
        },
      });

      const listed = await client.pinnedFiles('acme/platform/web', 12, pinned);

      expect(listed.pinned).toBe(true);
      expect(listed.complete ?? false).toBe(complete);
      expect(listed.mergeBaseOid).toBe(complete ? BASE : undefined);
    }
  });

  it('pins nothing for a revision GitLab has no diff version of', async () => {
    const { client } = gitlab();

    // An older head than the version on record, and the same head retargeted onto another base.
    for (const revision of [
      { headOid: HEAD3, baseOid: START },
      { headOid: HEAD2, baseOid: BASE },
    ]) {
      const listed = await client.pinnedFiles('acme/platform/web', 12, revision);

      expect(listed.pinned).toBe(false);
      expect(listed.files.length).toBeGreaterThan(0);
      expect(listed.files.every((file) => !file.viewedKey)).toBe(true);
    }
  });

  it('shows the live diff, unpinned, when the diff version cannot be read', async () => {
    const pinned = { headOid: HEAD2, baseOid: START };

    // Its stored patches were cleaned up: GitLab lists none for it.
    const cleaned = gitlab();

    cleaned.fake.on('GET', `${MR_BY_PATH}/versions/2`, {
      data: {
        id: 2,
        head_commit_sha: HEAD2,
        start_commit_sha: START,
        state: 'without_files',
        diffs: [],
      },
    });

    const fromCleaned = await cleaned.client.pinnedFiles('acme/platform/web', 12, pinned);

    expect(fromCleaned.pinned).toBe(false);
    expect(fromCleaned.files.map((file) => file.path)).toEqual(['src/app.ts', 'src/new.ts']);
    expect(fromCleaned.files.every((file) => !file.viewedKey)).toBe(true);

    // The version endpoints fail, while the live diff works.
    for (const failing of [`${MR_BY_PATH}/versions`, `${MR_BY_PATH}/versions/2`]) {
      const { client, fake } = gitlab();

      fake.on('GET', failing, { status: 503, data: { message: '503 Service Unavailable' } });

      const listed = await client.pinnedFiles('acme/platform/web', 12, pinned);

      expect(listed.pinned).toBe(false);
      expect(listed.files).toHaveLength(2);
    }
  });

  it('detects changes per project and asks about running pipelines', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', 'projects/7/merge_requests', (request) => ({
      data: request.path.includes('iids[]=12') ? [mergeRequest()] : [],
    }));

    const first = await client.detect(['MR_7_12', 'MR_7_99']);

    expect(first.results).toEqual([
      { id: 'MR_7_12', state: 'OPEN', fingerprint: expect.any(String) },
      { id: 'MR_7_99', state: null, fingerprint: null },
    ]);

    // A stored snapshot with CI still running makes detection read its pipeline too.
    fake.on('GET', MR, {
      data: mergeRequest({ head_pipeline: { id: 55, project_id: 7, status: 'failed' } }),
    });

    const second = await client.detect(['MR_7_12'], { ciPending: new Set(['MR_7_12']) });

    expect(second.results[0].fingerprint).not.toBe(first.results[0].fingerprint);

    // Without it, detection reads no pipeline: what is polled follows saved snapshots alone.
    const third = await client.detect(['MR_7_12']);

    expect(third.results[0].fingerprint).toBe(first.results[0].fingerprint);
  });

  it('compares commits through the merge base', async () => {
    const { client, fake } = gitlab();

    fake
      .on('GET', 'projects/acme%2Fplatform%2Fweb/repository/compare', {
        data: {
          commits: [{ id: HEAD2, parent_ids: [HEAD1], committed_date: at(4) }],
          diffs: [
            {
              diff: '@@ -1 +1 @@\n-a\n+b\n',
              new_path: 'src/app.ts',
              old_path: 'src/app.ts',
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            },
          ],
        },
      })
      .on('GET', 'projects/acme%2Fplatform%2Fweb/repository/merge_base', { data: { id: HEAD1 } });

    expect(await client.compare('acme/platform/web', HEAD1, HEAD2)).toMatchObject({
      status: 'ahead',
      mergeBaseOid: HEAD1,
      commits: [{ oid: HEAD2, parents: [HEAD1], committedAt: at(4) }],
      files: [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 }],
    });

    fake.on('GET', 'projects/acme%2Fplatform%2Fweb/repository/merge_base', { data: { id: BASE } });
    expect((await client.compare('acme/platform/web', HEAD1, HEAD2))?.status).toBe('diverged');

    fake.on('GET', 'projects/acme%2Fplatform%2Fweb/repository/compare', { status: 404, data: {} });
    expect(await client.compare('acme/platform/web', HEAD1, HEAD2)).toBeNull();
  });

  it('turns the history backfill search into GitLab list filters', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', 'merge_requests', { data: [mergeRequest()] });

    expect(
      await client.searchPullIds({
        kind: 'reviewed',
        login: VIEWER,
        from: '2026-10-01',
        to: '2026-10-31',
      }),
    ).toEqual(['MR_7_12']);
    // The same filters the GitHub search syntax used to be parsed into: the window inclusive.
    expect(fake.calls.at(-1)?.path).toBe(
      'merge_requests?scope=all&state=all&reviewer_username=rev&updated_after=2026-10-01T00%3A00%3A00Z&updated_before=2026-11-01T00%3A00%3A00.000Z&per_page=100',
    );

    await client.searchPullIds({
      kind: 'authored',
      login: VIEWER,
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(fake.calls.at(-1)?.path).toBe(
      'merge_requests?scope=all&state=all&author_username=rev&created_after=2026-10-01T00%3A00%3A00Z&created_before=2026-11-01T00%3A00%3A00.000Z&per_page=100',
    );

    // Named projects are listed one at a time: GitLab's merge request list takes no project filter.
    fake
      .on('GET', 'projects/acme%2Fplatform%2Fweb/merge_requests', { data: [mergeRequest()] })
      .on('GET', 'projects/acme%2Fother/merge_requests', { data: [] });

    expect(
      await client.searchPullIds({
        kind: 'reviewed',
        login: VIEWER,
        from: '2026-10-01',
        to: '2026-10-31',
        repositories: ['acme/platform/web', 'acme/other'],
      }),
    ).toEqual(['MR_7_12']);
    expect(fake.calls.slice(-2).map((call) => call.path)).toEqual([
      'projects/acme%2Fplatform%2Fweb/merge_requests?state=all&reviewer_username=rev&updated_after=2026-10-01T00%3A00%3A00Z&updated_before=2026-11-01T00%3A00%3A00.000Z&per_page=100',
      'projects/acme%2Fother/merge_requests?state=all&reviewer_username=rev&updated_after=2026-10-01T00%3A00%3A00Z&updated_before=2026-11-01T00%3A00%3A00.000Z&per_page=100',
    ]);
  });
});

describe('GitLab writes', () => {
  it('saves review comments as draft notes and publishes them with an approval', async () => {
    const { client, fake } = gitlab();

    fake
      .on('POST', `${MR}/draft_notes`, { status: 201, data: { id: 41, note: 'x' } })
      .on('POST', `${MR}/approve`, { status: 201, data: {} })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' });

    const reviewId = await client.addPendingReview('MR_7_12', HEAD2);

    expect(reviewId).toBe('MRR_7_12');
    expect(
      await client.addReviewThread(reviewId, {
        path: 'src/app.ts',
        body: 'Early exit?',
        line: 4,
        side: 'RIGHT',
      }),
    ).toBe('draft-41');

    await client.submitReview(reviewId, 'APPROVE', 'Looks good.');

    expect(fake.writes().map((call) => [call.method, call.path, call.body])).toEqual([
      [
        'POST',
        `${MR}/draft_notes`,
        {
          note: 'Early exit?',
          position: expect.objectContaining({ old_line: 3, new_line: 4, head_sha: HEAD2 }),
        },
      ],
      ['POST', `${MR}/approve`, { sha: HEAD2 }],
      ['POST', `${MR}/draft_notes`, { note: 'Looks good.' }],
      ['POST', `${MR}/draft_notes/bulk_publish`, {}],
    ]);
  });

  it('refuses to request changes, which GitLab’s API cannot do, before writing anything', async () => {
    const { client, fake } = gitlab();

    await expect(
      client.submitReview('MRR_7_12', 'REQUEST_CHANGES', 'Fix it'),
    ).rejects.toMatchObject({
      outcome: 'rejected',
    });
    expect(fake.writes()).toEqual([]);
  });

  it('replies to, resolves and reports threads', async () => {
    const { client, fake } = gitlab();

    fake
      .on('POST', `${MR}/discussions/abc123/notes`, {
        status: 201,
        data: note(120, 'rev', 'Thanks', at(8)),
      })
      .on('PUT', `${MR}/discussions/abc123`, { data: {} });

    expect(await client.replyToThread('MRD_7_12_abc123', 'Thanks')).toEqual({
      id: '120',
      url: `${WEB}#note_120`,
      pending: false,
    });

    await client.setThreadResolved('MRD_7_12_abc123', true);

    expect(fake.writes().at(-1)).toMatchObject({ method: 'PUT', body: { resolved: true } });
    expect(await client.reviewReceipt('MRR_7_12')).toMatchObject({
      state: 'PENDING',
      commitOid: HEAD2,
      comments: [{ body: 'Pending thought', path: 'src/app.ts', line: 2 }],
    });

    fake.on('GET', `${MR}/draft_notes`, { data: [] });
    expect(await client.reviewReceipt('MRR_7_12')).toBeNull();
  });

  it('asks existing reviewers again and adds new ones', async () => {
    const { client, fake } = gitlab();

    fake
      .on('POST', 'graphql', { data: { data: { mergeRequestReviewerRereview: { errors: [] } } } })
      .on('GET', 'users', { data: [{ id: 9, username: 'newbie' }] })
      .on('PUT', MR, { data: mergeRequest() });

    await client.requestReviews('MR_7_12', ['rev', 'newbie']);

    const [rereview, update] = fake.writes();

    expect(rereview.body).toMatchObject({
      variables: {
        input: { projectPath: 'acme/platform/web', iid: '12', userId: 'gid://gitlab/User/2' },
      },
    });
    expect(update).toMatchObject({ method: 'PUT', path: MR, body: { reviewer_ids: [2, 3, 9] } });
  });
});

describe('routing between GitHub and GitLab', () => {
  function fakeApi(login: string): GitHubApi {
    return { identity: vi.fn(async () => ({ login })) } as unknown as GitHubApi;
  }

  const githubAccount: CliAccount = {
    login: 'octo',
    forge: 'github',
    host: 'github.com',
    cliActive: true,
    ok: true,
  };
  const gitlabAccount: CliAccount = {
    login: VIEWER,
    forge: 'gitlab',
    host: HOST,
    cliActive: true,
    ok: true,
  };

  /** `token`: GitHub works through GH_TOKEN even when the CLI lists no stored sign-in. */
  function router(github: CliAccount[] | Error = [githubAccount], { token = false } = {}) {
    const signedIn = token || (Array.isArray(github) && github.length > 0);
    const githubApi = {
      identity: vi.fn(async () => {
        if (!signedIn) throw new GitHubError('Not signed in', null, 401, 'auth');

        return { login: 'octo' };
      }),
    } as unknown as GitHubApi;
    const gh = {
      list: vi.fn(async () => {
        if (github instanceof Error) throw github;

        return github;
      }),
      select: vi.fn(),
    };
    const glab = { list: vi.fn(async () => [gitlabAccount]) };
    const hosts: string[] = [];
    const forges = new ForgeRouter(githubApi, gh, glab, (host) => {
      hosts.push(host);

      return fakeApi(`rev@${host}`);
    });

    return { forges, gh, hosts };
  }

  it('sends requests to the selected account’s forge and host, or to the account work started as', async () => {
    const { forges, gh, hosts } = router();

    expect((await forges.identity()).login).toBe('octo');

    forges.select(VIEWER);

    expect((await forges.identity()).login).toBe(VIEWER);
    expect(hosts).toEqual([HOST]);
    // The GitHub CLI keeps its own selection while a GitLab account is in use.
    expect(gh.select).not.toHaveBeenCalled();
    expect((await forges.as('octo').identity()).login).toBe('octo');
  });

  it('lists both CLIs’ accounts, and either one alone when the other is missing', async () => {
    expect(await router().forges.list()).toEqual([githubAccount, gitlabAccount]);

    const missing = new GitHubError('gh not found', null, null, 'unavailable');

    expect(await router(missing).forges.list()).toEqual([gitlabAccount]);
  });

  it('uses the first GitLab account when the GitHub CLI has no sign-in or is not installed', async () => {
    const notInstalled = new GitHubError(
      'GitHub CLI unavailable: spawn gh ENOENT. Install gh and run gh auth login.',
      null,
      null,
      'unavailable',
    );

    expect((await router([]).forges.identity()).login).toBe(VIEWER);
    expect((await router(notInstalled).forges.identity()).login).toBe(VIEWER);

    // A GH_TOKEN with no stored sign-in still works, so GitHub stays the default.
    expect((await router([], { token: true }).forges.identity()).login).toBe('octo');

    // Any other failure is not taken as "no GitHub": GitHub stays the default.
    const flaky = new GitHubError('Could not list GitHub CLI accounts.', null, null, 'unavailable');

    expect((await router(flaky, { token: true }).forges.identity()).login).toBe('octo');
  });

  it('does not switch to GitLab for good while GitHub is only unreachable', async () => {
    let reachable = false;
    const github = {
      identity: vi.fn(async () => {
        if (!reachable) throw new GitHubError('GitHub request timed out.');

        return { login: 'octo' };
      }),
    } as unknown as GitHubApi;
    const forges = new ForgeRouter(
      github,
      { list: async () => [], select: vi.fn() },
      { list: async () => [gitlabAccount] },
      () => fakeApi(VIEWER),
    );

    await expect(forges.identity()).rejects.toThrow('timed out');

    reachable = true;
    expect((await forges.identity()).login).toBe('octo');
  });

  it('sends writes as the account the work was started as, whatever is selected', async () => {
    const github = { replyToThread: vi.fn(async () => ({ id: 'gh', url: '', pending: false })) };
    const gitlabReply = vi.fn(async () => ({ id: 'gl', url: '', pending: false }));
    const forges = new ForgeRouter(
      github as unknown as GitHubApi,
      { list: async () => [githubAccount], select: vi.fn() },
      { list: async () => [gitlabAccount] },
      () => ({ replyToThread: gitlabReply }) as unknown as GitHubApi,
    );

    forges.select('octo');
    await forges.as(VIEWER).replyToThread('MRD_7_12_abc123', 'Thanks');

    forges.select(VIEWER);
    await forges.as('octo').replyToThread('thread-1', 'Thanks');

    expect(gitlabReply).toHaveBeenCalledWith('MRD_7_12_abc123', 'Thanks');
    expect(github.replyToThread).toHaveBeenCalledWith('thread-1', 'Thanks');
  });
});

describe('adding a GitLab merge request by link', () => {
  function service(login: string, webUrl?: string) {
    const store = new Store(':memory:');
    const resolvePull = vi.fn(async () => null);
    const api = {
      identity: vi.fn(async () => ({ login, webUrl })),
      teams: vi.fn(async () => []),
      discover: vi.fn(async () => []),
      detect: vi.fn(async () => ({ results: [], budget: null })),
      resolvePull,
    } as unknown as GitHubApi;
    const accounts = { list: vi.fn(async () => []), select: vi.fn() };
    const sync = new SyncService(store, api, undefined, accounts);

    cleanups.push(() => store.close());

    return { sync, resolvePull };
  }

  it('removes the instance’s relative URL root and refuses links to other hosts', async () => {
    const { sync, resolvePull } = service('rev@example.com', 'https://example.com/gitlab/rev');

    await sync.sync();
    await expect(
      sync.track('rev@example.com', 'gitlab/team/app', 3, 'example.com'),
    ).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: expect.stringContaining('team/app!3'),
    });
    expect(resolvePull).toHaveBeenCalledWith('team/app', 3);

    await expect(sync.track('rev@example.com', 'team/app', 3, 'github.com')).rejects.toMatchObject({
      code: 'OTHER_HOST',
    });

    // Same host, another root: another GitLab.
    await expect(
      sync.track('rev@example.com', 'other/team/app', 3, 'example.com'),
    ).rejects.toMatchObject({ code: 'OTHER_HOST' });
  });

  it('refuses GitLab references while a GitHub account is in use', async () => {
    const { sync, resolvePull } = service('octo');

    await sync.sync();

    for (const [path, gitlab] of [
      ['group/sub/app', false],
      ['group/app', true],
    ] as const)
      await expect(sync.track('octo', path, 12, undefined, gitlab)).rejects.toMatchObject({
        code: 'OTHER_HOST',
      });

    expect(resolvePull).not.toHaveBeenCalled();
  });
});

describe('GitLab review submission', () => {
  const published = (extra: unknown[] = []) => [
    ...discussions(),
    {
      id: 'bb01',
      individual_note: true,
      notes: [note(201, 'rev', 'approved this merge request', at(20), { system: true })],
    },
    { id: 'bb02', individual_note: true, notes: [note(202, 'rev', 'Ship it.', seconds(20, 5))] },
    ...extra,
  ];

  it('recognises a published review after a lost response, and forgets it when discarded', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(20)));

    const { client, fake } = gitlab();

    fake
      .on('POST', `${MR}/approve`, { status: 201, data: {} })
      .on('POST', `${MR}/draft_notes`, { status: 201, data: { id: 50, note: 'Ship it.' } })
      // GitLab published the review, but the response was lost on the way back.
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 502, data: 'Bad gateway' });

    await expect(client.submitReview('MRR_7_12', 'APPROVE', 'Ship it.')).rejects.toMatchObject({
      outcome: 'unknown',
    });

    // GitLab published the drafts; the queue asks what happened to the pending review.
    fake.on('GET', `${MR}/draft_notes`, { data: [] }).on('GET', `${MR}/discussions`, {
      data: published(),
    });

    expect(await client.reviewReceipt('MRR_7_12')).toMatchObject({
      state: 'APPROVED',
      body: 'Ship it.',
      commitOid: HEAD2,
    });

    await client.deleteReview('MRR_7_12');
    expect(await client.reviewReceipt('MRR_7_12')).toBeNull();
    vi.useRealTimers();
  });

  it('publishes the summary and reviewer state with the drafts on GitLab 19.2', async () => {
    const { client, fake } = gitlab();
    let published = false;

    fake
      .on('GET', 'version', { data: { version: '19.2.1-ee' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, () => {
        published = true;

        return { status: 204, data: '' };
      })
      .on('GET', `${MR}/reviewers`, () => ({
        data: [{ user: users.rev, state: published ? 'requested_changes' : 'unreviewed' }],
      }));

    expect(await client.capabilities()).toEqual({ requestChanges: true });

    await client.submitReview('MRR_7_12', 'REQUEST_CHANGES', 'Please add a test.');

    expect(fake.writes().map((call) => [call.path, call.body])).toEqual([
      [
        `${MR}/draft_notes/bulk_publish`,
        { note: 'Please add a test.', reviewer_state: 'requested_changes' },
      ],
    ]);
  });

  it('reports a change request GitLab published without recording as unconfirmed', async () => {
    const { client, fake } = gitlab();

    fake
      .on('GET', 'version', { data: { version: '19.2.0' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' });

    await expect(client.submitReview('MRR_7_12', 'REQUEST_CHANGES', 'Fix')).rejects.toMatchObject({
      outcome: 'unknown',
      message: expect.stringContaining('did not record the change request'),
    });
  });

  it('cannot request changes before GitLab 19.2', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', 'version', { data: { version: '17.8.7' } });

    expect(await client.capabilities()).toEqual({ requestChanges: false });
    await expect(client.submitReview('MRR_7_12', 'REQUEST_CHANGES', 'Fix')).rejects.toMatchObject({
      outcome: 'rejected',
    });
    expect(fake.writes()).toEqual([]);
  });

  it('keeps comments and the approval on the commit the review started on', async () => {
    const { client, fake } = gitlab();

    await client.addPendingReview('MR_7_12', HEAD1);

    await expect(
      client.addReviewThread('MRR_7_12', { path: 'src/app.ts', body: 'x', line: 4 }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(client.submitReview('MRR_7_12', 'APPROVE', '')).rejects.toMatchObject({
      status: 409,
    });
    expect(fake.writes()).toEqual([]);
  });

  it('finds a summary saved before a failed publish, as GitLab lists it', async () => {
    const { client, fake } = gitlab();
    const nullPosition = {
      base_sha: null,
      start_sha: null,
      head_sha: null,
      old_path: null,
      new_path: null,
      position_type: 'text',
      old_line: null,
      new_line: null,
      line_range: null,
    };

    fake
      .on('GET', `${MR}/draft_notes`, {
        data: [{ id: 60, note: 'Summary', position: nullPosition }],
      })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' });

    await client.submitReview('MRR_7_12', 'COMMENT', 'Summary');

    expect(fake.writes().map((call) => call.path)).toEqual([`${MR}/draft_notes/bulk_publish`]);
  });

  it('reads before writing, so a failed read never follows a posted reply', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', MR, { status: 429, data: { message: 'slow down' } });

    await expect(client.replyToThread('MRD_7_12_abc123', 'Thanks')).rejects.toBeInstanceOf(
      GitHubError,
    );
    await expect(client.addConversationComment('MR_7_12', 'Hi')).rejects.toBeInstanceOf(
      GitHubError,
    );
    expect(fake.writes()).toEqual([]);
  });

  it('posts a range GitLab cannot place on its last line, saying which lines it covers', async () => {
    const { client, fake } = gitlab();
    let attempt = 0;

    fake.on('POST', `${MR}/discussions`, () =>
      ++attempt === 1
        ? { status: 400, data: { message: 'line_code is invalid' } }
        : { status: 201, data: { id: 'cc01', notes: [note(300, 'rev', 'x', at(9))] } },
    );

    await client.commentNow('MR_7_12', HEAD2, {
      path: 'src/app.ts',
      body: 'Both lines need a guard.',
      line: 4,
      startLine: 2,
      side: 'RIGHT',
    });

    const retry = fake.writes()[1].body as { body: string; position: Record<string, unknown> };

    expect(retry.body).toBe('_Lines 2–4:_\n\nBoth lines need a guard.');
    expect(retry.position.line_range).toBeUndefined();
    expect(retry.position).toMatchObject({ old_line: 3, new_line: 4 });
  });
});

describe('GitLab reviews, diffs and pagination', () => {
  it('does not count a conversation comment as a review', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', `${MR}/discussions`, {
      data: [
        {
          id: 'dd01',
          individual_note: true,
          notes: [note(400, 'rev', 'I’ll look tomorrow.', at(2))],
        },
      ],
    });

    const pr = await client.snapshot('MR_7_12', VIEWER, ['requested']);

    expect(pr.reviews).toEqual([]);
    expect(pr.reviewRequests.map((reviewer) => reviewer.login)).toContain('rev');
  });

  it('numbers expanded context on the old side, and ranges across changed lines', () => {
    const diff = parseDiff(APP_DIFF);

    expect(locate(diff, 'LEFT', 9)).toMatchObject({ kind: 'context', oldLine: 9, newLine: 10 });

    const range = commentPosition(
      { oldPath: 'src/app.ts', newPath: 'src/app.ts', diff: APP_DIFF },
      { base_sha: BASE, start_sha: START, head_sha: HEAD2 },
      { path: 'src/app.ts', body: '', line: 3, startLine: 2, side: 'RIGHT', startSide: 'LEFT' },
    ) as { line_range: { start: Record<string, unknown>; end: Record<string, unknown> } };

    expect(range.line_range.start).toMatchObject({ type: 'old', old_line: 2, new_line: null });
    expect(range.line_range.end).toMatchObject({ type: 'new', old_line: null, new_line: 3 });
  });

  it('follows GitLab’s next-page header', async () => {
    const fake = new FakeGitLab().on('GET', 'things', (request) =>
      request.path.includes('page=2')
        ? { data: [{ n: 2 }], headers: { 'content-type': 'application/json', 'x-next-page': '' } }
        : { data: [{ n: 1 }], headers: { 'content-type': 'application/json', 'x-next-page': '2' } },
    );

    expect(await paginate(fake, 'things?scope=all', 'list')).toEqual([{ n: 1 }, { n: 2 }]);
    expect(fake.calls.map((call) => call.path)).toEqual([
      'things?scope=all&per_page=100',
      'things?scope=all&per_page=100&page=2',
    ]);
  });

  it('refuses incomplete comparisons and reports diffs left out for size', async () => {
    const { client, fake } = gitlab();

    fake
      .on('GET', 'projects/acme%2Fplatform%2Fweb/repository/compare', {
        data: { commits: [], diffs: [], compare_timeout: true },
      })
      .on('GET', 'projects/acme%2Fplatform%2Fweb/repository/merge_base', { data: { id: HEAD1 } })
      .on('GET', 'projects/acme%2Fplatform%2Fweb/merge_requests/12/diffs', {
        data: [
          {
            diff: '',
            new_path: 'big.sql',
            old_path: 'big.sql',
            new_file: false,
            renamed_file: false,
            deleted_file: false,
            too_large: true,
          },
        ],
      });

    await expect(client.compare('acme/platform/web', HEAD1, HEAD2)).rejects.toMatchObject({
      outcome: 'unavailable',
    });
    expect(await client.pullFiles('acme/platform/web', 12)).toMatchObject([
      { path: 'big.sql', tooLarge: true, patch: undefined },
    ]);
  });
});

describe('credentials outside the GitLab client', () => {
  it('keeps GitLab tokens and glab sign-ins away from AI agents', async () => {
    const { agentEnvironment } = await import('@/ai/provider.js');
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    vi.stubEnv('GITLAB_TOKEN', 'test-gitlab-token');
    vi.stubEnv('GLAB_CLIENT_KEY', '/keys/client.pem');

    const env = agentEnvironment(mkdtempSync(join(tmpdir(), 'agent-')));

    expect(env.GITLAB_TOKEN).toBeUndefined();
    expect(env.GLAB_CLIENT_KEY).toBeUndefined();
    expect(env.GLAB_CONFIG_DIR).toMatch(/\.glab-empty$/);
    vi.unstubAllEnvs();
  });

  it('refuses to request changes on GitLab before anything is queued, unless it can', async () => {
    const { ReviewService } = await import('@/review/service.js');
    const status: { capabilities?: { requestChanges: boolean } } = {};
    const reviews = new ReviewService(
      // The named account's own capabilities, as its last sync read them.
      { status, store: {}, capabilitiesOf: () => status.capabilities } as unknown as SyncService,
      {} as GitHubApi,
      {} as never,
      { emit: () => undefined } as never,
    );

    expect(() => reviews.assertVerdictSupported(VIEWER, 'REQUEST_CHANGES')).toThrow(
      /cannot request changes/,
    );
    expect(() => reviews.assertVerdictSupported('octo', 'REQUEST_CHANGES')).not.toThrow();

    status.capabilities = { requestChanges: true };
    expect(() => reviews.assertVerdictSupported(VIEWER, 'REQUEST_CHANGES')).not.toThrow();
  });
});

describe('GitLab review follow-ups', () => {
  it('forgets a confirmed submission, so a later pending review is not mistaken for it', async () => {
    const { client, fake } = gitlab();

    fake.on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' });

    await client.submitReview('MRR_7_12', 'COMMENT', '');
    fake.on('GET', `${MR}/draft_notes`, { data: [] });

    expect(await client.reviewReceipt('MRR_7_12')).toBeNull();
  });

  it('saves the summary as a draft before GitLab 19.2, which ignores it when publishing', async () => {
    const { client, fake } = gitlab();

    fake
      .on('GET', 'version', { data: { version: '19.1.4' } })
      .on('GET', `${MR}/draft_notes`, { data: [] })
      .on('POST', `${MR}/draft_notes`, { status: 201, data: { id: 80, note: 'Looks fine.' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' });

    await client.submitReview('MRR_7_12', 'COMMENT', 'Looks fine.');

    expect(fake.writes().map((call) => [call.path, call.body])).toEqual([
      [`${MR}/draft_notes`, { note: 'Looks fine.' }],
      [`${MR}/draft_notes/bulk_publish`, {}],
    ]);
  });

  it('checks rather than repeats a publish GitLab may have applied in part', async () => {
    const { client, fake } = gitlab();

    // GitLab 19.2 publishes the drafts first, then can reject the summary.
    fake
      .on('GET', 'version', { data: { version: '19.2.0' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, {
        status: 422,
        data: { message: 'Note is too long' },
      });

    await expect(client.submitReview('MRR_7_12', 'COMMENT', 'Summary')).rejects.toMatchObject({
      outcome: 'unknown',
    });
  });

  it('refuses to publish comments left on an older commit with an approval', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', `${MR}/draft_notes`, {
      data: [
        { id: 1, note: 'new', position: { head_sha: HEAD2, new_path: 'src/app.ts', new_line: 2 } },
        { id: 2, note: 'old', position: { head_sha: HEAD1, new_path: 'src/app.ts', new_line: 2 } },
      ],
    });

    await expect(client.submitReview('MRR_7_12', 'APPROVE', '')).rejects.toMatchObject({
      status: 409,
    });
    expect(await client.reviewReceipt('MRR_7_12')).toMatchObject({ commitOid: HEAD1 });
    expect(fake.writes()).toEqual([]);
  });

  it('recognises only notes posted after the submission started', async () => {
    const { client, fake } = gitlab();

    // An identical comment posted just before is not the submission's summary.
    fake
      .on('GET', `${MR}/notes`, { data: [note(700, 'rev', 'Same words.', at(9))] })
      .on('POST', `${MR}/draft_notes`, { status: 201, data: { id: 81, note: 'Same words.' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 502, data: 'Bad gateway' });

    await expect(client.submitReview('MRR_7_12', 'COMMENT', 'Same words.')).rejects.toBeDefined();

    fake.on('GET', `${MR}/draft_notes`, { data: [] }).on('GET', `${MR}/discussions`, {
      data: [
        ...discussions(),
        { id: 'gg01', individual_note: true, notes: [note(700, 'rev', 'Same words.', at(9))] },
      ],
    });

    expect(await client.reviewReceipt('MRR_7_12')).toBeNull();
  });

  it('treats your own summary-only review as answering your review request', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(30)));

    const { client, fake } = gitlab();

    fake
      .on('POST', `${MR}/draft_notes`, { status: 201, data: { id: 70, note: 'Nothing to add.' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' });
    await client.as(VIEWER).submitReview('MRR_7_12', 'COMMENT', 'Nothing to add.');
    fake.on('GET', `${MR}/draft_notes`, { data: [] }).on('GET', `${MR}/discussions`, {
      data: [
        ...discussions(),
        { id: 'ee01', individual_note: true, notes: [note(500, 'rev', 'Nothing to add.', at(30))] },
      ],
    });

    const pr = await client.snapshot('MR_7_12', VIEWER, ['requested']);

    expect(pr.reviews.at(-1)).toMatchObject({ state: 'COMMENTED', body: 'Nothing to add.' });
    expect(pr.reviewRequests.map((reviewer) => reviewer.login)).not.toContain('rev');
    vi.useRealTimers();
  });

  it('shows a thread GitLab moved to the new head as current, and one it left behind as outdated', async () => {
    const { client, fake } = gitlab();
    const thread = (head: string) => ({
      id: 'ff01',
      individual_note: false,
      notes: [
        note(600, 'rev', 'Still here?', at(2), {
          type: 'DiffNote',
          position: position(head, 2),
          resolvable: true,
        }),
      ],
    });

    fake.on('GET', `${MR}/discussions`, { data: [thread(HEAD2)] });
    expect((await client.snapshot('MR_7_12', VIEWER, [])).threads[0].isOutdated).toBe(false);

    fake.on('GET', `${MR}/discussions`, { data: [thread(HEAD1)] });
    expect((await client.snapshot('MR_7_12', VIEWER, [])).threads[0].isOutdated).toBe(true);
  });
});

describe('GitLab review recovery, round three', () => {
  it('reports a published change request it could not check as unconfirmed, not as failed', async () => {
    const { client, fake } = gitlab();

    fake
      .on('GET', 'version', { data: { version: '19.2.0' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 204, data: '' })
      .on('GET', `${MR}/reviewers`, { status: 503, data: 'Unavailable' });

    await expect(client.submitReview('MRR_7_12', 'REQUEST_CHANGES', 'Fix')).rejects.toMatchObject({
      outcome: 'unknown',
      message: expect.stringContaining('could not be checked'),
    });
  });

  it('recognises a published review that a reply just before it joined', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(at(40)));

    const { client, fake } = gitlab();

    fake
      .on('GET', `${MR}/notes`, { data: [note(800, 'rev', 'On it.', seconds(39, 30))] })
      .on('POST', `${MR}/approve`, { status: 201, data: {} })
      .on('POST', `${MR}/draft_notes`, { status: 201, data: { id: 90, note: 'Ship it.' } })
      .on('POST', `${MR}/draft_notes/bulk_publish`, { status: 502, data: 'Bad gateway' });

    await expect(client.submitReview('MRR_7_12', 'APPROVE', 'Ship it.')).rejects.toBeDefined();

    // The reply (note 800) came half a minute before the review GitLab published.
    fake.on('GET', `${MR}/draft_notes`, { data: [] }).on('GET', `${MR}/discussions`, {
      data: [
        ...discussions(),
        {
          id: 'hh01',
          individual_note: false,
          notes: [
            note(799, 'dev', 'Is the loop bounded?', at(39), {
              type: 'DiffNote',
              position: position(HEAD2, 2),
              resolvable: true,
            }),
            note(800, 'rev', 'On it.', seconds(39, 30), {
              type: 'DiffNote',
              position: position(HEAD2, 2),
              resolvable: true,
            }),
          ],
        },
        {
          id: 'hh02',
          individual_note: true,
          notes: [note(801, 'rev', 'approved this merge request', at(40), { system: true })],
        },
        { id: 'hh03', individual_note: true, notes: [note(802, 'rev', 'Ship it.', at(40))] },
      ],
    });

    expect(await client.reviewReceipt('MRR_7_12')).toMatchObject({
      state: 'APPROVED',
      body: 'Ship it.',
    });
    vi.useRealTimers();
  });

  it('accepts glab’s username field for a host', async () => {
    const accounts = new GlabAccounts(async () => ({
      code: 0,
      stdout: JSON.stringify({
        hosts: [{ host: 'git.example.com', state: 'success', username: 'rev' }],
      }),
      stderr: '',
    }));

    expect((await accounts.list()).map((account) => account.login)).toEqual([
      'rev@git.example.com',
    ]);
  });

  it('keeps diffs of mirrored PRs with the same commits apart', async () => {
    const { DiffService } = await import('@/diff/service.js');
    const pullFiles = vi.fn(async () => []);
    const diffs = new DiffService({ pullFiles } as unknown as GitHubApi);
    const pr = { repository: 'acme/api', number: 1, baseOid: BASE, headOid: HEAD2, files: [] };
    const github = await diffs.manifest(
      { ...pr, id: 'PR_kwDOA', url: 'https://github.com/acme/api/pull/1' } as never,
      'full',
      null,
    );
    const gitlab = await diffs.manifest(
      { ...pr, id: 'MR_7_1', url: 'https://git.example.com/acme/api/-/merge_requests/1' } as never,
      'full',
      null,
    );

    expect([github.prId, gitlab.prId]).toEqual(['PR_kwDOA', 'MR_7_1']);
    expect(pullFiles).toHaveBeenCalledTimes(2);
  });
});

describe('GitLab safety, round three', () => {
  it('escapes quick actions in automatic posts only where the forge runs them', async () => {
    const { automaticPostBody } = await import('@/ai/post-findings.js');
    const body = 'Looks fine.\n/merge';

    expect(automaticPostBody(VIEWER, body)).not.toContain('\n/merge');
    expect(automaticPostBody('octo', body)).toBe(body);
  });

  it('keeps generated text from running GitLab quick actions', async () => {
    const { withoutQuickActions } = await import('@/gitlab/quick-actions.js');

    expect(
      withoutQuickActions('Looks fine.\n/merge\n  /close now\n```\n/approve\n```\nok /x'),
    ).toBe('Looks fine.\n&#47;merge\n  &#47;close now\n```\n/approve\n```\nok /x');
  });

  it('refuses a read for an account glab is not signed in as, and allows its own', async () => {
    const { client, fake } = gitlab();

    await expect(client.verifyAccount(VIEWER)).resolves.toBeUndefined();

    fake.on('GET', 'user', { data: users.ana });

    await expect(client.verifyAccount(VIEWER)).rejects.toBeInstanceOf(AccountUnavailable);
    await expect(client.verifyAccount(VIEWER)).rejects.toMatchObject({
      code: 'ACCOUNT_UNAVAILABLE',
      signedInAs: `ana@${HOST}`,
    });
  });

  it('checks glab’s sign-in without changing whose local state other reads use', async () => {
    const { client, fake } = gitlab();

    await client.identity();

    // A check that finds someone else refuses, and leaves the last identity read as it was.
    fake.on('GET', 'user', { data: users.ana });
    await expect(client.verifyAccount(VIEWER)).rejects.toBeInstanceOf(AccountUnavailable);
    fake.on('GET', 'user', { data: users.rev });

    // So a mark kept outside any account's work is still rev's, as is a read for rev.
    await client.setFileViewed('MR_7_12', 'src/app.ts', true);

    const pr = await client.snapshot('MR_7_12', VIEWER, []);

    expect(pr.files.find((file) => file.path === 'src/app.ts')?.viewerViewedState).toBe('VIEWED');
  });

  it('refuses to write when glab is signed in as someone else than the work runs as', async () => {
    const { client, fake } = gitlab();

    fake.on('GET', 'user', { data: users.ana });

    await expect(
      client.as(VIEWER).replyToThread('MRD_7_12_abc123', 'Thanks'),
    ).rejects.toMatchObject({ status: 409, outcome: 'rejected' });
    expect(fake.writes()).toEqual([]);
  });

  it('treats a signed-out GitHub CLI as no GitHub sign-in', async () => {
    const { GhCli } = await import('@/github/transport.js');
    const { GhCredentials } = await import('@/github/credentials.js');
    const cli = new GhCli(1000, new GhCredentials());
    const spawn = vi
      .spyOn(cli as unknown as { spawn: () => Promise<unknown> }, 'spawn')
      .mockResolvedValue({
        code: 4,
        stdout: '',
        stderr: 'To get started with GitHub CLI, please run:  gh auth login',
        timedOut: false,
      });

    await expect(cli.request({ path: 'user' })).rejects.toMatchObject({ outcome: 'auth' });
    expect(spawn).toHaveBeenCalled();
  });
});
