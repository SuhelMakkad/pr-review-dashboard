import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { macosNotifier, escapeForNotifier } from '@/notify/macos.js';
import { runCheck, type Exec } from '@/service/check.js';
import {
  check,
  install,
  installedJob,
  restart,
  servicePaths,
  status,
  uninstall,
  type ServiceHost,
} from '@/service/cli.js';
import { servicePath, servicePlist } from '@/service/plist.js';

const cleanups: (() => void)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe('the service’s PATH', () => {
  it('starts with the selected Node’s real folder, and keeps only real, absolute folders once', () => {
    const real = (path: string) => {
      if (path.includes('missing')) throw new Error('ENOENT');

      // A version manager's per-shell link, resolved to its persistent folder.
      return path.replace('/fnm_multishells/123', '/fnm/node-versions/v24/installation');
    };

    expect(
      servicePath(
        [
          '/opt/homebrew/bin',
          '',
          'relative/bin',
          '/repo/node_modules/.bin',
          '/missing/bin',
          '/opt/homebrew/bin',
          '/Users/you/.local/state/fnm_multishells/123/bin',
        ].join(':'),
        '/Users/you/.local/state/fnm_multishells/123/bin/node',
        real,
      ),
    ).toBe(
      ['/Users/you/.local/state/fnm/node-versions/v24/installation/bin', '/opt/homebrew/bin'].join(
        ':',
      ),
    );
  });
});

describe('the service’s plist', () => {
  const job = {
    label: 'dev.reviewdesk.server',
    program: ['/node', '/repo & co/apps/server/dist/index.js'],
    cwd: '/repo & co',
    env: { PATH: '/a:/b', REVIEW_DESK_READY_FILE: '/logs/ready.json' },
    stdout: '/logs/out.log',
    stderr: '/logs/err.log',
  };

  it('restarts the service after a crash, never after a clean stop, and escapes every value', () => {
    const plist = servicePlist({ ...job, keepAlive: true });

    expect(plist).toContain('<string>/repo &amp; co/apps/server/dist/index.js</string>');
    expect(plist).toMatch(
      /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/,
    );
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(plist).toMatch(/<key>ExitTimeOut<\/key>\s*<integer>30<\/integer>/);
    expect(plist).toContain('<key>REVIEW_DESK_READY_FILE</key>');
  });

  it('runs a one-off job once, only when started', () => {
    const plist = servicePlist({ ...job, keepAlive: false });

    expect(plist).not.toContain('KeepAlive');
    expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<false\/>/);
  });
});

describe('native notifications', () => {
  it('escapes a value its notifier would read as something else, and only those', () => {
    for (const first of ['-', '[', '(', '{', '"', '\\'])
      expect(escapeForNotifier(`${first}x`)).toBe(`\\${first}x`);

    expect(escapeForNotifier('Fix [bug] (soon) -now')).toBe('Fix [bug] (soon) -now');
  });

  it('opens the PR through terminal-notifier, and says when a send failed', async () => {
    const calls: [string, string[]][] = [];
    let sends = 0;
    const { notify } = macosNotifier('http://127.0.0.1:4317', async (command, args) => {
      calls.push([command, args]);

      if (command === 'terminal-notifier' && args[0] === '-version')
        return { ok: true, stdout: 'terminal-notifier 3.1.0.\n' };

      return { ok: ++sends === 1, stdout: '' };
    });
    const notification = {
      title: '-api#7 · Fix',
      body: 'New reply',
      path: '/pr/acme/api/7',
      key: 'k1',
    };

    expect(await notify(notification)).toBe('sent');
    expect(calls[1]).toEqual([
      'terminal-notifier',
      [
        '-title',
        '\\-api#7 · Fix',
        '-subtitle',
        'Review Desk',
        '-message',
        'New reply',
        '-group',
        'k1',
        '-open',
        'http://127.0.0.1:4317/pr/acme/api/7',
      ],
    ]);
    // Denied, or timed out: reported, never thrown.
    expect(await notify(notification)).toBe('failed');
  });

  it('does not count on terminal-notifier before 3.0 to open the PR', async () => {
    const calls: string[] = [];
    const { notify } = macosNotifier('http://127.0.0.1:4317', async (command, args) => {
      calls.push(`${command} ${args[0]}`);

      return {
        ok: true,
        stdout: command === 'terminal-notifier' ? 'terminal-notifier 2.0.0\n' : '',
      };
    });

    expect(await notify({ title: 't', body: 'b', path: '/inbox/attention', key: 'k' })).toBe(
      'sent',
    );
    expect(calls).toEqual(['terminal-notifier -version', 'osascript -e']);
  });

  it('falls back to AppleScript, which only shows a notification', async () => {
    const calls: string[] = [];
    const { notify } = macosNotifier('http://127.0.0.1:4317', async (command) => {
      calls.push(command);

      return { ok: command === 'osascript', stdout: '' };
    });

    expect(await notify({ title: 't', body: 'b', path: '/inbox/attention', key: 'k' })).toBe(
      'sent',
    );
    expect(calls).toEqual(['terminal-notifier', 'osascript']);
  });
});

describe('the check job’s report', () => {
  const answering =
    (
      answers: Record<string, { status: number | null; stdout: string }>,
      log: string[] = [],
    ): Exec =>
    (command, args) => {
      const key = `${command} ${args.join(' ')}`;

      log.push(key);

      for (const [prefix, answer] of Object.entries(answers))
        if (key.startsWith(prefix)) return answer;

      return { status: 1, stdout: '' };
    };

  it('reports each tool and sign-in without tokens, and round-trips its own Keychain item', () => {
    const log: string[] = [];
    let secret = '';
    const run: Exec = (command, args) => {
      if (args[0] === 'add-generic-password') secret = args[args.indexOf('-w') + 1]!;
      if (args[0] === 'find-generic-password') return { status: 0, stdout: `${secret}\n` };

      return answering(
        {
          '/usr/bin/which gh': { status: 0, stdout: '/opt/homebrew/bin/gh\n' },
          '/usr/bin/which glab': { status: 0, stdout: '/opt/homebrew/bin/glab\n' },
          'glab --version': { status: 0, stdout: 'glab 1.124.0\n' },
          'glab auth status': {
            status: 0,
            stdout: JSON.stringify({
              hosts: [{ host: 'gitlab.com', state: 'success', token: 'glpat-secret' }],
            }),
          },
          'gh --version': { status: 0, stdout: 'gh version 2.80.0\n' },
          'gh auth status --help': { status: 0, stdout: 'usage' },
          'gh auth status --json hosts': {
            status: 0,
            stdout: JSON.stringify({
              hosts: {
                'github.com': [
                  { login: 'you', active: true, state: 'success', token: 'gho_secret' },
                ],
              },
            }),
          },
          '/usr/bin/security add-generic-password': { status: 0, stdout: '' },
          '/usr/bin/security delete-generic-password': { status: 0, stdout: '' },
        },
        log,
      )(command, args);
    };
    const contexts: unknown[] = [];
    const report = runCheck(
      'check-1',
      (command, args, context) => {
        if (command === 'glab' && args[0] === 'auth') contexts.push(context);

        return run(command, args, context);
      },
      { cwd: () => '/glab-home', env: () => ({ GLAB_NO_PROMPT: '1' }) },
    );

    expect(report.tools.gh).toEqual({ path: '/opt/homebrew/bin/gh', version: 'gh version 2.80.0' });
    expect(report.gitlab).toEqual([{ host: 'gitlab.com', ok: true }]);
    expect(JSON.stringify(report)).not.toContain('glpat-secret');
    // As the server runs glab: its own working folder and environment.
    expect(contexts).toEqual([{ cwd: '/glab-home', env: { GLAB_NO_PROMPT: '1' } }]);
    expect(report.clickThrough).toBe(false);
    expect(report.github).toEqual([{ host: 'github.com', login: 'you', active: true, ok: true }]);
    expect(JSON.stringify(report)).not.toContain('gho_secret');
    expect(report.keychain).toBe('ok');
    expect(report.leftovers).toEqual([]);
    // Its own item, by exact service and account; nothing else is read.
    expect(log.filter((line) => line.startsWith('/usr/bin/security'))).toEqual([
      expect.stringMatching(
        /^\/usr\/bin\/security add-generic-password -s Review Desk check -a check-1 -w [0-9a-f]{64}$/,
      ),
      '/usr/bin/security delete-generic-password -s Review Desk check -a check-1',
    ]);
  });

  it('names a Keychain item it could not remove', () => {
    const report = runCheck(
      'check-2',
      answering({
        '/usr/bin/security add-generic-password': { status: 0, stdout: '' },
        '/usr/bin/security find-generic-password': { status: 0, stdout: 'other\n' },
      }),
    );

    expect(report.keychain).toBe('mismatch');
    expect(report.leftovers).toEqual(['Keychain item "Review Desk check" for check-2']);
  });
});

/** A machine of our own for the CLI: a temp home and checkout, and a scripted launchd. */
function machine(
  script: (
    args: string[],
    host: ServiceHost,
  ) => { status: number; stdout?: string; stderr?: string },
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'rd-service-')));
  const repo = join(root, 'repo');
  const calls: string[] = [];
  const said: string[] = [];
  const forgotten: string[] = [];
  let clock = 0;

  mkdirSync(join(repo, 'apps', 'server', 'dist', 'service'), { recursive: true });
  writeFileSync(join(repo, 'apps', 'server', 'dist', 'index.js'), '');
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));

  const host: ServiceHost = {
    platform: 'darwin',
    home: join(root, 'home'),
    uid: 501,
    repo,
    node: '/usr/local/bin/node',
    shellPath: '/usr/bin',
    dataFolders: [],
    launchctl: (args) => {
      calls.push(args.join(' '));

      const answer = script(args, host);

      return { status: answer.status, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' };
    },
    status: async () => ({ bootId: 'boot-1' }),
    alive: () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    say: (line) => said.push(line),
    forget: (service, account) => {
      forgotten.push(`${service}/${account}`);

      return true;
    },
  };

  return { host, calls, said, forgotten, repo };
}

const publish = (host: ServiceHost) => {
  const { ready: file } = servicePaths(host);

  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ bootId: 'boot-1', pid: 9, port: 4317 }));
};

describe('pnpm service', () => {
  it('installs, and is ready once the job it started says so', async () => {
    let loaded = false;
    const { host, said } = machine((args, host) => {
      if (args[0] === 'print')
        return { status: loaded ? 0 : 113, stdout: 'state = running\npid = 9\n' };
      if (args[0] === 'bootstrap') {
        loaded = true;
        publish(host);
      }

      return { status: 0 };
    });

    await install(host);

    expect(said.at(-1)).toBe('Review Desk runs as a service → http://127.0.0.1:4317');
    expect(readFileSync(servicePaths(host).plist, 'utf8')).toContain('dev.reviewdesk.server');
  });

  it('undoes only what a failed install did', async () => {
    // Loaded by it, then never ready: it unloads its job and removes its plist.
    const unready = machine((args) => ({ status: args[0] === 'print' ? 113 : 0 }));

    await expect(install(unready.host)).rejects.toThrow('did not become ready');
    expect(unready.calls).toContain('bootout gui/501/dev.reviewdesk.server');
    expect(existsSync(servicePaths(unready.host).plist)).toBe(false);

    // Its bootstrap refused: nothing of launchd's is undone, only the plist it wrote.
    const refused = machine((args) => ({
      status: args[0] === 'bootstrap' ? 5 : args[0] === 'print' ? 113 : 0,
    }));

    await expect(install(refused.host)).rejects.toThrow('bootstrap failed');
    expect(refused.calls).not.toContain('bootout gui/501/dev.reviewdesk.server');
    expect(existsSync(servicePaths(refused.host).plist)).toBe(false);
  });

  it('is not ready on a record from another boot', async () => {
    const stale = machine((args, host) => {
      if (args[0] === 'print') return { status: 113 };
      if (args[0] === 'bootstrap') publish(host);

      return { status: 0 };
    });

    // The server answers as a boot other than the one the record names.
    stale.host.status = async () => ({ bootId: 'some-other-boot' });
    await expect(install(stale.host)).rejects.toThrow('did not become ready');
  });

  it('refuses to install over another setup, or before the server is built', async () => {
    const other = machine(() => ({ status: 113 }));

    mkdirSync(join(other.host.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(servicePaths(other.host).plist, '<plist>someone else’s</plist>');
    await expect(install(other.host)).rejects.toThrow('another setup');
    expect(readFileSync(servicePaths(other.host).plist, 'utf8')).toContain('someone else');

    const unbuilt = machine(() => ({ status: 113 }));

    rmSync(join(unbuilt.repo, 'apps', 'server', 'dist', 'index.js'));
    await expect(install(unbuilt.host)).rejects.toThrow('pnpm build');
  });

  it('restarts by stopping gracefully, waiting for the old process, then starting again', async () => {
    let alive = 3;
    let loaded = true;
    const { host, calls } = machine((args, host) => {
      if (args[0] === 'print')
        return loaded ? { status: 0, stdout: 'state = running\npid = 9\n' } : { status: 113 };
      if (args[0] === 'bootout') loaded = false;
      // Started again only once the old process is gone.
      if (args[0] === 'bootstrap') {
        if (alive > 0) return { status: 1, stderr: 'still running' };

        loaded = true;
        publish(host);
      }

      return { status: 0 };
    });

    host.alive = () => alive-- > 0;
    mkdirSync(join(host.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(servicePaths(host).plist, 'plist');

    await restart(host);

    expect(calls.filter((call) => !call.startsWith('print'))).toEqual([
      'bootout gui/501/dev.reviewdesk.server',
      `bootstrap gui/501 ${servicePaths(host).plist}`,
    ]);
    expect(calls.join('\n')).not.toContain('kickstart -k');
  });

  it('never reports a stop launchd did not make, nor removes the plist of a job it still runs', async () => {
    // Uninstall: bootout refused, and the job still loaded.
    const stuck = machine((args) => ({
      status: args[0] === 'bootout' ? 5 : 0,
      stdout: 'state = running\n',
    }));

    mkdirSync(join(stuck.host.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(servicePaths(stuck.host).plist, 'plist');
    await expect(uninstall(stuck.host)).rejects.toThrow('did not stop');
    expect(existsSync(servicePaths(stuck.host).plist)).toBe(true);

    // A failed install whose job cannot be unloaded keeps its plist, and says so.
    let loaded = false;
    const unremovable = machine((args) => {
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'print') return { status: loaded ? 0 : 113 };

      return { status: 0 };
    });

    await expect(install(unremovable.host)).rejects.toThrow('could not be unloaded');
    expect(existsSync(servicePaths(unremovable.host).plist)).toBe(true);
  });

  it('keeps the service’s logs private', async () => {
    let loaded = false;
    const { host } = machine((args, host) => {
      if (args[0] === 'print') return { status: loaded ? 0 : 113, stdout: 'pid = 9\n' };
      if (args[0] === 'bootstrap') {
        loaded = true;
        publish(host);
      }

      return { status: 0 };
    });

    await install(host);

    for (const log of [servicePaths(host).out, servicePaths(host).err])
      expect(statSync(log).mode & 0o777).toBe(0o600);
  });

  it('vouches only for the service: another process answering on its port is not it', async () => {
    const { host, said } = machine((args) =>
      args[0] === 'print' ? { status: 0, stdout: 'state = running\npid = 10\n' } : { status: 0 },
    );

    publish(host);
    await status(host);

    expect(said).toContain('Not answering as the service yet.');
    expect(said.join('\n')).not.toContain('Linear');
  });

  it('checks with the installed service’s settings, and names what it could not remove', async () => {
    const seen: string[] = [];
    let loaded = false;
    const { host, said } = machine((args) => {
      if (args[0] === 'bootstrap') {
        loaded = true;
        seen.push(readFileSync(args[2]!, 'utf8'));
      }
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'print') return { status: loaded ? 0 : 113 };

      return { status: 0 };
    });

    host.node = '/shell/node';
    mkdirSync(join(host.home, 'Library', 'LaunchAgents'), { recursive: true });
    writeFileSync(
      servicePaths(host).plist,
      servicePlist({
        label: 'dev.reviewdesk.server',
        program: ['/installed/node', '/installed/repo/apps/server/dist/index.js'],
        cwd: '/installed/repo',
        env: { PATH: '/installed/bin' },
        stdout: '/o',
        stderr: '/e',
        keepAlive: true,
      }),
    );
    host.forget = () => false;

    expect(installedJob(host)).toEqual({
      node: '/installed/node',
      cwd: '/installed/repo',
      path: '/installed/bin',
    });
    await check(host);

    expect(seen[0]).toContain('<string>/installed/node</string>');
    expect(seen[0]).toContain('<string>/installed/bin</string>');
    expect(seen[0]).not.toContain('/shell/node');
    expect(said).toContainEqual(
      expect.stringMatching(/^Could not remove the Keychain item "Review Desk check" for check-/),
    );
  });

  it('runs the check once and leaves nothing behind, whether or not it reported', async () => {
    let loaded = false;
    const { host, calls, forgotten } = machine((args) => {
      if (args[0] === 'bootstrap') loaded = true;
      if (args[0] === 'bootout') loaded = false;
      if (args[0] === 'print') return { status: loaded ? 0 : 113 };

      return { status: 0 };
    });

    expect(await check(host)).toBeNull();
    expect(
      calls.some((call) => /^kickstart gui\/501\/dev\.reviewdesk\.check\.[0-9a-f]+$/.test(call)),
    ).toBe(true);
    expect(calls.some((call) => call.startsWith('bootout gui/501/dev.reviewdesk.check.'))).toBe(
      true,
    );
    expect(loaded).toBe(false);
    expect(forgotten).toEqual([expect.stringMatching(/^Review Desk check\/check-[0-9a-f]+$/)]);
  });
});
