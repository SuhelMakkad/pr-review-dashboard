import type { LinearIssue } from '../../shared/tickets.js';
import { LINEAR_MCP_URL, LinearAuthError, type LinearOAuth } from './oauth.js';
import type { LinearSource } from './service.js';

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20_000;

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string };
}

/** Every JSON-RPC message in a Streamable HTTP response, whether plain JSON or an SSE stream. */
export async function readMessages(response: Response): Promise<JsonRpcMessage[]> {
  const type = response.headers.get('content-type') ?? '';
  const text = await response.text();

  if (!text.trim()) return [];

  if (type.includes('text/event-stream')) {
    const messages: JsonRpcMessage[] = [];

    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''))
        .join('\n');

      if (!data) continue;

      try {
        const parsed = JSON.parse(data) as JsonRpcMessage | JsonRpcMessage[];

        messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
      } catch {
        // Not a JSON-RPC payload (a keep-alive or a comment); skip it.
      }
    }

    return messages;
  }

  const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];

  return Array.isArray(parsed) ? parsed : [parsed];
}

/**
 * A minimal MCP client over Streamable HTTP: initialize once per session, call tools, and start a
 * new session when the server forgets the old one. Authentication is a bearer token that the
 * caller refreshes on demand.
 */
export class McpHttpClient {
  private session: { id: string | null; protocol: string } | null = null;
  private starting: Promise<void> | null = null;
  private nextId = 1;

  constructor(
    private readonly url: string,
    private readonly token: (force: boolean) => Promise<string>,
    private readonly clientInfo = { name: 'Review Desk', version: '2.0.0' },
  ) {}

  reset(): void {
    this.session = null;
  }

  private async post(body: unknown, retried = false): Promise<Response> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${await this.token(retried)}`,
    };

    if (this.session?.id) headers['Mcp-Session-Id'] = this.session.id;
    if (this.session) headers['MCP-Protocol-Version'] = this.session.protocol;

    const response = await fetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 401 && !retried) {
      await response.body?.cancel();

      return this.post(body, true);
    }

    if (response.status === 401) {
      throw new LinearAuthError(
        'Linear no longer accepts this sign-in. Connect again in Settings.',
      );
    }

    return response;
  }

  private async start(): Promise<void> {
    this.session = null;

    const id = this.nextId++;
    const response = await this.post({
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: this.clientInfo },
    });

    if (!response.ok)
      throw new Error(`Linear’s MCP server responded with HTTP ${response.status}.`);

    const sessionId = response.headers.get('mcp-session-id');
    const message = (await readMessages(response)).find((candidate) => candidate.id === id);

    if (!message || message.error) {
      throw new Error(message?.error?.message ?? 'Linear’s MCP server did not start a session.');
    }

    const protocol =
      (message.result as { protocolVersion?: string } | undefined)?.protocolVersion ??
      PROTOCOL_VERSION;

    this.session = { id: sessionId, protocol };

    const initialized = await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });

    await initialized.body?.cancel();
  }

  private async ensureSession(): Promise<void> {
    if (this.session) return;

    this.starting ??= this.start().finally(() => (this.starting = null));

    return this.starting;
  }

  private async request(method: string, params: unknown, attempt = 0): Promise<unknown> {
    await this.ensureSession();

    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params });

    // The server forgot the session (restart or expiry): start a new one once.
    if ((response.status === 404 || response.status === 400) && attempt === 0 && this.session?.id) {
      await response.body?.cancel();
      this.session = null;

      return this.request(method, params, 1);
    }

    if (!response.ok)
      throw new Error(`Linear’s MCP server responded with HTTP ${response.status}.`);

    const message = (await readMessages(response)).find((candidate) => candidate.id === id);

    if (!message) throw new Error('Linear’s MCP server did not answer.');
    if (message.error) throw new Error(message.error.message);

    return message.result;
  }

  /** Calls a tool and returns its structured result, or its text parsed as JSON when possible. */
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = (await this.request('tools/call', { name, arguments: args })) as {
      content?: { type: string; text?: string }[];
      structuredContent?: unknown;
      isError?: boolean;
    };
    const text = (result.content ?? [])
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');

    if (result.isError) throw new McpToolError(text || `Linear’s ${name} tool failed.`);
    if (result.structuredContent !== undefined) return result.structuredContent;

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}

export class McpToolError extends Error {}

/** Linear's default workflow colours, used because the MCP issue view names the state type only. */
const stateColors: Record<string, string> = {
  triage: '#fc7840',
  backlog: '#bec2c8',
  unstarted: '#e2e2e2',
  started: '#f2c94c',
  completed: '#5e6ad2',
  canceled: '#95a2b3',
};

function nameOf(value: unknown): string | null {
  if (typeof value === 'string') return value || null;

  if (value && typeof value === 'object') {
    const record = value as { name?: unknown; displayName?: unknown };

    if (typeof record.displayName === 'string') return record.displayName;
    if (typeof record.name === 'string') return record.name;
  }

  return null;
}

/** Maps the MCP `get_issue` view to the issue shape the UI shows. */
export function issueFromMcp(raw: unknown): LinearIssue | null {
  if (!raw || typeof raw !== 'object') return null;

  const issue = raw as Record<string, unknown>;
  const identifier =
    typeof issue.identifier === 'string'
      ? issue.identifier
      : typeof issue.id === 'string'
        ? issue.id
        : null;

  if (!identifier || typeof issue.title !== 'string') return null;

  const priority = issue.priority as { value?: unknown; name?: unknown } | number | undefined;
  const priorityValue =
    typeof priority === 'number'
      ? priority
      : typeof priority?.value === 'number'
        ? priority.value
        : 0;
  const status = nameOf(issue.status) ?? 'Unknown';
  const statusType = typeof issue.statusType === 'string' ? issue.statusType : 'unstarted';

  return {
    identifier,
    title: issue.title,
    url: typeof issue.url === 'string' ? issue.url : '',
    priority: priorityValue,
    priorityLabel:
      typeof priority === 'object' && typeof priority?.name === 'string'
        ? priority.name
        : priorityValue === 0
          ? 'No priority'
          : '',
    dueDate: typeof issue.dueDate === 'string' ? issue.dueDate : null,
    state: { name: status, type: statusType, color: stateColors[statusType] ?? '#95a2b3' },
    assignee: nameOf(issue.assignee),
    project: nameOf(issue.project),
  };
}

const ISSUE_FIELDS = [
  'id',
  'title',
  'url',
  'priority',
  'dueDate',
  'status',
  'statusType',
  'assignee',
  'project',
];

/** Linear through its hosted MCP server, signed in with OAuth. Read-only. */
export class LinearMcp implements LinearSource {
  readonly method = 'oauth' as const;
  private readonly client: McpHttpClient;

  constructor(
    private readonly oauth: LinearOAuth,
    url = LINEAR_MCP_URL,
  ) {
    this.client = new McpHttpClient(url, (force) => this.oauth.accessToken(force));
  }

  configured(): Promise<boolean> {
    return this.oauth.connected();
  }

  refresh(): void {
    this.oauth.forget();
    this.client.reset();
  }

  /** The workspace name: `get_workspace` with read-only access, `whoami` where that is missing. */
  private async workspaceName(): Promise<string | null> {
    try {
      const workspace = (await this.client.callTool('get_workspace', {})) as {
        name?: string;
      } | null;

      return workspace?.name ?? null;
    } catch (error) {
      if (!(error instanceof McpToolError)) throw error;

      const who = (await this.client.callTool('whoami', {})) as {
        workspace?: { name?: string };
      } | null;

      return who?.workspace?.name ?? null;
    }
  }

  async workspace(): Promise<{ name: string | null; teamKeys: string[] }> {
    const name = await this.workspaceName();
    const keys: string[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < 5; page++) {
      const result = (await this.client.callTool('list_teams', {
        limit: 250,
        ...(cursor ? { cursor } : {}),
      })) as { teams?: { key?: string }[]; hasNextPage?: boolean; cursor?: string } | null;

      for (const team of result?.teams ?? []) if (team.key) keys.push(team.key);

      if (!result?.hasNextPage || !result.cursor) break;

      cursor = result.cursor;
    }

    return { name, teamKeys: keys };
  }

  async issues(identifiers: string[]): Promise<LinearIssue[]> {
    const found: LinearIssue[] = [];
    let failure: unknown = null;
    let failures = 0;

    // A few at a time; each PR references at most five tickets.
    for (let index = 0; index < identifiers.length; index += 4) {
      const batch = identifiers.slice(index, index + 4);
      const results = await Promise.allSettled(
        batch.map((id) => this.client.callTool('get_issue', { id, fields: ISSUE_FIELDS })),
      );

      for (const result of results) {
        if (result.status === 'fulfilled') {
          const issue = issueFromMcp(result.value);

          if (issue) found.push(issue);
        } else if (!(result.reason instanceof McpToolError)) {
          // A tool error means "no such issue"; anything else is a real failure.
          failure ??= result.reason;
          failures++;
        }
      }
    }

    if (failure && (failures === identifiers.length || failure instanceof LinearAuthError)) {
      throw failure;
    }

    return found;
  }
}
