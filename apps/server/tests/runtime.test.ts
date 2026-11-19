import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { unusedPort } from '@test/fixtures/ai/restart-helper.js';
import { createApp } from '@/app.js';
import { AutoReviewer } from '@/ai/auto-review.js';
import {
  agentProcesses,
  endLeftoverAgents,
  killAgentProcesses,
  settingsJournal,
  spawnAgentProcess,
  useAgentJournal,
} from '@/ai/provider.js';
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
    const alive = () => {
      try {
        process.kill(helper, 0);

        return true;
      } catch {
        return false;
      }
    };

    expect(helper).toBeGreaterThan(0);
    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000 });
  });

  it('ends the agents of a server that was killed outright before runs resume', async () => {
    const directory = temporaryDirectory();
    const holder = spawnScript('tests/fixtures/agent-holder.mjs', { REVIEW_AGENT_DATA: directory });
    const started = await waitForOutput(holder, /helper \d+\n/);
    const helper = Number(/helper (\d+)/.exec(started)?.[1]);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);

        return true;
      } catch {
        return false;
      }
    };

    expect(helper).toBeGreaterThan(0);

    // SIGKILL: no exit handler runs, so the agent and its helper outlive the server.
    holder.kill('SIGKILL');
    await new Promise((resolve) => holder.once('exit', resolve));
    expect(alive(helper)).toBe(true);

    // The next server, owning the same data, ends them before anything resumes.
    const store = new Store(join(directory, 'state.sqlite'));

    cleanups.push(() => store.close());

    const { ended, verified } = await endLeftoverAgents(settingsJournal(store));

    // The agent and its helper both carry the agent's marker.
    expect(verified).toBe(true);
    expect(ended).toBeGreaterThanOrEqual(2);
    await vi.waitFor(() => expect(alive(helper)).toBe(false), { timeout: 5_000 });
    expect(settingsJournal(store).load()).toEqual([]);
  });

  it('never touches a process that only mentions a recorded agent’s marker', async () => {
    const marker = '00000000-0000-4000-8000-000000000000';
    // In its command line and inside another variable's value, but not as its own entry.
    const other = spawn(
      process.execPath,
      ['-e', `setInterval(() => {}, 1000) // REVIEW_DESK_AGENT=${marker}`],
      {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, NOTE: `REVIEW_DESK_AGENT=${marker}` },
      },
    );

    cleanups.push(() => {
      try {
        process.kill(-other.pid!, 'SIGKILL');
      } catch {
        // Already gone.
      }
    });

    let saved = [marker];
    const journal = { load: () => saved, save: (markers: string[]) => (saved = markers) };

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await endLeftoverAgents(journal)).toEqual({ ended: 0, verified: true });
    expect(() => process.kill(other.pid!, 0)).not.toThrow();
    expect(saved).toEqual([]);
  });

  it('keeps old agents on record, and says so, when processes cannot be listed', async () => {
    let saved = ['00000000-0000-4000-8000-000000000001'];
    const journal = { load: () => saved, save: (markers: string[]) => (saved = markers) };
    const listing = vi.spyOn(agentProcesses, 'list').mockReturnValueOnce(null);

    expect(await endLeftoverAgents(journal)).toEqual({ ended: 0, verified: false });
    expect(saved).toEqual(['00000000-0000-4000-8000-000000000001']);

    // Recording a new agent keeps the unchecked one on record.
    const controller = new AbortController();

    useAgentJournal(journal);
    cleanups.push(() => useAgentJournal(null));

    const agent = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: tmpdir(),
      env: process.env,
      signal: controller.signal,
      timeoutMs: 60_000,
    });

    // Recorded before it starts.
    expect(saved).toHaveLength(2);
    await agent.done;

    listing.mockRestore();
    expect(await endLeftoverAgents(journal)).toEqual({ ended: 0, verified: true });
    expect(saved).toEqual([]);
  });

  it('does not start an agent it cannot record', async () => {
    useAgentJournal({
      load: () => [],
      save: () => {
        throw new Error('database is locked');
      },
    });
    cleanups.push(() => useAgentJournal(null));

    // The agent would leave a file behind if it ran.
    const witness = join(temporaryDirectory(), 'started');

    expect(() =>
      spawnAgentProcess(
        process.execPath,
        ['-e', `require('fs').writeFileSync(${JSON.stringify(witness)}, 'ran')`],
        {
          cwd: tmpdir(),
          env: process.env,
          signal: new AbortController().signal,
          timeoutMs: 60_000,
        },
      ),
    ).toThrow('Could not record the agent before starting it: database is locked');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(existsSync(witness)).toBe(false);
  });

  it('ends a marked helper that outlives its agent, and keeps the marker when it cannot tell', async () => {
    let saved: string[] = [];
    const journal = { load: () => saved, save: (markers: string[]) => (saved = markers) };
    const lines: string[] = [];

    useAgentJournal(journal);
    cleanups.push(() => useAgentJournal(null));

    // A helper in its own process group (the group kill misses it) that ignores SIGTERM.
    const helperScript =
      "const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore', detached: true }); helper.unref(); console.log(helper.pid);";
    const agent = spawnAgentProcess(process.execPath, ['-e', helperScript], {
      cwd: tmpdir(),
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
      onLine: (line) => lines.push(line),
    });

    await agent.done;

    const helper = Number(lines[0]);
    const alive = () => {
      try {
        process.kill(helper, 0);

        return true;
      } catch {
        return false;
      }
    };

    await vi.waitFor(() => expect(alive()).toBe(false), { timeout: 5_000 });
    await vi.waitFor(() => expect(saved).toEqual([]));

    // When processes cannot be listed, the marker passes to the next start's check.
    const listing = vi.spyOn(agentProcesses, 'list').mockReturnValue(null);
    const quiet = spawnAgentProcess(process.execPath, ['-e', ''], {
      cwd: tmpdir(),
      env: process.env,
      signal: new AbortController().signal,
      timeoutMs: 60_000,
    });

    await quiet.done;
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    listing.mockRestore();
    expect(await endLeftoverAgents(journal)).toEqual({ ended: 0, verified: true });
    expect(saved).toEqual([]);
  });

  it('ends agents that are still running when the server exits', async () => {
    const controller = new AbortController();
    // An agent that ignores SIGTERM, as a stuck one would.
    const agent = spawnAgentProcess(
      process.execPath,
      ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { cwd: tmpdir(), env: process.env, signal: controller.signal, timeoutMs: 60_000 },
    );
    const ended = agent.done.then(
      () => 'ended',
      () => 'ended',
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    killAgentProcesses();

    expect(await ended).toBe('ended');
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
