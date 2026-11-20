import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { allowed, knownRoutes, log, LogFile } from '@/log.js';
import { createApp } from '@/app.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { githubOp, gitlabOp } from '@/forge/ops.js';
import { watchEventLoop } from '@/http/loop.js';
import { SyncService } from '@/sync/index.js';

const cleanups: (() => unknown)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();

  log.silence();
});

function directory() {
  const path = mkdtempSync(join(tmpdir(), 'review-desk-log-'));

  cleanups.push(() => rmSync(path, { recursive: true, force: true }));

  return path;
}

/** Lines the log wrote, parsed. */
function captured() {
  const lines: string[] = [];

  log.open({ write: (line) => void lines.push(line) }, 'debug');

  return { lines, records: () => lines.map((line) => JSON.parse(line)) };
}

describe('log records', () => {
  knownRoutes.add('/api/pulls/:id');
  knownRoutes.add('/api/status');

  it('hold only the fields their event names, of the kinds it allows', () => {
    expect(
      allowed('http.request', {
        route: '/api/pulls/:id',
        method: 'GET',
        status: 200,
        ms: 12.345,
        body: 'secret review text',
      }),
    ).toEqual({ route: '/api/pulls/:id', method: 'GET', status: 200, ms: 12.3 });

    // A request's own path, a branch name or a free-form string is never a value.
    expect(
      allowed('http.request', {
        route: '/api/pulls/PR_acme_api_2041?token=ghp_abcdef',
        method: 'feature/secret-branch',
        status: '200',
      }),
    ).toEqual({ route: 'other', method: 'other' });
    expect(allowed('forge.request', { op: 'repos/acme/private/contents/notes.md' })).toEqual({
      op: 'other',
    });
  });

  it('write nothing a user wrote, from any field or error, into the serialized line', () => {
    const { lines, records } = captured();
    const secret = [
      'ghp_0123456789abcdefghijklmnopqrstuvwxyzAB',
      'feat/DEMO-101/private-branch',
      'src/secret/notes.md',
      'alice@example.com',
    ];

    log.event('debug', 'forge.request', {
      forge: 'github',
      op: secret[1] as never,
      totalMs: 10,
      ...({ path: secret[2], login: secret[3], message: secret[0] } as object),
    });
    log.event('info', 'sync.completed', {
      forge: 'gitlab',
      outcome: `${secret[0]} failed` as never,
      totalMs: 5,
    });
    log.event('warn', 'http.request', {
      route: `/api/pulls/${secret[2]}`,
      method: 'GET',
      status: 500,
    });

    const text = lines.join('');

    for (const value of secret) expect(text).not.toContain(value);
    expect(records().map((record) => record.event)).toEqual([
      'forge.request',
      'sync.completed',
      'http.request',
    ]);
    expect(records()[0]).toMatchObject({ level: 'debug', forge: 'github', op: 'other' });
  });

  it('is written only through the event log: nothing else in the server uses pino', () => {
    const files = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
        entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)],
      );
    const root = join(import.meta.dirname, '..', 'src');
    const users = files(root).filter(
      (file) =>
        file.endsWith('.ts') &&
        !file.endsWith('log.ts') &&
        /from ['"]pino['"]/.test(readFileSync(file, 'utf8')),
    );

    expect(users).toEqual([]);
  });

  it('is silent until opened, and below its level', () => {
    const lines: string[] = [];

    log.event('info', 'server.stopped', { clean: true });
    log.open({ write: (line) => void lines.push(line) }, 'info');
    log.event('debug', 'http.request', { route: '/api/status', method: 'GET', status: 200, ms: 1 });
    log.event('info', 'server.stopped', { clean: true });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ level: 'info', event: 'server.stopped' });
  });
});

/** A stream whose writes complete only once `release` is called, and that ends on `finish`. */
function stalled() {
  const waiting: (() => void)[] = [];
  let flowing = false;
  let finishing = false;
  let ended: (() => void) | null = null;
  const stream = new Writable({
    write(_chunk, _encoding, callback) {
      if (flowing) callback();
      else waiting.push(() => callback());
    },
    final(callback) {
      if (finishing) callback();
      else ended = () => callback();
    },
  });

  return {
    stream,
    release: () => {
      flowing = true;
      for (const done of waiting.splice(0)) done();
    },
    finish: () => {
      finishing = true;
      ended?.();
    },
  };
}

describe('the log file', () => {
  it('rotates past its threshold, keeping every line and at most five old files', async () => {
    const dir = directory();
    const path = join(dir, 'logs', 'review-desk.log');
    const file = new LogFile(path, { rotateAtBytes: 100, keep: 5, checkEveryMs: 60_000 });

    file.open();

    const lines = Array.from({ length: 40 }, (_, index) => `${'x'.repeat(40)} line ${index}\n`);

    for (const [index, line] of lines.entries()) {
      file.write(line);
      if (index % 3 === 2) await file.rotate();
    }

    expect(await file.close()).toBe('closed');

    const names = readdirSync(join(dir, 'logs')).sort();
    const kept = names.map((name) => readFileSync(join(dir, 'logs', name), 'utf8')).join('');

    expect(names).toEqual([
      'review-desk.log',
      'review-desk.log.1',
      'review-desk.log.2',
      'review-desk.log.3',
      'review-desk.log.4',
      'review-desk.log.5',
    ]);
    // The newest lines are all there; only the oldest files were let go.
    for (const line of lines.slice(-8)) expect(kept).toContain(line);
  });

  it('rotates a file already past its threshold when it opens', () => {
    const dir = directory();
    const path = join(dir, 'review-desk.log');

    writeFileSync(path, 'y'.repeat(200));

    const file = new LogFile(path, { rotateAtBytes: 100 });

    file.open();
    cleanups.push(() => file.close());

    expect(readFileSync(`${path}.1`, 'utf8')).toHaveLength(200);
  });

  it('keeps pending writes within its budget on a disk that stalls, and says how many it dropped', async () => {
    const dir = directory();
    const disk = stalled();
    const file = new LogFile(join(dir, 'review-desk.log'), {
      budgetBytes: 1000,
      openStream: () => disk.stream,
    });

    file.open();

    for (let index = 0; index < 50; index++) file.write(`${'z'.repeat(99)}\n`);

    // Seven records fit in the budget (a little is kept for the drop record); the rest were
    // dropped, none queued.
    expect(disk.stream.writableLength).toBeLessThanOrEqual(1000);

    const written: string[] = [];
    const write = disk.stream.write.bind(disk.stream);

    vi.spyOn(disk.stream, 'write').mockImplementation(((chunk: string, ...rest: never[]) => {
      written.push(String(chunk));

      return write(chunk, ...rest);
    }) as never);
    disk.release();
    await new Promise((resolve) => setImmediate(resolve));

    expect(written.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({ event: 'log.dropped', count: 43 }),
    ]);
    disk.release();
    disk.finish();
    expect(await file.close()).toBe('closed');
  });

  it('reports a timeout when it cannot close in time, so the lock is kept', async () => {
    const dir = directory();
    const disk = stalled();
    const file = new LogFile(join(dir, 'review-desk.log'), { openStream: () => disk.stream });

    file.open();
    file.write('one\n');
    disk.release();

    // The disk never finishes the file.
    expect(await file.close(50)).toBe('timeout');
    disk.finish();
  });

  it('waits for a rotation that is closing its stream, and keeps the lock past the deadline', async () => {
    const dir = directory();
    const disks = [stalled(), stalled()];
    let opened = 0;
    const file = new LogFile(join(dir, 'review-desk.log'), {
      rotateAtBytes: 10,
      openStream: () => disks[opened++].stream,
    });

    file.open();
    file.write('past the threshold\n');

    // The rotation is now ending the first stream, which the disk does not let finish.
    const rotation = file.rotate();

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await file.close(50)).toBe('timeout');

    disks[0].release();
    disks[0].finish();
    await rotation;
  });

  it('does not count a stream that failed without closing as closed', async () => {
    const dir = directory();
    const disk = stalled();
    const file = new LogFile(join(dir, 'review-desk.log'), {
      openStream: () => disk.stream,
      warn: () => undefined,
    });

    file.open();
    file.write('one\n');
    // An error that leaves the stream open, as an injected or wrapped stream can.
    disk.stream.emit('error', new Error('EIO'));

    expect(await file.close(50)).toBe('timeout');
    disk.release();
    disk.finish();
  });

  it('closes after a rotation in progress', async () => {
    const dir = directory();
    const path = join(dir, 'review-desk.log');
    const file = new LogFile(path, { rotateAtBytes: 10 });

    file.open();
    file.write('a line past the threshold\n');
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rotation = file.rotate();

    file.write('written while rotating\n');
    expect(await file.close()).toBe('closed');
    await rotation;

    const all = [path, `${path}.1`]
      .filter((name) => existsSync(name))
      .map((name) => readFileSync(name, 'utf8'))
      .join('');

    expect(all).toContain('a line past the threshold');
    expect(all).toContain('written while rotating');
  });

  it('keeps the app running when its file cannot be written', async () => {
    const dir = directory();
    const warn = vi.fn();

    // A file where its folder should be.
    writeFileSync(join(dir, 'logs'), 'not a folder');

    const file = new LogFile(join(dir, 'logs', 'review-desk.log'), { warn });

    expect(() => file.open()).not.toThrow();
    expect(() => file.write('dropped\n')).not.toThrow();
    expect(warn).toHaveBeenCalledOnce();
    expect(await file.close()).toBe('closed');
  });
});

describe('what is measured', () => {
  it('names forge requests by what they do, never by their paths', () => {
    expect(
      githubOp('graphql', JSON.stringify({ query: 'query Snapshot($id: ID!) { node }' })),
    ).toBe('Snapshot');
    expect(githubOp('graphql', JSON.stringify({ query: 'mutation Unknown { x }' }))).toBe('other');
    expect(
      githubOp(
        'graphql',
        JSON.stringify({ query: '\n  mutation SubmitReview { x }', variables: {} }),
      ),
    ).toBe('SubmitReview');
    // Variables that look like a document never name it.
    expect(
      githubOp(
        'graphql',
        JSON.stringify({ query: '{ viewer }', variables: { body: 'query Snapshot' } }),
      ),
    ).toBe('graphql');
    expect(githubOp('repos/acme/secret-repo/pulls/12/files?per_page=100&page=2')).toBe(
      'pulls.files',
    );
    expect(githubOp('repos/acme/api/git/ref/heads/feat/DEMO-1/private')).toBe('git.ref');
    expect(githubOp('repos/acme/api/contents/src/secret.ts')).toBe('other');

    expect(gitlabOp('projects/acme%2Fweb/merge_requests/12/discussions?per_page=100')).toBe(
      'mr.discussions',
    );
    expect(gitlabOp('projects/7/merge_requests/12')).toBe('mr');
    expect(gitlabOp('projects/7/merge_requests/12/time_estimate')).toBe('mr.other');
    expect(gitlabOp('projects/7/repository/branches/feat%2Fprivate')).toBe('repository.branch');
    expect(gitlabOp('projects/7/repository/files/src%2Fsecret.ts/raw?ref=main')).toBe(
      'repository.files',
    );
    expect(gitlabOp('groups/acme/epics')).toBe('other');
  });

  it('times each request by its route, loudly when it is slow or fails', async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const service = new SyncService(store, fixture, new EventBus());
    const app = await createApp(service, { sessionToken: 'test-session', fixture });

    cleanups.push(() => store.close());
    cleanups.push(() => app.close());

    const { records } = captured();

    await app.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        host: '127.0.0.1:4317',
        'x-review-desk': '1',
        'x-review-desk-session': 'test-session',
      },
    });
    await app.inject({ method: 'GET', url: '/api/pulls/PR_secret_repo_1?token=ghp_x' });

    const requests = records().filter((record) => record.event === 'http.request');

    expect(requests[0]).toMatchObject({
      level: 'debug',
      route: '/api/status',
      method: 'GET',
      status: 200,
      ms: expect.any(Number),
    });
    expect(requests[1]).toMatchObject({ route: '/api/pulls/:id' });
    expect(JSON.stringify(requests)).not.toContain('secret');
    expect(JSON.stringify(requests)).not.toContain('ghp_');
  });

  it('logs one record per sync, by phase and count', async () => {
    const store = new Store(':memory:');
    const fixture = new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
    const service = new SyncService(store, fixture, new EventBus());

    cleanups.push(() => store.close());

    const { records } = captured();

    await service.sync();

    const [sync] = records().filter((record) => record.event === 'sync.completed');

    expect(sync).toMatchObject({
      level: 'info',
      forge: 'github',
      trigger: 'manual',
      outcome: 'ok',
      discoveryMs: expect.any(Number),
      detectionMs: expect.any(Number),
      fetchMs: expect.any(Number),
      totalMs: expect.any(Number),
      candidates: expect.any(Number),
      fetched: expect.any(Number),
      failed: 0,
      concurrency: 3,
    });
    expect(sync.fetched).toBeGreaterThan(0);
    expect(sync.fetchMaxMs).toBeLessThanOrEqual(sync.fetchSumMs);
  });

  it('reports each window of event-loop delay with its sample count, and stops', async () => {
    const { records } = captured();
    const stop = watchEventLoop(60, 10);

    await new Promise((resolve) => setTimeout(resolve, 200));
    stop();

    const windows = records().filter((record) => record.event === 'loop.delay');

    expect(windows.length).toBeGreaterThan(0);
    expect(windows[0]).toEqual(
      expect.objectContaining({
        p50: expect.any(Number),
        p99: expect.any(Number),
        count: expect.any(Number),
      }),
    );

    const after = records().length;

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(records()).toHaveLength(after);
  });
});
