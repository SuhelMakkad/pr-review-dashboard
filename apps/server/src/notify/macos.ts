import { execFile } from 'node:child_process';
import { log } from '@/log.js';
import { supportsClickThrough } from '@/notify/terminal-notifier.js';

/** One native notification: its texts, where clicking it goes, and its key (one per PR event). */
export interface NativeNotification {
  title: string;
  body: string;
  /** The app path it is about, such as `/pr/acme/api/42/files`. */
  path: string;
  key: string;
}

export type Delivery = 'sent' | 'failed';
export type NativeNotify = (notification: NativeNotification) => Promise<Delivery | void>;

/** Runs a command with arguments (never a shell), bounded: whether it exited 0 in time, and what it printed. */
export type Runner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<{ ok: boolean; stdout: string }>;

const run: Runner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs }, (error, stdout) =>
      resolve({ ok: !error, stdout: String(stdout ?? '') }),
    );
  });

/**
 * A value terminal-notifier reads as written. Its argument parser reads a value that starts with
 * `-`, `[`, `(`, `{`, `"` or `\` as something else (a flag, a property list), unless that first
 * character is escaped with one backslash, which it removes.
 */
export function escapeForNotifier(value: string): string {
  return /^[-[({"\\]/.test(value) ? `\\${value}` : value;
}

/**
 * Native macOS notifications, sent while no Review Desk window is open. Through terminal-notifier
 * when it is installed, clicking one opens its PR at `origin`; otherwise through AppleScript,
 * whose notifications only show (clicking opens Script Editor). Texts are arguments, never part of
 * a script or a shell command, so PR titles cannot inject commands. Each send is bounded, and says
 * whether it went out.
 */
export function macosNotifier(origin: string, runner: Runner = run) {
  let clickThrough: Promise<boolean> | null = null;
  const opensPr = () =>
    (clickThrough ??= runner('terminal-notifier', ['-version'], 5_000).then(
      (answer) => answer.ok && supportsClickThrough(answer.stdout),
    ));

  const notify: NativeNotify = async ({ title, body, path, key }) => {
    const shortTitle = title.slice(0, 120);
    const shortBody = body.slice(0, 240);
    const deliverer = (await opensPr()) ? 'terminal-notifier' : 'osascript';
    const { ok: sent } =
      deliverer === 'terminal-notifier'
        ? await runner(
            'terminal-notifier',
            [
              '-title',
              escapeForNotifier(shortTitle),
              '-subtitle',
              'Review Desk',
              '-message',
              escapeForNotifier(shortBody),
              '-group',
              key,
              '-open',
              `${origin}${path}`,
            ],
            10_000,
          )
        : await runner(
            'osascript',
            [
              '-e',
              'on run argv',
              '-e',
              'display notification (item 2 of argv) with title (item 1 of argv) subtitle "Review Desk"',
              '-e',
              'end run',
              '--',
              shortTitle,
              shortBody,
            ],
            5_000,
          );
    const outcome: Delivery = sent ? 'sent' : 'failed';

    // At the default level either way: `pnpm service status` reads the last one.
    log.event(sent ? 'info' : 'warn', 'notify.native', { deliverer, outcome });

    return outcome;
  };

  return { notify, opensPr };
}
