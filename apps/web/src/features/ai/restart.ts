import { AUTO_REVIEW_QUIET_MS } from '@review-desk/shared/ai';

/** How long a PR must go without new commits before a stopped automatic review restarts. */
export const quietMinutes = Math.round(AUTO_REVIEW_QUIET_MS / 60_000);

/** When a stopped automatic review starts again: "around 14:32", or "shortly" once it is due. */
export function restartPhrase(restartAt: string, now = Date.now()): string {
  if (Date.parse(restartAt) - now < 60_000) return 'shortly';

  const time = new Date(restartAt).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  });

  return `around ${time}`;
}

/** Why an automatic review stopped and when the fresh one starts. */
export function restartCopy(restartAt: string, now = Date.now()): string {
  return `New commits arrived while the automatic review was running, so it stopped. A fresh review of the latest commits starts ${restartPhrase(restartAt, now)}, once the PR has had no new commits for ${quietMinutes} minutes.`;
}
