import { log, type EventFields, type ForgeOp } from '@/log.js';

/** A request slower than this is worth seeing without debug logging. */
const SLOW_MS = 5000;

/**
 * Logs one `gh` or `glab` request's timings: the credential lookup (GitHub), starting the
 * process, the child's own run (the CLI's start-up, its sign-in, the remote call, the response
 * and the pipes), and the whole request. The CLIs do not say how much of their run was the remote
 * call, so nothing here is labelled remote.
 */
export function forgeRequest(
  forge: 'github' | 'gitlab',
  op: ForgeOp,
  timings: Omit<EventFields<'forge.request'>, 'forge' | 'op'>,
): void {
  log.event((timings.totalMs ?? 0) > SLOW_MS ? 'info' : 'debug', 'forge.request', {
    forge,
    op,
    ...timings,
  });
}
