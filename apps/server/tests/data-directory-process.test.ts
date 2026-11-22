import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { serverRoot } from '@/config.js';
import { LAST_ACCOUNT } from '@/db/settings.js';
import { Store } from '@/db/store.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A home and checkouts of our own: no real folder is ever in scope. */
function machine() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rd-data-run-')));
  const home = join(root, 'home');

  mkdirSync(join(home, 'Library', 'Application Support'), { recursive: true });
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const checkout = (name: string, account?: string) => {
    const project = join(root, name);

    mkdirSync(project);

    if (account) {
      mkdirSync(join(project, '.data'));

      const store = new Store(join(project, '.data', 'review-desk.sqlite'));

      store.settings.set(LAST_ACCOUNT, account);
      store.close();
    }

    return project;
  };

  return {
    root,
    home,
    target: join(home, 'Library', 'Application Support', 'Review Desk'),
    checkout,
  };
}

interface Run {
  child: ChildProcess;
  /** Each JSON line it printed, in order. */
  said: Record<string, unknown>[];
  /** Resolves with the first line matching `test`; rejects if it exits first. */
  until(test: (line: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

function start(entry: Record<string, unknown>): Run {
  const child = spawn(
    process.execPath,
    ['--import', 'tsx', join(serverRoot, 'tests/fixtures/data-directory-entry.ts')],
    {
      env: {
        ...process.env,
        TSX_TSCONFIG_PATH: join(serverRoot, 'tsconfig.json'),
        ENTRY: JSON.stringify(entry),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const said: Record<string, unknown>[] = [];
  const waiters: {
    test: (line: Record<string, unknown>) => boolean;
    resolve: (line: Record<string, unknown>) => void;
  }[] = [];
  let buffer = '';
  let stderr = '';

  child.stdout!.on('data', (data: Buffer) => {
    buffer += data.toString();

    for (let index; (index = buffer.indexOf('\n')) !== -1;) {
      const line = JSON.parse(buffer.slice(0, index)) as Record<string, unknown>;

      buffer = buffer.slice(index + 1);
      said.push(line);

      for (const waiter of waiters.splice(0)) {
        if (waiter.test(line)) waiter.resolve(line);
        else waiters.push(waiter);
      }
    }
  });
  child.stderr!.on('data', (data: Buffer) => (stderr += data.toString()));

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('exit', (code, signal) => resolve({ code, signal })),
  );

  cleanups.push(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  return {
    child,
    said,
    exited,
    until: (test) =>
      new Promise((resolve, reject) => {
        const found = said.find(test);

        if (found) return resolve(found);

        waiters.push({ test, resolve });
        void exited.then(({ code, signal }) =>
          reject(
            new Error(`exited (${code ?? signal}) before that: ${JSON.stringify(said)} ${stderr}`),
          ),
        );
      }),
  };
}

const finished = async (run: Run) => {
  await run.exited;

  return run.said;
};

describe('moving a checkout’s data, across processes', () => {
  it('lets one checkout move it while another waits, then says the other’s is ignored', async () => {
    const { root, home, target, checkout } = machine();
    const first = checkout('first', 'first');
    const second = checkout('second', 'second');
    const resume = join(root, 'resume');
    const mover = start({ home, root: first, pauseFile: resume, hold: true });

    await mover.until((line) => line.paused === true);

    // Started while the first holds the startup lock, and still waiting on it when the move ends.
    const waiting = start({ home, root: second });

    await new Promise((resolve) => setTimeout(resolve, 200));
    writeFileSync(resume, '');

    expect(await mover.until((line) => 'outcome' in line)).toMatchObject({
      directory: target,
      outcome: 'moved',
      account: 'first',
    });
    // The OS folder is in use: the second checkout's launch is refused, its data left alone.
    const waited = await finished(waiting);

    expect(waited.at(-1), JSON.stringify(waited)).toMatchObject({ refused: 'locked' });
    expect(existsSync(join(second, '.data', 'review-desk.sqlite'))).toBe(true);

    mover.child.kill('SIGTERM');
    expect((await finished(mover)).at(-1)).toEqual({ released: true });
    // Given up cleanly: no owner file is left where the data is now.
    expect(existsSync(join(target, 'review-desk.owner.json'))).toBe(false);

    // Started again once the first has stopped: the OS folder's data is used.
    expect((await finished(start({ home, root: second }))).at(-2)).toMatchObject({
      directory: target,
      outcome: 'kept',
      account: 'first',
    });
  });

  it('leaves the checkout’s data in place when an override starts on the OS folder first', async () => {
    const { root, home, target, checkout } = machine();
    const project = checkout('project', 'mine');
    const resume = join(root, 'resume');
    const mover = start({ home, root: project, pauseFile: resume });

    await mover.until((line) => line.paused === true);

    const override = start({
      home,
      root: project,
      env: { REVIEW_DESK_DATA_DIR: target },
      hold: true,
    });

    await override.until((line) => 'outcome' in line);
    writeFileSync(resume, '');

    // Either refusal: an occupied folder, or one in use. The checkout's data is untouched.
    expect((await finished(mover)).at(-1)).toMatchObject({
      refused: expect.stringMatching(/locked|refused/),
    });
    expect(existsSync(join(project, '.data', 'review-desk.sqlite'))).toBe(true);

    const store = new Store(join(project, '.data', 'review-desk.sqlite'));

    expect(store.settings.get(LAST_ACCOUNT)).toBe('mine');
    store.close();
  });

  it('keeps a row a crashed writer left only in the WAL', async () => {
    const { home, target, checkout } = machine();
    const project = checkout('project');

    mkdirSync(join(project, '.data'));

    // A writer that commits a row and dies before any checkpoint.
    const writer = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        '--input-type=module',
        '-e',
        `
          import { Store } from '@/db/store.js';
          import { LAST_ACCOUNT } from '@/db/settings.js';
          const store = new Store(${JSON.stringify(join(project, '.data', 'review-desk.sqlite'))});
          store.settings.set(LAST_ACCOUNT, 'in the wal');
          process.kill(process.pid, 'SIGKILL');
        `,
      ],
      {
        cwd: serverRoot,
        env: { ...process.env, TSX_TSCONFIG_PATH: join(serverRoot, 'tsconfig.json') },
        stdio: 'ignore',
      },
    );

    await new Promise((resolve) => writer.once('exit', resolve));
    expect(existsSync(join(project, '.data', 'review-desk.sqlite-wal'))).toBe(true);

    expect((await finished(start({ home, root: project }))).at(-2)).toMatchObject({
      directory: target,
      outcome: 'moved',
      account: 'in the wal',
    });
  });

  it('after a crash right after the rename, starts on the OS folder', async () => {
    const { home, target, checkout } = machine();
    const project = checkout('project', 'moved');

    expect((await start({ home, root: project, kill: 'afterRename' }).exited).signal).toBe(
      'SIGKILL',
    );
    expect(existsSync(join(project, '.data'))).toBe(false);

    expect((await finished(start({ home, root: project }))).at(-2)).toMatchObject({
      directory: target,
      outcome: null,
      account: 'moved',
    });
  });

  it('after a first start died before its first migration, starts that database afresh', async () => {
    const { home, target, checkout } = machine();
    const project = checkout('project');

    expect((await start({ home, root: project, kill: 'afterCreate' }).exited).signal).toBe(
      'SIGKILL',
    );
    expect(existsSync(join(target, 'review-desk.sqlite'))).toBe(true);

    expect((await finished(start({ home, root: project }))).at(-2)).toMatchObject({
      directory: target,
      outcome: null,
      account: null,
    });
  });

  it('keeps an agent from starting in a workspace while it moves, or in the old one after', async () => {
    const { root, home, checkout } = machine();
    const project = checkout('project', 'mine');
    const workspace = join(project, '.data', 'ai-runs', 'run-1');
    const lockPath = join(project, '.data', 'ai-runs', '.locks', 'run-1.lock');
    const resume = join(root, 'resume');

    mkdirSync(workspace, { recursive: true });

    // A supervisor that reaches its lock late, as one spawned just before its server died.
    const supervisor = async () => {
      const child = spawn(
        process.execPath,
        ['--import', 'tsx', join(serverRoot, 'src/ai/agent-supervisor.ts'), lockPath, 'true'],
        {
          env: { ...process.env, TSX_TSCONFIG_PATH: join(serverRoot, 'tsconfig.json') },
          stdio: ['ignore', 'ignore', 'pipe'],
        },
      );
      let stderr = '';

      child.stderr!.on('data', (data: Buffer) => (stderr += data.toString()));

      const code = await new Promise<number | null>((resolve) => child.once('exit', resolve));

      return { code, stderr };
    };
    const mover = start({ home, root: project, pauseFile: resume });

    await mover.until((line) => line.paused === true);
    // While the move holds the run's lock.
    expect(await supervisor()).toMatchObject({
      code: 75,
      stderr: expect.stringContaining('still running'),
    });

    writeFileSync(resume, '');
    expect((await finished(mover)).at(-2)).toMatchObject({ outcome: 'moved' });

    // After it: the old workspace is gone, so nothing runs there.
    expect(await supervisor()).toMatchObject({
      code: 75,
      stderr: expect.stringContaining('is gone'),
    });
  });
});
