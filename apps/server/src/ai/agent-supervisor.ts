/**
 * Runs one AI agent for the Review Desk server, as the leader of the agent's process group, and
 * ends that group as soon as the server is gone, however the server ended (SIGKILL included).
 *
 * Arguments: `<lock file | -> <command> [args...]`. The agent gets this process's stdin, stdout and
 * stderr. File descriptor 3 is the lifeline: the server never writes to it, and the operating
 * system closes the server's end when the server exits, which this process sees as the end of the
 * stream. While this process lives it holds an exclusive lock on the lock file, released by the
 * operating system when it exits; a busy lock is how the server knows a run's agent is still
 * running, without trusting a process id that may have moved on to another process.
 *
 * Only Node's built-in modules, so it runs as plain JavaScript from `dist` and, with Node's type
 * stripping, straight from source in development and tests.
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { Socket } from 'node:net';
import { constants } from 'node:os';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [lockPath, command, ...args] = process.argv.slice(2);

/** Ends the whole process group, this process included. */
function endGroup(): void {
  try {
    process.kill(-process.pid, 'SIGKILL');
  } catch {
    process.exit(1);
  }
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
}

// The server's end closes when it exits; everything in this group then ends with it.
const lifeline = new Socket({ fd: 3, readable: true, writable: false });

lifeline.on('end', endGroup);
lifeline.on('error', endGroup);
lifeline.resume();

// The agent joins this process group, so stopping the group stops it and its helpers.
const agent = spawn(command, args, { stdio: 'inherit' });

agent.on('error', (error) => {
  process.stderr.write(`Could not start ${command}: ${error.message}\n`);
  process.exit(127);
});

// The server stops a run with SIGTERM to the group, then SIGKILL. The agent gets both; this
// process stays until the agent has exited, so the lock says it is still running until then.
process.on('SIGTERM', () => {});
process.on('SIGINT', () => {});

agent.on('exit', (code, signal) => {
  const number = signal ? (constants.signals as Record<string, number>)[signal] : undefined;

  // Released by exiting; closed here only to say so.
  lock?.close();
  process.exit(code ?? (number ? 128 + number : 1));
});
