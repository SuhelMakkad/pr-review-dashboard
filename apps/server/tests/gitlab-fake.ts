/**
 * A GitLab for tests, answering from a table of handlers, with one merge request and the data
 * around it. Shared by the GitLab tests and the forge conformance suite.
 */
import { Store } from '@/db/store.js';
import { GitLab } from '@/gitlab/read.js';
import type { GitLabRequest, GitLabTransport } from '@/gitlab/transport.js';

export const HOST = 'gitlab.example.com:8443';
export const VIEWER = `rev@${HOST}`;
export const BASE = 'b'.repeat(40);
export const START = 's'.repeat(40).replace(/s/g, 'c');
export const HEAD1 = '1'.repeat(40);
export const HEAD2 = '2'.repeat(40);
export const HEAD3 = '3'.repeat(40);
export const WEB = `https://${HOST}/acme/platform/web/-/merge_requests/12`;

export const at = (minutes: number) => new Date(Date.UTC(2026, 10, 10, 9, minutes)).toISOString();
export const seconds = (minutes: number, extra: number) =>
  new Date(Date.UTC(2026, 10, 10, 9, minutes, extra)).toISOString();

export const users = {
  dev: { id: 1, username: 'dev', avatar_url: null },
  rev: { id: 2, username: 'rev', avatar_url: null },
  ana: { id: 3, username: 'ana', avatar_url: null },
};

export const APP_DIFF = '@@ -1,3 +1,4 @@\n line1\n-old2\n+new2\n+new3\n line3\n';

export function note(
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

export function mergeRequest(overrides: Record<string, unknown> = {}) {
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

export const position = (head: string, newLine: number | null, oldLine: number | null = null) => ({
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

export function discussions() {
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

export interface Reply {
  status?: number;
  data?: unknown;
  headers?: Record<string, string>;
}

/** A GitLab that answers from a table of `METHOD path` handlers (the query string is ignored). */
export class FakeGitLab implements GitLabTransport {
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

export const MR = 'projects/7/merge_requests/12';
export const MR_BY_PATH = 'projects/acme%2Fplatform%2Fweb/merge_requests/12';

export function gitlab(overrides: { mr?: Record<string, unknown>; diffs?: unknown[] } = {}) {
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
  const store = new Store(':memory:');

  return { fake, client: new GitLab(fake, store.settings.forgeLocal), store };
}
