import type { LinearIssue, LinearStatus } from '../../shared/tickets.js';
import { extractTickets } from '../../shared/tickets.js';
import type { PullRequestSnapshot } from '../../shared/types.js';
import { safeError } from '../github/errors.js';
import { SETUP_COMMAND, type KeySource } from './keychain.js';

const CACHE_MS = 10 * 60_000;
const ENDPOINT = 'https://api.linear.app/graphql';

/** Linear access: the real API with a Keychain key, or a fixture in demo mode and tests. */
export interface LinearSource {
  configured(): Promise<boolean>;
  workspace(): Promise<{ name: string | null; teamKeys: string[] }>;
  issues(identifiers: string[]): Promise<LinearIssue[]>;
}

const issueFields =
  'identifier title url priority priorityLabel dueDate state { name type color } assignee { displayName } project { name }';

interface RawIssue {
  identifier: string;
  title: string;
  url: string;
  priority: number;
  priorityLabel: string;
  dueDate: string | null;
  state: { name: string; type: string; color: string };
  assignee: { displayName: string } | null;
  project: { name: string } | null;
}

export class LinearApi implements LinearSource {
  constructor(private readonly keys: KeySource) {}

  async configured(): Promise<boolean> {
    return Boolean(await this.keys.read());
  }

  private async query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const key = await this.keys.read();

    if (!key) throw new Error('No Linear API key in the Keychain.');

    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: key },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15_000),
    });
    const result = (await response.json().catch(() => ({}))) as {
      data?: T;
      errors?: { message: string }[];
    };

    if (!response.ok || result.errors?.length || !result.data) {
      throw new Error(
        result.errors?.map((error) => error.message).join('; ') ||
          `Linear responded with HTTP ${response.status}.`,
      );
    }

    return result.data;
  }

  async workspace() {
    const data = await this.query<{
      organization: { name: string };
      teams: { nodes: { key: string }[] };
    }>('query Workspace { organization { name } teams(first: 250) { nodes { key } } }');

    return { name: data.organization.name, teamKeys: data.teams.nodes.map((team) => team.key) };
  }

  async issues(identifiers: string[]): Promise<LinearIssue[]> {
    if (identifiers.length === 0) return [];

    const fields = identifiers
      .map((_, index) => `i${index}: issue(id: $id${index}) { ${issueFields} }`)
      .join('\n');
    const declarations = identifiers.map((_, index) => `$id${index}: String!`).join(', ');
    const data = await this.query<Record<string, RawIssue | null>>(
      `query Issues(${declarations}) {\n${fields}\n}`,
      Object.fromEntries(identifiers.map((identifier, index) => [`id${index}`, identifier])),
    ).catch((error: Error) => {
      // A missing issue fails the whole aliased query; fall back to fetching one by one.
      if (identifiers.length > 1 && /not found|Entity not found/i.test(error.message)) return null;

      throw error;
    });

    if (!data) {
      const single = await Promise.all(
        identifiers.map((identifier) => this.issues([identifier]).catch(() => [])),
      );

      return single.flat();
    }

    return Object.values(data)
      .filter((issue): issue is RawIssue => Boolean(issue))
      .map((issue) => ({
        identifier: issue.identifier,
        title: issue.title,
        url: issue.url,
        priority: issue.priority,
        priorityLabel: issue.priorityLabel,
        dueDate: issue.dueDate,
        state: issue.state,
        assignee: issue.assignee?.displayName ?? null,
        project: issue.project?.name ?? null,
      }));
  }
}

/** Ticket context for PRs, cached for ten minutes per issue. */
export class LinearService {
  private workspaceCache: {
    at: number;
    value: { name: string | null; teamKeys: string[] };
  } | null = null;
  private readonly issueCache = new Map<string, { at: number; issue: LinearIssue | null }>();
  private lastError: string | null = null;

  constructor(private readonly source: LinearSource) {}

  async status(): Promise<LinearStatus> {
    const configured = await this.source.configured();

    if (!configured) {
      return {
        configured: false,
        connected: false,
        workspace: null,
        teamKeys: [],
        error: null,
        setupCommand: SETUP_COMMAND,
      };
    }

    try {
      const workspace = await this.workspace(true);

      return {
        configured,
        connected: true,
        workspace: workspace.name,
        teamKeys: workspace.teamKeys,
        error: null,
        setupCommand: SETUP_COMMAND,
      };
    } catch (error) {
      return {
        configured,
        connected: false,
        workspace: null,
        teamKeys: [],
        error: safeError(error),
        setupCommand: SETUP_COMMAND,
      };
    }
  }

  private async workspace(force = false) {
    if (!force && this.workspaceCache && Date.now() - this.workspaceCache.at < CACHE_MS)
      return this.workspaceCache.value;

    const value = await this.source.workspace();

    this.workspaceCache = { at: Date.now(), value };

    return value;
  }

  /** Known team keys, if Linear is connected; used to tell real tickets from look-alikes. */
  async teamKeys(): Promise<string[] | null> {
    try {
      return (await this.source.configured()) ? (await this.workspace()).teamKeys : null;
    } catch {
      return null;
    }
  }

  async ticketsFor(
    pr: Pick<PullRequestSnapshot, 'headRefName' | 'title' | 'body'>,
  ): Promise<{ identifiers: string[]; issues: LinearIssue[]; error: string | null }> {
    const identifiers = extractTickets(pr, await this.teamKeys())
      .map((ticket) => ticket.identifier)
      .slice(0, 5);

    if (identifiers.length === 0 || !(await this.source.configured()))
      return { identifiers, issues: [], error: null };

    const now = Date.now();
    const missing = identifiers.filter((identifier) => {
      const cached = this.issueCache.get(identifier);

      return !cached || now - cached.at > CACHE_MS;
    });

    if (missing.length) {
      try {
        const fetched = await this.source.issues(missing);

        for (const identifier of missing) {
          this.issueCache.set(identifier, {
            at: now,
            issue: fetched.find((issue) => issue.identifier === identifier) ?? null,
          });
        }

        this.lastError = null;
      } catch (error) {
        this.lastError = safeError(error);
      }
    }

    return {
      identifiers,
      issues: identifiers
        .map((identifier) => this.issueCache.get(identifier)?.issue)
        .filter((issue): issue is LinearIssue => Boolean(issue)),
      error: this.lastError,
    };
  }
}

/** Demo-mode Linear with a handful of fictional issues. */
export class FixtureLinear implements LinearSource {
  constructor(private readonly connected = true) {}

  async configured() {
    return this.connected;
  }

  async workspace() {
    return { name: 'Acme', teamKeys: ['DEMO'] };
  }

  async issues(identifiers: string[]): Promise<LinearIssue[]> {
    const issue = (
      identifier: string,
      title: string,
      state: LinearIssue['state'],
      assignee: string | null,
      priority: number,
      priorityLabel: string,
    ): LinearIssue => ({
      identifier,
      title,
      url: `https://linear.app/acme/issue/${identifier.toLowerCase()}`,
      priority,
      priorityLabel,
      state,
      assignee,
      project: 'Product catalog',
      dueDate: null,
    });
    const known = [
      issue(
        'DEMO-101',
        'Store extracted product metadata',
        { name: 'In Progress', type: 'started', color: '#f2c94c' },
        'Alex',
        2,
        'High',
      ),
      issue(
        'DEMO-102',
        'Filter editor for product collections',
        { name: 'In Review', type: 'started', color: '#5e6ad2' },
        'Alex',
        3,
        'Medium',
      ),
      issue(
        'DEMO-103',
        'Calendar settings use design-system tabs',
        { name: 'Todo', type: 'unstarted', color: '#e2e2e2' },
        'Mara',
        4,
        'Low',
      ),
      issue(
        'DEMO-104',
        'Webhook retries with backoff',
        { name: 'In Progress', type: 'started', color: '#f2c94c' },
        'You',
        2,
        'High',
      ),
    ];

    return known.filter((candidate) => identifiers.includes(candidate.identifier));
  }
}
