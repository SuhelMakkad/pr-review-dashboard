import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';
import type { DataDirectoryLocked } from '@/db/lock.js';

/** The launchd label the service runs under (`pnpm service install`). */
export const SERVICE_LABEL = 'dev.reviewdesk.server';

/** The service's pid as launchd reports it, or null: best-effort, from `launchctl print`. */
export function servicePid(): number | null {
  if (process.platform !== 'darwin') return null;

  const printed = spawnSync('launchctl', ['print', `gui/${process.getuid?.()}/${SERVICE_LABEL}`], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  const pid = /^\s*pid = (\d+)\s*$/m.exec(printed.stdout ?? '')?.[1];

  return printed.status === 0 && pid ? Number(pid) : null;
}

/** Said when the folder's owner is the service, so the person knows what is holding it. */
export function serviceHint(error: DataDirectoryLocked): string {
  return error.ownerPid !== null && error.ownerPid === servicePid()
    ? '\nIt runs as a service: see `pnpm service status`, or stop it with `pnpm service uninstall`.'
    : '';
}

/**
 * Tells `pnpm service install` and `restart` that this start is ready, when they asked by setting
 * `REVIEW_DESK_READY_FILE`: written whole, once the server listens.
 */
export function publishReadiness(
  path: string | undefined,
  ready: { bootId: string; pid: number; port: number },
): void {
  if (!path) return;

  const draft = `${path}.${process.pid}.tmp`;

  writeFileSync(draft, JSON.stringify(ready), { mode: 0o600 });
  renameSync(draft, path);
}
