/** Linear-style ticket references found in a PR's branch, title and description. */

export interface TicketRef {
  identifier: string;
  source: 'link' | 'branch' | 'title' | 'body';
}

const IDENTIFIER = /(?<![A-Za-z0-9])([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?![A-Za-z0-9])/g;
const LINK = /linear\.app\/[\w-]+\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-\d{1,6})/gi;

/** Standards and encodings that look like ticket ids but never are. */
const LOOK_ALIKES = new Set([
  ...[
    'UTF',
    'SHA',
    'ISO',
    'RFC',
    'MD',
    'AES',
    'RSA',
    'HTTP',
    'TLS',
    'SSL',
    'X',
    'CVE',
    'GPT',
    'ES',
    'PEP',
    'IPV',
  ],
  ...['HS', 'BASE', 'COVID', 'WCAG', 'H', 'E', 'P', 'V'],
  // Common branch words that are never team keys.
  ...[
    'RELEASE',
    'HOTFIX',
    'ISSUE',
    'ISSUES',
    'BUG',
    'PR',
    'VERSION',
    'PATCH',
    'FIX',
    'FEAT',
    'CHORE',
    'DEPS',
  ],
  ...[
    'BUMP',
    'UPDATE',
    'DEPENDABOT',
    'RENOVATE',
    'REVERT',
    'SPIKE',
    'TEST',
    'DOCS',
    'WIP',
    'STEP',
    'PHASE',
  ],
]);

function add(
  found: TicketRef[],
  identifier: string,
  source: TicketRef['source'],
  teamKeys: Set<string> | null,
) {
  const normalized = identifier.toUpperCase();
  const [key] = normalized.split('-');

  if (LOOK_ALIKES.has(key)) return;
  if (teamKeys && !teamKeys.has(key)) return;
  if (found.some((ticket) => ticket.identifier === normalized)) return;

  found.push({ identifier: normalized, source });
}

const SEGMENT = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})(?:$|[-_])/;
const TITLE_STRUCTURED =
  /(?:^\w+\(([A-Z][A-Z0-9]{1,9}-\d{1,6})\)|\[([A-Z][A-Z0-9]{1,9}-\d{1,6})\]|^([A-Z][A-Z0-9]{1,9}-\d{1,6})[:\s])/g;

/**
 * Finds ticket identifiers, most reliable first: explicit Linear links, then the branch name
 * (`fix/APP-123/...`), then the title (`fix(APP-123): ...`, `[APP-123] ...`), then the body.
 *
 * Without known team keys only structured positions count (a branch segment that starts with
 * the id, a title scope, bracket or prefix), so prose such as "Notes Q2-7" is not mistaken for a
 * ticket. With team keys from a connected Linear, any mention of those teams counts.
 */
export function extractTickets(
  pr: { headRefName: string; title: string; body: string },
  knownTeamKeys: string[] | null = null,
): TicketRef[] {
  const teamKeys = knownTeamKeys?.length
    ? new Set(knownTeamKeys.map((key) => key.toUpperCase()))
    : null;
  const found: TicketRef[] = [];

  for (const match of pr.body.matchAll(LINK)) add(found, match[1], 'link', teamKeys);

  for (const segment of pr.headRefName.split('/')) {
    const match = SEGMENT.exec(segment);

    if (match) add(found, `${match[1]}-${match[2]}`, 'branch', teamKeys);
  }

  for (const match of pr.title.matchAll(TITLE_STRUCTURED))
    add(found, match[1] ?? match[2] ?? match[3], 'title', teamKeys);

  if (teamKeys) {
    for (const source of [pr.headRefName, pr.title, pr.body]) {
      for (const match of source.matchAll(IDENTIFIER)) {
        if (match[1] === match[1].toUpperCase() || source === pr.headRefName) {
          add(
            found,
            `${match[1]}-${match[2]}`,
            source === pr.body ? 'body' : source === pr.title ? 'title' : 'branch',
            teamKeys,
          );
        }
      }
    }
  }

  return found;
}

export interface LinearIssue {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  state: { name: string; type: string; color: string };
  assignee: string | null;
  project: string | null;
  dueDate: string | null;
}

export interface LinearStatus {
  configured: boolean;
  connected: boolean;
  workspace: string | null;
  teamKeys: string[];
  error: string | null;
  /** Command the user runs in a terminal to store their key in the macOS Keychain. */
  setupCommand: string;
}
