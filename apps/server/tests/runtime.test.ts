import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unusedPort } from '@test/fixtures/ai/restart-helper.js';
import { createApp } from '@/app.js';
import { AutoReviewer } from '@/ai/auto-review.js';
import { agentExited, agentRunning, spawnAgentProcess } from '@/ai/provider.js';
import type { AiRunner } from '@/ai/runner.js';
import { DataDirectoryLocked, lockDataDirectory } from '@/db/lock.js';
import type { AiRunRow } from '@/db/schema.js';
import { Store } from '@/db/store.js';
import { FixtureGitHub } from '@/demo/fixture-github.js';
import { defaultScenario } from '@/demo/scenario.js';
import { EventBus } from '@/events.js';
import { Backfill } from '@/insights/backfill.js';
import type { Notifier } from '@/notify/notifier.js';
import { SyncService } from '@/sync/service.js';

const serverRoot = fileURLToPath(new URL('..', import.meta.url));
const cleanups: (() => void | Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function temporaryDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'review-desk-runtime-'));

  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));

  return directory;
}

/**
 * True once `pid` no longer runs: gone, or a zombie its new parent has not reaped yet (which
 * `kill(pid, 0)` still finds on Linux).
 */
function ended(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return true;
  }

  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });

  return state.stdout.trim() === '' || state.stdout.trim().startsWith('Z');
}

/** Runs a server-side script with tsx, the way the restart tests do. */
function spawnScript(script: string, env: Record<string, string>): ChildProcess {
  const child = spawn(process.execPath, ['--import', 'tsx', join(serverRoot, script)], {
    env: { ...process.env, TSX_TSCONFIG_PATH: join(serverRoot, 'tsconfig.json'), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  return child;
}

/** Resolves with everything the process printed once `marker` appears; rejects if it exits. */
function waitForOutput(child: ChildProcess, marker: string | RegExp): Promise<string> {
  let output = '';

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for: ${output}`)), 20_000);
    const collect = (data: Buffer) => {
      output += data.toString();

      if (typeof marker === 'string' ? output.includes(marker) : marker.test(output)) {
        clearTimeout(timeout);
        resolve(output);
      }
    };

    child.stdout!.on('data', collect);
    child.stderr!.on('data', collect);
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`Exited ${code} before "${marker}": ${output}`));
    });
  });
}

function exited(child: ChildProcess): Promise<{ code: number | null; output: string }> {
  let output = '';

  child.stdout!.on('data', (data: Buffer) => (output += data.toString()));
  child.stderr!.on('data', (data: Buffer) => (output += data.toString()));

  return new Promise((resolve) => child.once('exit', (code) => resolve({ code, output })));
}

function demoServer(directory: string, port: number): ChildProcess {
  return spawnScript('src/index.ts', {
    REVIEW_DESK_MODE: 'demo',
    REVIEW_DESK_DATA_DIR: directory,
    REVIEW_DESK_PORT: String(port),
  });
}

/** Holds `work` until the test calls `release`, counting how often it was called. */
function gate<A extends unknown[], R>(work: (...args: A) => Promise<R>) {
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const counter = { calls: 0 };
  const gated = async (...args: A): Promise<R> => {
    counter.calls++;
    await held;

    return work(...args);
  };

  return { gated, release, counter };
}

function demoService() {
  const store = new Store(':memory:');
  const fixture = new FixtureGitHub(defaultScenario(Date.parse('2026-11-05T10:00:00Z')));
  const service = new SyncService(store, fixture, new EventBus());

  cleanups.push(() => store.close());

  return { store, fixture, service };
}

describe('data directory ownership', () => {
  it('lets one owner at a time use a data directory', () => {
    const directory = temporaryDirectory();
    const lock = lockDataDirectory(directory);

    expect(() => lockDataDirectory(directory)).toThrow(DataDirectoryLocked);

    try {
      lockDataDirectory(directory);
    } catch (error) {
      expect((error as DataDirectoryLocked).ownerPid).toBe(process.pid);
    }

    lock.release();
    lock.release();
    lockDataDirectory(directory).release();
  });

  it('refuses a second process and frees the directory when its owner is killed', async () => {
    const directory = temporaryDirectory();
    const holder = spawnScript('tests/fixtures/hold-lock.mjs', {
      REVIEW_LOCK_DIRECTORY: directory,
    });

    await waitForOutput(holder, 'held');
    expect(() => lockDataDirectory(directory)).toThrow(
      new RegExp(`already running .*\\(process ${holder.pid}\\)`),
    );

    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));

    // A crash never leaves the directory locked.
    lockDataDirectory(directory).release();
  });

  it('stops a second launch before it opens the database, and shuts down cleanly', async () => {
    const directory = temporaryDirectory();
    const [firstPort, secondPort] = [await unusedPort(), await unusedPort()];
    const first = demoServer(directory, firstPort);

    await waitForOutput(first, `→ http://127.0.0.1:${firstPort}`);

    const second = await exited(demoServer(directory, secondPort));

    expect(second.code).toBe(1);
    expect(second.output).toContain('Review Desk is already running');
    expect(second.output).toContain(`process ${first.pid}`);
    expect(second.output).not.toContain(`http://127.0.0.1:${secondPort}`);

    // The running instance is unaffected.
    const status = await fetch(`http://127.0.0.1:${firstPort}/api/status`);

    expect(status.ok).toBe(true);

    const stopped = exited(first);

    first.kill('SIGTERM');
    expect((await stopped).code).toBe(0);

    // Ownership ends with the process.
    lockDataDirectory(directory).release();
  }, 60_000);
});

describe('shutdown order', () => {
  it('waits for a sync in progress and starts nothing once closed', async () => {
    const { store, fixture, service } = demoService();
    const app = await createApp(service, { sessionToken: 'test-session', fixture });
    const searches = vi.spyOn(fixture, 'searchPullIds');

    await app.ready();
    await service.sync();
    // The first sync starts reading history; let it finish.
    await vi.waitFor(() =>
      expect(
        store.getSetting<{ finishedAt: string | null }>('backfill:you')?.finishedAt,
      ).toBeTruthy(),
    );

    const historyReads = searches.mock.calls.length;
    const { gated, release, counter } = gate(fixture.discover.bind(fixture));

    fixture.discover = gated;

    const syncing = service.sync();

    await vi.waitFor(() => expect(counter.calls).toBeGreaterThan(0));

    let closed = false;
    const closing = app.close().then(() => (closed = true));

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(closed).toBe(false);

    release();
    await Promise.all([closing, syncing]);

    const calls = counter.calls;

    // Neither a request nor the schedule can start another sync after shutdown.
    await service.sync();
    service.start();
    expect(counter.calls).toBe(calls);
    // The sync that finished during shutdown started no history read: every part had already
    // stopped taking work before any of them drained.
    expect(searches.mock.calls.length).toBe(historyReads);
  });

  it('stops taking work before it waits for requests in flight', async () => {
    const { fixture, service } = demoService();
    const port = await unusedPort();
    const app = await createApp(service, {
      sessionToken: 'test-session',
      fixture,
      ports: [port],
    });

    await app.listen({ host: '127.0.0.1', port });
    await service.sync();

    const id = fixture.scenario.world.pulls[0]!.snapshot.id;
    const read = gate(fixture.snapshot.bind(fixture));

    fixture.snapshot = read.gated;

    // A request still waiting on GitHub when shutdown begins (no keep-alive, so closing need not
    // wait for an idle connection afterwards).
    const request = new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/api/pulls/${encodeURIComponent(id)}/refresh`,
          agent: false,
          headers: {
            Connection: 'close',
            'Content-Type': 'application/json',
            'X-Review-Desk': '1',
            'X-Review-Desk-Session': 'test-session',
          },
        },
        (response) => {
          response.resume();
          response.on('end', () => resolve(response.statusCode ?? 0));
        },
      );

      outgoing.on('error', reject);
      outgoing.end('{}');
    });

    await vi.waitFor(() => expect(read.counter.calls).toBe(1));

    const closing = app.close();

    await new Promise((resolve) => setTimeout(resolve, 50));

    // Fastify is still waiting for the request, yet nothing starts new work meanwhile.
    const discover = vi.spyOn(fixture, 'discover');

    await service.sync();
    expect(discover).not.toHaveBeenCalled();

    read.release();
    expect(await request).toBe(200);
    await closing;
  });

  it('does not announce a review whose check shutdown cut short', async () => {
    const { fixture, service } = demoService();

    await service.sync();

    const prId = fixture.scenario.world.pulls[0]!.snapshot.id;
    const announce = vi.fn(async () => undefined);
    const runner = {
      settings: () => ({ autoReview: { enabled: true } }),
    } as unknown as AiRunner;
    const reviewer = new AutoReviewer(service, runner, { announce } as unknown as Notifier);
    const check = gate(async () => false);

    // The check that new commits arrived while it ran, still waiting on GitHub.
    vi.spyOn(
      reviewer as unknown as { verify: () => Promise<boolean> },
      'verify',
    ).mockImplementation(check.gated);

    reviewer.finished({
      id: 'run-1',
      account: 'you',
      prId,
      task: 'full_review',
      trigger: 'auto',
      status: 'done',
      result: null,
    } as unknown as AiRunRow);
    await vi.waitFor(() => expect(check.counter.calls).toBe(1));

    const closing = reviewer.close();

    check.release();
    await closing;
    expect(announce).not.toHaveBeenCalled();
  });

  it('lets the other parts finish draining when one fails to stop, then reports it', async () => {
    const { fixture, service } = demoService();
    const history = gate(fixture.searchPullIds.bind(fixture));

    fixture.searchPullIds = history.gated;

    const app = await createApp(service, { sessionToken: 'test-session', fixture });

    await app.ready();
    // The sync starts reading history, which is held mid-window.
    await service.sync();
    await vi.waitFor(() => expect(history.counter.calls).toBe(1));
    vi.spyOn(service, 'stop').mockRejectedValueOnce(new Error('checkpoint failed'));

    let settled = false;
    const closing = app.close().then(
      () => (settled = true),
      (error: unknown) => {
        settled = true;

        throw error;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(settled).toBe(false);

    history.release();
    await expect(closing).rejects.toThrow('Some work could not stop cleanly.');
  });

  it('waits for the work a finished automatic review starts', async () => {
    const { fixture, service } = demoService();

    await service.sync();

    const prId = fixture.scenario.world.pulls[0]!.snapshot.id;
    const announce = gate(async () => undefined);
    const runner = { settings: () => ({ autoReview: { enabled: false } }) } as unknown as AiRunner;
    const notifier = { announce: announce.gated } as unknown as Notifier;
    const reviewer = new AutoReviewer(service, runner, notifier);
    const row = {
      id: 'run-1',
      account: 'you',
      prId,
      task: 'full_review',
      trigger: 'auto',
      status: 'done',
      result: null,
    } as unknown as AiRunRow;

    reviewer.finished(row);
    await vi.waitFor(() => expect(announce.counter.calls).toBe(1));

    let closed = false;
    const closing = reviewer.close().then(() => (closed = true));

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);

    announce.release();
    await closing;

    // Once closing, a run that finishes is left for the next start.
    reviewer.finished({ ...row, id: 'run-2' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(announce.counter.calls).toBe(1);
  });

  it('ends what an agent left running in its process group when it exits', async () => {
    const controller = new AbortController();
    const lines: string[] = [];
    // The agent starts a helper in its own group that ignores SIGTERM, then exits at once.
    const agent = spawnAgentProcess(
      process.execPath,
      [
        '-e',
        "const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); helper.unref(); console.log(helper.pid);",
      ],
      {
        cwd: tmpdir(),
        env: process.env,
        signal: controller.signal,
        timeoutMs: 60_000,
        onLine: (line) => lines.push(line),
      },
    );

    await agent.done;

    const helper = Number(lines[0]);
    const alive = () => !ended(helper);

    expect(helper).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000 });
  });

  it('ends the agents of a server that was killed outright, with no help from the next one', async () => {
    const directory = temporaryDirectory();
    const workDir = join(directory, 'ai-runs', 'run-1');
    const holder = spawnScript('tests/fixtures/agent-holder.mjs', {
      REVIEW_AGENT_DATA: directory,
      REVIEW_AGENT_WORKDIR: workDir,
    });
    const started = await waitForOutput(holder, /helper \d+\n/);
    const helper = Number(/helper (\d+)/.exec(started)?.[1]);
    const alive = (pid: number) => !ended(pid);

    expect(helper).toBeGreaterThan(0);
    expect(agentRunning(workDir)).toBe(true);

    // SIGKILL: no exit handler runs. The agent's supervisor sees its lifeline close and ends the
    // agent and the helper, which ignores SIGTERM, and with them the run's lock.
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 5_000 });
    expect(await agentExited(workDir, 5_000)).toBe(true);
  });

  it('says a run’s agent is running until it has exited, and never starts a second one', async () => {
    const workDir = join(temporaryDirectory(), 'run-2');
    const options = {
      cwd: tmpdir(),
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      lockFor: workDir,
    };
    // Ignores SIGTERM for a while, as an agent finishing its turn would.
    const first = spawnAgentProcess(
      process.execPath,
      [
        '-e',
        "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 700)); setInterval(() => {}, 1000)",
      ],
      options,
    );

    await vi.waitFor(() => expect(agentRunning(workDir)).toBe(true));

    // A second agent for the same run refuses to start while the first holds the lock.
    const second = spawnAgentProcess(process.execPath, ['-e', ''], options);
    const refused = await second.done;

    expect(refused.code).toBe(75);
    expect(refused.stderr).toContain('An agent for this run is still running.');

    first.stop();
    expect(agentRunning(workDir)).toBe(true);
    expect(await agentExited(workDir, 5_000)).toBe(true);
    await first.done.catch(() => undefined);
  });

  it('ends a helper that holds the agent’s output open, before the run counts as finished', async () => {
    const workDir = join(temporaryDirectory(), 'run-3');
    const lines: string[] = [];
    // The helper shares the agent's output and process group, ignores SIGTERM, and outlives it.
    const agent = spawnAgentProcess(
      process.execPath,
      [
        '-e',
        "const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'inherit' }); helper.unref(); console.log(helper.pid); setTimeout(() => process.exit(4), 100);",
      ],
      {
        cwd: tmpdir(),
        env: process.env,
        signal: new AbortController().signal,
        timeoutMs: 60_000,
        lockFor: workDir,
        onLine: (line) => lines.push(line),
      },
    );
    const started = Date.now();
    const result = await agent.done;
    const helper = Number(lines[0]);

    // The agent's own exit code, reported by its supervisor, and no wait for the open output.
    expect(result.code).toBe(4);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(ended(helper)).toBe(true);
    expect(agentRunning(workDir)).toBe(false);
  });

  it('lets history stop after its current window and resume on the next start', async () => {
    const { fixture, service } = demoService();

    await service.sync();

    const backfill = new Backfill(service, service.events);
    const { gated, release, counter } = gate(fixture.searchPullIds.bind(fixture));

    fixture.searchPullIds = gated;

    const running = backfill.start('you');

    await vi.waitFor(() => expect(counter.calls).toBe(1));

    const closing = backfill.close();

    release();
    await Promise.all([closing, running]);

    // The window in progress finished (two searches); later windows never started.
    expect(counter.calls).toBe(2);
    expect(backfill.state('you')).toMatchObject({ finishedAt: null, running: false });

    await backfill.start('you');
    expect(counter.calls).toBe(2);
  });
});
