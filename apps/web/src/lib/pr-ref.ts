export interface PrRef {
  owner: string;
  repo: string;
  number: number;
}

export function refOf(item: { repository: string; number: number }): PrRef {
  const [owner, repo] = item.repository.split('/');

  return { owner, repo, number: item.number };
}

export function sameRef(item: { repository: string; number: number }, ref: PrRef): boolean {
  return (
    item.number === ref.number &&
    item.repository.toLowerCase() === `${ref.owner}/${ref.repo}`.toLowerCase()
  );
}

/**
 * Parses a PR reference: a GitHub PR link such as https://github.com/acme/api/pull/12/files, or
 * the short forms `acme/api#12` and `acme/api/pull/12`.
 */
export function parsePrRef(text: string): PrRef | null {
  const value = text.trim();
  const match =
    /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(value) ??
    /^([\w.-]+)\/([\w.-]+)(?:#|\/pull\/)(\d+)$/i.exec(value);

  return match && Number(match[3]) > 0
    ? { owner: match[1], repo: match[2], number: Number(match[3]) }
    : null;
}

/** `owner/repo#number`, as GitHub writes a PR reference. */
export const formatRef = (ref: PrRef) => `${ref.owner}/${ref.repo}#${ref.number}`;
