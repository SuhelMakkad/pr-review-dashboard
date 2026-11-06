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

/** Parses GitHub PR URLs such as https://github.com/acme/api/pull/12/files. */
export function parsePrUrl(text: string): PrRef | null {
  const match = /github\.com\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)/i.exec(text.trim());

  return match ? { owner: match[1], repo: match[2], number: Number(match[3]) } : null;
}
