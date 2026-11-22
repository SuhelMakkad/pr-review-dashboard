import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FixtureProvider } from '@/ai/fixture.js';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { textPatch } from '@/diff/patch.js';
import { PatchAborted, PatchPool } from '@/diff/patch-pool.js';
import { DiffService } from '@/diff/service.js';
import { EventBus } from '@/events.js';
import { ForgeError } from '@/forge/port.js';
import { ReviewError } from '@/review/errors.js';
import { SyncService } from '@/sync/service.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  vi.restoreAllMocks();
});

/** A promise held open until `open()`: a read that has started and not yet answered. */
function gate() {
  let open = () => {};
  const opened = new Promise<void>((resolve) => (open = resolve));

  return { opened, open };
}

/** The demo, synced; PR 2041 was force-pushed since your review, so its view is rebased. */
async function demo() {
  const store = new Store(':memory:');
  const github = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, github, new EventBus(), github);

  cleanups.push(() => store.close());
  cleanups.push(() => service.stop());
  await service.sync();

  const item = service.listFor('you').items.find((entry) => entry.number === 2041)!;
  const detail = service.detailFor('you', item.id)!;
  const reviewOid = detail.item.latestReview!.commitOid;

  return { store, github, service, detail, reviewOid };
}

/** The forge's text reads, each held until the gate opens, and counted. */
function holdBlobs(github: FixtureGitHub) {
  const held = gate();
  const read = github.blobs.bind(github);
  const blobs = vi.spyOn(github, 'blobs').mockImplementation(async (...args) => {
    await held.opened;

    return read(...args);
  });

  return { blobs, open: held.open };
}

/** A pool whose patches run until their signal stops them; the first `fail` fail at once. */
function heldPatches(fail = 0) {
  const stopped: string[] = [];
  let calls = 0;
  const patches = {
    size: 2,
    patch: (_before: string, after: string, signal?: AbortSignal) => {
      calls++;

      if (calls <= fail) return Promise.reject(new Error('The worker crashed.'));

      return new Promise((_resolve, reject) =>
        signal!.addEventListener('abort', () => {
          stopped.push(after);
          reject(new PatchAborted());
        }),
      );
    },
  } as unknown as PatchPool;

  return { patches, stopped, calls: () => calls };
}

const pool = () => {
  const patches = new PatchPool({ size: 2 });

  cleanups.push(() => patches.close());

  return patches;
};

describe('rebased interdiffs through the patch pool', () => {
  it('builds the same manifest as patching in place', async () => {
    const { github, detail, reviewOid } = await demo();
    const inPlace = await new DiffService(github).manifest(
      detail.snapshot,
      'since-review',
      reviewOid,
    );
    const pooled = await new DiffService(github, pool()).manifest(
      detail.snapshot,
      'since-review',
      reviewOid,
    );

    expect(pooled.kind).toBe('rebased');
    expect(pooled).toEqual(inPlace);
  });

  it('stops the build’s other patches when one fails, and fails with that one’s error', async () => {
    const { github, detail, reviewOid } = await demo();
    const held = heldPatches(1);
    const diffs = new DiffService(github, held.patches);

    await expect(diffs.manifest(detail.snapshot, 'since-review', reviewOid)).rejects.toThrow(
      'The worker crashed.',
    );
    expect(held.calls()).toBeGreaterThan(1);
    expect(held.stopped).toHaveLength(held.calls() - 1);
  });

  it('stops its patches when its caller stops waiting while they run', async () => {
    const { github, detail, reviewOid } = await demo();
    const held = heldPatches();
    const controller = new AbortController();
    const build = new DiffService(github, held.patches).manifest(
      detail.snapshot,
      'since-review',
      reviewOid,
      null,
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(held.calls()).toBeGreaterThan(0));
    controller.abort();

    await expect(build).rejects.toBeInstanceOf(PatchAborted);
    expect(held.stopped).toHaveLength(held.calls());
  });

  it('answers a closed pool as the server shutting down', async () => {
    const { github, detail, reviewOid } = await demo();
    const patches = pool();

    await patches.close();

    await expect(
      new DiffService(github, patches).manifest(detail.snapshot, 'since-review', reviewOid),
    ).rejects.toMatchObject({ code: 'SHUTTING_DOWN', status: 503 });
  });

  it('has at most the pool’s size of patches outstanding per build', async () => {
    const { github, detail, reviewOid } = await demo();
    const taken: string[] = [];
    let outstanding = 0;
    let most = 0;
    const counting = {
      size: 2,
      patch: async (before: string, after: string) => {
        taken.push(after);
        most = Math.max(most, ++outstanding);
        await new Promise((resolve) => setTimeout(resolve, 5));
        outstanding--;

        return textPatch(before, after);
      },
    } as unknown as PatchPool;
    const inPlace = await new DiffService(github).manifest(
      detail.snapshot,
      'since-review',
      reviewOid,
    );
    const counted = await new DiffService(github, counting).manifest(
      detail.snapshot,
      'since-review',
      reviewOid,
    );

    // Each file has its own patch, whatever order they finished in.
    expect(counted).toEqual(inPlace);
    expect(taken.length).toBeGreaterThan(2);
    expect(most).toBe(2);
  });

  it('admits two rebased builds at once, and the third once one finishes', async () => {
    const { github, detail, reviewOid } = await demo();
    const { blobs, open } = holdBlobs(github);
    const diffs = new DiffService(github, pool());
    const builds = [1, 2, 3].map(() => diffs.manifest(detail.snapshot, 'since-review', reviewOid));

    await vi.waitFor(() => expect(blobs).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(blobs).toHaveBeenCalledTimes(2);

    open();

    const [first, ...rest] = await Promise.all(builds);

    expect(blobs).toHaveBeenCalledTimes(3);
    for (const manifest of rest) expect(manifest).toEqual(first);
  });

  it('publishes nothing for a caller that stopped waiting, and lets the next build finish', async () => {
    const { github, detail, reviewOid } = await demo();
    const { blobs, open } = holdBlobs(github);
    const diffs = new DiffService(github, pool());
    const controller = new AbortController();
    const gone = diffs.manifest(
      detail.snapshot,
      'since-review',
      reviewOid,
      null,
      undefined,
      controller.signal,
    );

    await vi.waitFor(() => expect(blobs).toHaveBeenCalledTimes(1));
    controller.abort();
    open();

    await expect(gone).rejects.toBeInstanceOf(PatchAborted);

    // Not cached: the next caller reads its texts again, and gets its manifest.
    expect((await diffs.manifest(detail.snapshot, 'since-review', reviewOid)).kind).toBe('rebased');
    expect(blobs).toHaveBeenCalledTimes(2);
  });

  it('on close, refuses a build waiting for a place, and one whose texts arrive after reads nothing more', async () => {
    const { github, detail, reviewOid } = await demo();
    const { blobs, open } = holdBlobs(github);
    const diffs = new DiffService(github, pool());
    const outcomes = [1, 2, 3].map((index) =>
      diffs
        .manifest(detail.snapshot, 'since-review', reviewOid)
        .then(() => `built ${index}`)
        .catch((error: unknown) => error),
    );

    await vi.waitFor(() => expect(blobs).toHaveBeenCalledTimes(2));

    const closed = diffs.close();
    const compare = vi.spyOn(github, 'compare');
    const files = vi.spyOn(github, 'pullFiles');

    // The third never had a place, so it read nothing.
    expect(await outcomes[2]).toMatchObject({ code: 'SHUTTING_DOWN', status: 503 });

    open();
    await closed;

    for (const outcome of await Promise.all(outcomes)) expect(outcome).toBeInstanceOf(ReviewError);

    expect(blobs).toHaveBeenCalledTimes(2);
    expect(compare).not.toHaveBeenCalled();
    expect(files).not.toHaveBeenCalled();
    await expect(diffs.manifest(detail.snapshot, 'full', null)).rejects.toMatchObject({
      code: 'SHUTTING_DOWN',
    });
  });

  it('skips the account check for a build stopped by its caller or by shutdown', async () => {
    const { github, detail, reviewOid } = await demo();
    const verifyAccount = vi.fn(async () => undefined);

    Object.assign(github, { verifyAccount, traits: { ...github.traits, checksAccount: true } });

    for (const stop of ['caller', 'shutdown'] as const) {
      const { blobs, open } = holdBlobs(github);
      const diffs = new DiffService(github, pool());
      const controller = new AbortController();
      const build = diffs
        .manifest(detail.snapshot, 'since-review', reviewOid, 'you', undefined, controller.signal)
        .catch((error: unknown) => error);

      await vi.waitFor(() => expect(blobs).toHaveBeenCalled());

      // Checked once before the build read anything.
      expect(verifyAccount).toHaveBeenCalledTimes(1);

      const closed = stop === 'caller' ? (controller.abort(), null) : diffs.close();

      open();

      expect(await build).toBeInstanceOf(stop === 'caller' ? PatchAborted : ReviewError);
      await closed;
      expect(verifyAccount).toHaveBeenCalledTimes(1);

      // Once closed, a build is refused before it asks who the account is.
      if (stop === 'shutdown') {
        await expect(
          diffs.manifest(detail.snapshot, 'since-review', reviewOid, 'you'),
        ).rejects.toMatchObject({ code: 'SHUTTING_DOWN' });
        expect(verifyAccount).toHaveBeenCalledTimes(1);
      }

      verifyAccount.mockClear();
      vi.mocked(github.blobs).mockRestore();
    }
  });

  it('checks the account again only for a forge’s failure, and never once closed', async () => {
    const { github, detail, reviewOid } = await demo();
    const verifyAccount = vi.fn(async () => undefined);
    const limited = () => new ForgeError('Rate limited.', null, 429, 'rate_limit');

    Object.assign(github, { verifyAccount, traits: { ...github.traits, checksAccount: true } });

    // A full diff's read answered after close, then one failing late: neither checks again, and
    // each answers as shutting down.
    for (const late of ['answered', 'failed'] as const) {
      const held = gate();
      const read = github.pullFiles.bind(github);

      vi.spyOn(github, 'pullFiles').mockImplementationOnce(async (...args) => {
        await held.opened;

        if (late === 'failed') throw limited();

        return read(...args);
      });

      const diffs = new DiffService(github, pool());
      const build = diffs.manifest(detail.snapshot, 'full', null, 'you').catch((error) => error);

      await vi.waitFor(() => expect(github.pullFiles).toHaveBeenCalled());

      const closed = diffs.close();

      held.open();

      expect(await build).toMatchObject({ code: 'SHUTTING_DOWN' });
      await closed;
      expect(verifyAccount).toHaveBeenCalledTimes(1);

      verifyAccount.mockClear();
      vi.mocked(github.pullFiles).mockRestore();
    }

    // A pinned listing that cannot be had once closed falls back to no other read.
    const pinned = gate();

    const pinnedFiles = vi.fn(async () => {
      await pinned.opened;

      return null;
    });

    Object.assign(github, {
      traits: { ...github.traits, checksAccount: true, pinnedFiles: true },
      pinnedFiles,
    });

    const files = vi.spyOn(github, 'pullFiles');
    const diffs = new DiffService(github, pool());
    const listed = diffs.manifest(detail.snapshot, 'full', null, 'you').catch((error) => error);

    await vi.waitFor(() => expect(pinnedFiles).toHaveBeenCalled());

    const closed = diffs.close();

    pinned.open();

    expect(await listed).toMatchObject({ code: 'SHUTTING_DOWN' });
    await closed;
    expect(files).not.toHaveBeenCalled();

    files.mockRestore();
    verifyAccount.mockClear();
    Object.assign(github, { traits: { ...github.traits, pinnedFiles: false } });

    // A crashed patch is not the forge's: no second check.
    const crashed = new DiffService(github, heldPatches(1).patches);

    await expect(
      crashed.manifest(detail.snapshot, 'since-review', reviewOid, 'you'),
    ).rejects.toThrow('The worker crashed.');
    expect(verifyAccount).toHaveBeenCalledTimes(1);
  });
});

describe('the app’s diffs through the patch pool', () => {
  const port = 4395;
  const headers = {
    'x-review-desk': '1',
    'x-review-desk-session': 'test-session',
  };

  async function app() {
    const { github, service, detail } = await demo();
    const root = mkdtempSync(join(tmpdir(), 'review-desk-diff-pool-'));
    const instance = await createApp(service, {
      sessionToken: 'test-session',
      ports: [port],
      aiProviders: { codex: new FixtureProvider('codex'), claude: new FixtureProvider('claude') },
      aiWorkRoot: root,
    });

    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => instance.close());
    await instance.listen({ host: '127.0.0.1', port });

    const url = `http://127.0.0.1:${port}/api/accounts/you/pulls/${detail.item.id}`;

    return { github, instance, url };
  }

  it('stops a build when its request disconnects, and serves the next request', async () => {
    const { github, url } = await app();
    const { blobs, open } = holdBlobs(github);
    const patched = vi.spyOn(PatchPool.prototype, 'patch');
    const manifest = vi.spyOn(DiffService.prototype, 'manifest');
    const controller = new AbortController();
    const gone = fetch(`${url}/diff?mode=since-review`, {
      headers,
      signal: controller.signal,
    }).catch((error: unknown) => error);

    await vi.waitFor(() => expect(blobs).toHaveBeenCalledTimes(1));
    controller.abort();
    expect(await gone).toBeInstanceOf(Error);

    // The build is told once the server sees the request go.
    const signal = manifest.mock.calls[0]![5];

    await vi.waitFor(() => expect(signal?.aborted).toBe(true));

    // Its texts arrive after: it patches nothing, and keeps nothing.
    open();
    await expect(manifest.mock.results[0]!.value).rejects.toBeInstanceOf(PatchAborted);
    expect(patched).not.toHaveBeenCalled();

    // So the next one reads again.
    const next = await fetch(`${url}/diff?mode=since-review`, { headers });

    expect(next.status).toBe(200);
    expect(((await next.json()) as { kind: string }).kind).toBe('rebased');
    expect(blobs).toHaveBeenCalledTimes(2);
    // Patched on the app's worker threads.
    expect(patched).toHaveBeenCalled();
  });

  it('refuses an AI start waiting for a place when the app closes, before it reads any text', async () => {
    const { github, instance, url } = await app();
    const { blobs, open } = holdBlobs(github);
    const views = [1, 2].map(() => fetch(`${url}/diff?mode=since-review`, { headers }));

    await vi.waitFor(() => expect(blobs).toHaveBeenCalledTimes(2));

    const compare = vi.spyOn(github, 'compare');
    const start = fetch(`${url}/ai`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ task: 'since_review', provider: 'codex' }),
    });

    // The start found the branch rebased, and waits behind the two views for a place to read
    // its texts.
    await vi.waitFor(() => expect(compare).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(compare).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveBeenCalledTimes(2);

    const closed = instance.close();
    const refused = await start;

    expect(refused.status).toBe(503);
    expect(refused.headers.get('connection')).toBe('close');
    expect(await refused.json()).toMatchObject({ code: 'SHUTTING_DOWN' });

    open();

    for (const view of await Promise.all(views)) {
      expect(view.status).toBe(503);
      expect(view.headers.get('connection')).toBe('close');
    }

    // Answered during shutdown, their connections close, so the app does not wait them out.
    await closed;
    expect(blobs).toHaveBeenCalledTimes(2);
  });
});
