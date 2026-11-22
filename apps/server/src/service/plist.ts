import { realpathSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';

/**
 * The `PATH` a launchd job gets, so `gh`, `glab`, `codex`, `claude` and `terminal-notifier`
 * resolve as in a terminal: the selected Node's own folder first, then the installing shell's
 * entries, each resolved to the folder it really is, so a version manager's per-shell link (fnm's
 * `fnm_multishells`) becomes its persistent target. Empty, relative and missing entries go, as do
 * `node_modules/.bin` folders and repeats.
 */
export function servicePath(
  shellPath: string | undefined,
  execPath: string,
  resolve: (path: string) => string = realpathSync,
): string {
  const real = (path: string): string | null => {
    try {
      return resolve(path);
    } catch {
      return null;
    }
  };
  const entries = [dirname(real(execPath) ?? execPath)];

  for (const entry of (shellPath ?? '').split(':')) {
    if (!entry || !isAbsolute(entry) || entry.split('/').includes('node_modules')) continue;

    const resolved = real(entry);

    if (resolved && !entries.includes(resolved)) entries.push(resolved);
  }

  return entries.join(':');
}

export interface ServiceJob {
  label: string;
  program: string[];
  cwd: string;
  env: Record<string, string>;
  stdout: string;
  stderr: string;
  /** The service: started at login and after a crash. Otherwise run once, when kickstarted. */
  keepAlive: boolean;
}

const escape = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

const string = (value: string) => `<string>${escape(value)}</string>`;

/** The launchd property list for `job`: plain XML, every value escaped. */
export function servicePlist(job: ServiceJob): string {
  const env = Object.entries(job.env)
    .map(([key, value]) => `      <key>${escape(key)}</key>\n      ${string(value)}`)
    .join('\n');
  const lifetime = job.keepAlive
    ? [
        '    <key>RunAtLoad</key>',
        '    <true/>',
        // Started again after a crash or a failed start, never after a clean stop.
        '    <key>KeepAlive</key>',
        '    <dict>',
        '      <key>SuccessfulExit</key>',
        '      <false/>',
        '    </dict>',
      ]
    : ['    <key>RunAtLoad</key>', '    <false/>'];

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '  <dict>',
    '    <key>Label</key>',
    `    ${string(job.label)}`,
    '    <key>ProgramArguments</key>',
    '    <array>',
    ...job.program.map((argument) => `      ${string(argument)}`),
    '    </array>',
    '    <key>WorkingDirectory</key>',
    `    ${string(job.cwd)}`,
    '    <key>EnvironmentVariables</key>',
    '    <dict>',
    env,
    '    </dict>',
    ...lifetime,
    '    <key>ThrottleInterval</key>',
    '    <integer>10</integer>',
    // Beyond the server's own 20 s drain, and the log's close after it.
    '    <key>ExitTimeOut</key>',
    '    <integer>30</integer>',
    '    <key>ProcessType</key>',
    '    <string>Interactive</string>',
    '    <key>StandardOutPath</key>',
    `    ${string(job.stdout)}`,
    '    <key>StandardErrorPath</key>',
    `    ${string(job.stderr)}`,
    '  </dict>',
    '</plist>',
    '',
  ].join('\n');
}
