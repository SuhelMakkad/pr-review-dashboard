import { createHash } from 'node:crypto';

/** A short, stable digest; used to notice that something GitLab returned has changed. */
export function fingerprint(value: unknown): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);

  return createHash('sha256').update(text).digest('hex').slice(0, 32);
}
