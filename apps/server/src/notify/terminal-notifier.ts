/**
 * Whether `terminal-notifier -version` printed a version that opens a URL on click: 3.x or later,
 * whose `-open` and escaping rules Review Desk relies on. Shared by the sender and `pnpm service
 * check`, so both say the same.
 */
export function supportsClickThrough(versionOutput: string): boolean {
  const major = /(\d+)\.\d+/.exec(versionOutput)?.[1];

  return major !== undefined && Number(major) >= 3;
}
