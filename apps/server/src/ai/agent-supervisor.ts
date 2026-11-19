/**
 * Runs one AI agent for the Review Desk server, as the leader of the agent's process group, and is
 * the only process that ever signals that group: a group id is never reused while its leader
 * lives, so every signal reaches this agent's processes and nothing else.
 *
 * Arguments: `<lock file | -> <command> [args...]`. The agent gets this process's stdin, stdout and
 * stderr. File descriptor 3 is the control line to the server:
 * - the server writes `stop` to stop the agent: the group gets SIGTERM, then SIGKILL five seconds
 *   later if the agent is still running;
 * - this process writes `exit <code>` or `signal <name>` once the agent has exited;
 * - the server's end closes when the server exits, however it exits (SIGKILL included), and the
 *   group then ends at once.
 *
 * Given a lock file, it holds an exclusive lock on it for as long as it lives; the operating system
 * releases it when this process ends. It ends only together with its whole group (after the agent
 * exits, the group gets SIGKILL with this process in it), so a free lock means no process of the
 * run's agent is left. A second supervisor for a run whose lock is held exits with 75 and starts
 * nothing.
 *
 * Only Node's built-in modules, so it runs as plain JavaScript from `dist` and, with Node's type
 * stripping, straight from source in development and tests.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { Socket } from 'node:net';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** How long a stopped agent gets to exit after SIGTERM before the group gets SIGKILL. */
const STOP_GRACE_MS = 5_000;

const [lockPath, command, ...args] = process.argv.slice(2);

/** Ends the whole process group, this process included; the run's lock is released with it. */
function endGroup(): never {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    // Not the group's leader (started by hand): ending this process still releases the lock.
  }

  process.exit(1);
}

if (!command) {
  process.stderr.write('agent-supervisor: no command given\n');
  process.exit(64);
}

/** The run's lock, referenced for this process's lifetime so it is never closed early. */
let lock: DatabaseSync | null = null;

if (lockPath && lockPath !== '-') {
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });

  try {
    lock = new DatabaseSync(lockPath, { timeout: 0 });
    lock.exec('PRAGMA locking_mode = EXCLUSIVE');
    lock.exec('BEGIN EXCLUSIVE');
  } catch {
    // Another agent for the same run is still running: never two at once.
    process.stderr.write('An agent for this run is still running.\n');
    process.exit(75);
  }

  // A connection nothing refers to is garbage, and collecting it would release the lock early: a
  // listener that lives as long as the process keeps it referenced until the process ends.
  process.on('exit', () => lock?.close());
}

const control = new Socket({ fd: 3, readable: true, writable: true });
let stopping = false;
let buffered = '';

control.on('data', (chunk: Buffer) => {
  buffered += chunk.toString('utf8');

  let newline = buffered.indexOf('\n');

  while (newline !== -1) {
    const line = buffered.slice(0, newline).trim();

    buffered = buffered.slice(newline + 1);

    if (line === 'stop' && !stopping) {
      stopping = true;

      // This process ignores SIGTERM below; the agent and its helpers get it.
      try {
        process.kill(-process.pid, 'SIGTERM');
      } catch {
        // Nothing left to stop.
      }

      setTimeout(endGroup, STOP_GRACE_MS).unref();
    }

    newline = buffered.indexOf('\n');
  }
});
// The server is gone: so is everything it started.
control.on('end', endGroup);
control.on('error', endGroup);

process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});
process.on('SIGHUP', () => {});

// The agent joins this process group, so the group's signals reach it and its helpers.
const agent = spawn(command, args, { stdio: 'inherit' });

agent.on('error', (error) => {
  process.stderr.write(`Could not start ${command}: ${error.message}\n`);
  control.end('exit 127\n', endGroup);
});

// Tells the server how the agent ended, then ends what it left in the group, this process last:
// the lock is released only with the group gone.
agent.on('exit', (code, signal) => {
  const status = signal ? `signal ${signal}\n` : `exit ${code ?? 1}\n`;

  control.write(status, endGroup);
});
