import { execFile } from 'node:child_process';

/**
 * Shows a native macOS notification. Text is passed as arguments to a fixed AppleScript, never
 * interpolated into the script, so PR titles cannot inject commands.
 */
export function macosNotify(title: string, body: string): Promise<void> {
  return new Promise((resolve) => {
    execFile(
      'osascript',
      [
        '-e',
        'on run argv',
        '-e',
        'display notification (item 2 of argv) with title (item 1 of argv) subtitle "Review Desk"',
        '-e',
        'end run',
        '--',
        title.slice(0, 120),
        body.slice(0, 240),
      ],
      { timeout: 5000 },
      () => resolve(),
    );
  });
}
