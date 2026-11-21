import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AiRun } from '@review-desk/shared/ai';
import { FixtureProvider } from '@/ai/fixture.js';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { draftVersionsOf } from '@/db/versions.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

const headers = {
  host: '127.0.0.1:4317',
  'x-review-desk': '1',
  'x-review-desk-session': 'test-session',
};

/** The demo app synced as `you`, with demo agents. */
async function demo() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus(), fixture);
  const root = mkdtempSync(join(tmpdir(), 'review-desk-ai-fence-'));
  const providers = { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') };

  providers.codex.delayMs = 5;
  providers.claude.delayMs = 5;
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();

  const app = await createApp(service, {
    sessionToken: 'test-session',
    fixture,
    bootId: 'boot',
    aiProviders: providers,
    aiWorkRoot: root,
  });

  cleanups.push(() => app.close());

  const pr = service.listFor('you').items.find((item) => item.number === 1839)!;
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    method === 'GET'
      ? app.inject({ method, url, headers })
      : app.inject({
          method,
          url,
          headers: { ...headers, 'content-type': 'application/json' },
          payload: (payload ?? {}) as never,
        });
  const runs = async () =>
    (await call('GET', `/api/accounts/you/pulls/${pr.id}/ai`)).json().runs as AiRun[];
  const finished = async (id: string) => {
    await vi.waitFor(
      async () =>
        expect((await runs()).find((run) => run.id === id)?.status).toMatch(/done|failed/),
      { timeout: 5_000 },
    );

    return (await runs()).find((run) => run.id === id)!;
  };
  const start = (fields: Record<string, unknown>) =>
    call('POST', `/api/accounts/you/pulls/${pr.id}/ai`, { provider: 'codex', ...fields });
  const revision = () => draftVersionsOf(store, 'you', pr.id).revision;
  const save = (body: string) => call('PUT', `/api/accounts/you/pulls/${pr.id}/draft`, { body });

  return { store, providers, pr, call, runs, finished, start, revision, save };
}

describe('AI starts under their guard', () => {
  it('answer a retried start with the run it started, and refuse one on a draft that moved on', async () => {
    const { start, finished, revision, save, runs } = await demo();
    const request = { task: 'brief', attemptId: randomUUID(), baseRevision: revision() };
    const first = await start(request);

    expect(first.statusCode).toBe(200);
    expect(first.json().attempt).toMatchObject({ id: request.attemptId, state: 'committed' });

    // Its response was lost: the same request again answers with the same run.
    expect((await start(request)).json()).toEqual(first.json());

    // Finished, so a forced start below creates a run rather than joining this one.
    await finished(first.json().id);

    const seen = revision();

    await save('Changed since');

    const before = (await runs()).length;
    const stale = await start({
      task: 'brief',
      attemptId: randomUUID(),
      baseRevision: seen,
      force: true,
    });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('DRAFT_REVISION_CONFLICT');
    expect((await runs()).length).toBe(before);
  });

  it('answer two starts that joined one run with that run, after it finished and the draft changed', async () => {
    const { providers, start, finished, revision, save } = await demo();

    // Slow enough that the second attempt joins the run while it is still live.
    providers.codex.delayMs = 400;

    const first = { task: 'brief', attemptId: randomUUID(), baseRevision: revision() };
    const second = { task: 'brief', attemptId: randomUUID(), baseRevision: revision() };
    const a = await start(first);
    // Joins the run the first started, cached or running.
    const b = await start(second);

    expect(b.json().id).toBe(a.json().id);
    expect(b.json().status).toMatch(/queued|running/);

    await finished(a.json().id);
    await save('Later');

    // Each attempt is its own record of the run it joined, answered as it was when it joined,
    // whatever has happened since.
    expect((await start(first)).json()).toEqual(a.json());
    expect((await start(second)).json()).toEqual(b.json());
  });

  it('refuse a start on a draft that moved on, even one that would join a cached run', async () => {
    const { start, finished, revision, save, runs } = await demo();
    const cached = await finished((await start({ task: 'brief' })).json().id);
    const seen = revision();

    await save('Changed since');

    const before = (await runs()).length;
    // Not forced: it would join the cached run, were its base current.
    const stale = await start({ task: 'brief', attemptId: randomUUID(), baseRevision: seen });

    expect(stale.statusCode).toBe(409);
    expect(stale.json().code).toBe('DRAFT_REVISION_CONFLICT');
    expect((await runs()).length).toBe(before);
    expect(cached.status).toBe('done');
  });
});

describe('AI draft writes under their guard', () => {
  it('name their PR whenever they carry an id', async () => {
    const { call } = await demo();
    const unnamed = await call('POST', '/api/accounts/you/ai/runs/some-run/summary', {
      writeId: randomUUID(),
    });

    expect(unnamed.statusCode).toBe(400);
  });

  it("are claimed under the PR they name: a refusal for an unknown run is found by that PR's lookup", async () => {
    const { pr, call, start, finished } = await demo();
    const writeId = randomUUID();
    const missing = await call('POST', '/api/accounts/you/ai/runs/no-such-run/summary', {
      writeId,
      prId: pr.id,
      baseRevision: 0,
    });

    expect(missing.statusCode).toBe(404);

    // Its answer was lost: the PR's lookup finds the refusal, never "not arrived".
    const lookup = await call(
      'GET',
      `/api/accounts/you/pulls/${pr.id}/draft/attempts/${writeId}?base=0`,
    );

    expect(lookup.json().attempt).toMatchObject({ id: writeId, state: 'refused' });

    // A run of another PR is refused for this one.
    const other = await finished((await start({ task: 'draft_summary' })).json().id);
    const elsewhere = await call('POST', `/api/accounts/you/ai/runs/${other.id}/summary`, {
      writeId: randomUUID(),
      prId: 'PR_elsewhere',
    });

    expect(elsewhere.statusCode).toBe(404);
  });

  it('are refused on a draft that moved on, and answered from their claim when retried', async () => {
    const { pr, call, start, finished, revision, save } = await demo();
    const suggested = await finished((await start({ task: 'draft_comments' })).json().id);
    const reviewed = await finished((await start({ task: 'full_review' })).json().id);
    const summarised = await finished((await start({ task: 'draft_summary' })).json().id);
    const run = (id: string, action: string) => `/api/accounts/you/ai/runs/${id}/${action}`;

    const seen = revision();

    await save('Changed since');

    for (const [url, body] of [
      [run(suggested.id, 'accept'), { index: 0 }],
      [run(reviewed.id, 'draft'), { indices: [] }],
      [run(summarised.id, 'summary'), {}],
    ] as const) {
      const stale = await call('POST', url, { ...body, baseRevision: seen });

      expect(stale.statusCode, url).toBe(409);
      expect(stale.json().code, url).toBe('DRAFT_REVISION_CONFLICT');
    }

    // Nothing of them was written.
    const draft = (await call('GET', `/api/accounts/you/pulls/${pr.id}/draft`)).json();

    expect(draft.body).toBe('Changed since');
    expect(draft.comments).toEqual([]);

    // On the draft as it is, with an id: committed, and a retry gets the same answer.
    const request = { writeId: randomUUID(), prId: pr.id, baseRevision: revision() };
    const applied = await call('POST', run(summarised.id, 'summary'), request);

    expect(applied.statusCode).toBe(200);
    expect(applied.json().attempt).toMatchObject({ id: request.writeId, state: 'committed' });

    await save('After applying');

    expect((await call('POST', run(summarised.id, 'summary'), request)).json()).toEqual(
      applied.json(),
    );
  });
});
