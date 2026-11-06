import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../apps/server/src/app';
import { Store } from '../apps/server/src/db/store';
import { FixtureGitHub } from '../apps/server/src/demo/fixture-github';
import { defaultScenario } from '../apps/server/src/demo/scenario';
import { EventBus } from '../apps/server/src/events';
import { MemoryCredentialStore, type LinearCredentials } from '../apps/server/src/linear/credentials';
import { issueFromMcp, LinearMcp, McpHttpClient, readMessages } from '../apps/server/src/linear/mcp';
import { LinearAuthError, LinearOAuth } from '../apps/server/src/linear/oauth';
import { FixtureLinear, LinearService } from '../apps/server/src/linear/service';
import { SyncService } from '../apps/server/src/sync/index';

const ISSUER = 'https://mcp.linear.app';
const REDIRECT = 'http://127.0.0.1:4317/api/linear/callback';

const metadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  registration_endpoint: `${ISSUER}/register`,
  revocation_endpoint: `${ISSUER}/token`,
};

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

type Handler = (call: Call) => Response | Promise<Response>;

/** Routes fetch calls to handlers by URL and records every call. */
function fakeFetch(handlers: Record<string, Handler>) {
  const calls: Call[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL, init: RequestInit = {}) => {
      const url = String(input);
      const call: Call = {
        url,
        method: init.method ?? 'GET',
        headers: Object.fromEntries(new Headers(init.headers).entries()),
        body: typeof init.body === 'string' ? init.body : '',
      };

      calls.push(call);

      const handler = handlers[url.split('?')[0]];

      if (!handler) throw new Error(`unexpected fetch ${url}`);

      return handler(call);
    }),
  );

  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

const sse = (message: unknown, headers: Record<string, string> = {}) =>
  new Response(`event: message\ndata: ${JSON.stringify(message)}\n\n`, {
    headers: { 'Content-Type': 'text/event-stream', ...headers },
  });

function oauthServer(options: { tokens?: () => Response } = {}) {
  let issued = 0;

  return fakeFetch({
    [`${ISSUER}/.well-known/oauth-authorization-server`]: () => json(metadata),
    [`${ISSUER}/register`]: () =>
      json({ client_id: 'client-1', token_endpoint_auth_method: 'none' }),
    [`${ISSUER}/token`]: (call) => {
      if (options.tokens) return options.tokens();

      issued++;

      const form = new URLSearchParams(call.body);

      if (form.get('token')) return new Response(null, { status: 200 });

      return json({
        access_token: `access-token-${issued}-abcdef`,
        refresh_token: `refresh-token-${issued}-abcdef`,
        expires_in: 3600,
        token_type: 'bearer',
      });
    },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Linear sign-in (OAuth through the MCP server)', () => {
  it('registers once, sends PKCE and the resource, and stores tokens after the callback', async () => {
    const calls = oauthServer();
    const store = new MemoryCredentialStore();
    const oauth = new LinearOAuth(store);

    const authorize = new URL(await oauth.begin(REDIRECT));
    const params = authorize.searchParams;

    expect(`${authorize.origin}${authorize.pathname}`).toBe(`${ISSUER}/authorize`);
    expect(params.get('client_id')).toBe('client-1');
    expect(params.get('redirect_uri')).toBe(REDIRECT);
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('scope')).toBe('read');
    expect(params.get('resource')).toBe('https://mcp.linear.app/mcp');
    expect(await store.read()).toBeNull();

    const registration = JSON.parse(calls.find((call) => call.url.endsWith('/register'))!.body);

    expect(registration).toMatchObject({
      redirect_uris: [REDIRECT],
      token_endpoint_auth_method: 'none',
    });

    await oauth.complete({ state: params.get('state')!, code: 'code-1', iss: ISSUER });

    const exchange = new URLSearchParams(calls.at(-1)!.body);
    const verifier = exchange.get('code_verifier')!;

    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code')).toBe('code-1');
    expect(exchange.get('client_id')).toBe('client-1');
    expect(exchange.get('redirect_uri')).toBe(REDIRECT);
    expect(exchange.get('resource')).toBe('https://mcp.linear.app/mcp');
    expect(createHash('sha256').update(verifier).digest('base64url')).toBe(
      params.get('code_challenge'),
    );
    expect((await store.read())?.tokens?.access).toBe('access-token-1-abcdef');
    expect(await oauth.connected()).toBe(true);

    // The stored client is reused for the next sign-in with the same redirect URL.
    await oauth.begin(REDIRECT);
    expect(calls.filter((call) => call.url.endsWith('/register'))).toHaveLength(1);
  });

  it('rejects unknown, reused or foreign callbacks without storing anything', async () => {
    oauthServer();

    const store = new MemoryCredentialStore();
    const oauth = new LinearOAuth(store);
    const state = new URL(await oauth.begin(REDIRECT)).searchParams.get('state')!;

    await expect(oauth.complete({ state: 'forged', code: 'x' })).rejects.toThrow(LinearAuthError);
    await expect(oauth.complete({ state, code: 'x', iss: 'https://evil.example' })).rejects.toThrow(
      'did not come from Linear',
    );
    // The state was consumed by the failed attempt, so it cannot be replayed.
    await expect(oauth.complete({ state, code: 'x' })).rejects.toThrow(
      'expired or was already used',
    );

    const cancelled = new URL(await oauth.begin(REDIRECT)).searchParams.get('state')!;

    await expect(oauth.complete({ state: cancelled, error: 'access_denied' })).rejects.toThrow(
      'cancelled',
    );
    expect(await store.read()).toBeNull();
  });

  it('refuses discovery documents that point outside Linear', async () => {
    fakeFetch({
      [`${ISSUER}/.well-known/oauth-authorization-server`]: () =>
        json({ ...metadata, token_endpoint: 'https://attacker.example/token' }),
    });

    await expect(new LinearOAuth(new MemoryCredentialStore()).begin(REDIRECT)).rejects.toThrow(
      'unexpected endpoints',
    );
  });

  it('refreshes expiring tokens and signs out when Linear rejects the refresh token', async () => {
    let now = Date.parse('2026-11-05T10:00:00Z');
    let reject = false;
    const calls = oauthServer({
      tokens: () =>
        reject
          ? json({ error: 'invalid_grant' }, 400)
          : json({ access_token: 'access-token-2-abcdef', expires_in: 3600 }),
    });
    const credentials: LinearCredentials = {
      client: { id: 'client-1', authMethod: 'none', redirectUri: REDIRECT },
      tokens: {
        access: 'access-token-1-abcdef',
        refresh: 'refresh-1-abcdef',
        expiresAt: now + 30_000,
      },
    };
    const store = new MemoryCredentialStore(credentials);
    const oauth = new LinearOAuth(store, { now: () => now });

    // Inside the refresh margin: two concurrent callers share one refresh.
    const [first, second] = await Promise.all([oauth.accessToken(), oauth.accessToken()]);

    expect([first, second]).toEqual(['access-token-2-abcdef', 'access-token-2-abcdef']);
    expect(calls.filter((call) => call.url.endsWith('/token'))).toHaveLength(1);
    expect(new URLSearchParams(calls.at(-1)!.body).get('grant_type')).toBe('refresh_token');
    // Linear did not rotate the refresh token, so the old one is kept.
    expect((await store.read())?.tokens?.refresh).toBe('refresh-1-abcdef');

    now += 2 * 3600_000;
    reject = true;
    await expect(oauth.accessToken()).rejects.toThrow('Connect again in Settings');
    expect((await store.read())?.tokens).toBeUndefined();
    expect(await oauth.connected()).toBe(false);
  });
});

/** A fake Linear MCP endpoint speaking Streamable HTTP. */
function mcpServer(options: { tools: Record<string, (args: Record<string, unknown>) => unknown> }) {
  const state = { sessions: 0, expireNext: false, rejectToken: null as string | null };

  const calls = fakeFetch({
    ...Object.fromEntries(
      [`${ISSUER}/.well-known/oauth-authorization-server`].map((url) => [
        url,
        () => json(metadata),
      ]),
    ),
    [`${ISSUER}/token`]: () =>
      json({ access_token: 'access-token-fresh-abcdef', expires_in: 3600 }),
    [`${ISSUER}/mcp`]: (call) => {
      if (call.headers.authorization === `Bearer ${state.rejectToken}`) {
        return new Response(null, { status: 401 });
      }

      const message = JSON.parse(call.body) as {
        id?: number;
        method: string;
        params?: { name: string; arguments: Record<string, unknown> };
      };

      if (message.method === 'initialize') {
        state.sessions++;

        return sse(
          { jsonrpc: '2.0', id: message.id, result: { protocolVersion: '2025-06-18' } },
          { 'Mcp-Session-Id': `session-${state.sessions}` },
        );
      }

      if (message.method === 'notifications/initialized')
        return new Response(null, { status: 202 });

      if (state.expireNext) {
        state.expireNext = false;

        return new Response(null, { status: 404 });
      }

      const tool = options.tools[message.params!.name];
      const result = tool
        ? (() => {
            try {
              return {
                content: [{ type: 'text', text: JSON.stringify(tool(message.params!.arguments)) }],
              };
            } catch (error) {
              return { content: [{ type: 'text', text: (error as Error).message }], isError: true };
            }
          })()
        : { content: [{ type: 'text', text: 'Unknown tool' }], isError: true };

      return json({ jsonrpc: '2.0', id: message.id, result });
    },
  });

  return { calls, state };
}

const signedIn = (access = 'access-token-1-abcdef') =>
  new MemoryCredentialStore({
    client: { id: 'client-1', authMethod: 'none', redirectUri: REDIRECT },
    tokens: { access, refresh: 'refresh-1-abcdef', expiresAt: Date.now() + 3600_000 },
  });

describe('Linear through its MCP server', () => {
  const tools = {
    // A read-only sign-in gets get_workspace, not whoami.
    get_workspace: () => ({ id: 'w1', name: 'Acme', url: 'https://linear.app/acme' }),
    list_teams: () => ({ teams: [{ key: 'APP' }, { key: 'OPS' }], hasNextPage: false }),
    get_issue: (args: Record<string, unknown>) => {
      if (args.id !== 'APP-123') throw new Error(`Issue ${String(args.id)} not found`);

      return {
        id: 'APP-123',
        title: 'Save dashboard preferences',
        url: 'https://linear.app/acme/issue/APP-123',
        priority: { value: 2, name: 'High' },
        dueDate: null,
        status: 'In Review',
        statusType: 'started',
        assignee: 'Suhel Makkad',
        project: null,
      };
    },
  };

  it('starts one session, reads the workspace and maps issues, skipping unknown ones', async () => {
    const { calls } = mcpServer({ tools });
    const linear = new LinearMcp(new LinearOAuth(signedIn()), `${ISSUER}/mcp`);

    expect(await linear.workspace()).toEqual({ name: 'Acme', teamKeys: ['APP', 'OPS'] });
    expect(await linear.issues(['APP-123', 'APP-9999'])).toEqual([
      {
        identifier: 'APP-123',
        title: 'Save dashboard preferences',
        url: 'https://linear.app/acme/issue/APP-123',
        priority: 2,
        priorityLabel: 'High',
        dueDate: null,
        state: { name: 'In Review', type: 'started', color: '#f2c94c' },
        assignee: 'Suhel Makkad',
        project: null,
      },
    ]);

    const mcpCalls = calls.filter((call) => call.url.endsWith('/mcp'));
    const methods = mcpCalls.map((call) => JSON.parse(call.body).method);

    expect(methods.filter((method) => method === 'initialize')).toHaveLength(1);
    expect(mcpCalls.at(-1)!.headers).toMatchObject({
      authorization: 'Bearer access-token-1-abcdef',
      'mcp-session-id': 'session-1',
      'mcp-protocol-version': '2025-06-18',
    });
    expect(JSON.parse(mcpCalls.at(-1)!.body).params.arguments.fields).toContain('statusType');
  });

  it('starts a new session when the server forgets one, and refreshes a rejected token once', async () => {
    const { state, calls } = mcpServer({ tools });
    const linear = new LinearMcp(new LinearOAuth(signedIn()), `${ISSUER}/mcp`);

    await linear.workspace();
    state.expireNext = true;
    expect((await linear.workspace()).name).toBe('Acme');
    expect(state.sessions).toBe(2);

    state.rejectToken = 'access-token-1-abcdef';
    linear.refresh();
    expect((await linear.workspace()).name).toBe('Acme');
    expect(calls.some((call) => call.url.endsWith('/token'))).toBe(true);
    expect(calls.at(-1)!.headers.authorization).toBe('Bearer access-token-fresh-abcdef');
  });

  it('falls back to whoami for the workspace name where get_workspace is missing', async () => {
    const { get_workspace: _, ...rest } = tools;

    mcpServer({
      tools: { ...rest, whoami: () => ({ user: { name: 'You' }, workspace: { name: 'Acme' } }) },
    });

    const linear = new LinearMcp(new LinearOAuth(signedIn()), `${ISSUER}/mcp`);

    expect((await linear.workspace()).name).toBe('Acme');
  });

  it('reads JSON-RPC messages from SSE and plain JSON responses', async () => {
    const stream = new Response(
      ': keep-alive\n\nevent: message\nid: 1\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    );

    expect(await readMessages(stream)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/progress' },
      { jsonrpc: '2.0', id: 7, result: { ok: true } },
    ]);
    expect(await readMessages(json({ jsonrpc: '2.0', id: 1, result: {} }))).toHaveLength(1);
    expect(await readMessages(new Response(null, { status: 202 }))).toEqual([]);
  });

  it('accepts the object forms Linear may use for names', () => {
    expect(
      issueFromMcp({
        identifier: 'APP-1',
        title: 'T',
        url: 'u',
        priority: 0,
        status: { name: 'Done' },
        statusType: 'completed',
        assignee: { displayName: 'Ana' },
        project: { name: 'Platform' },
      }),
    ).toMatchObject({
      priorityLabel: 'No priority',
      state: { name: 'Done', type: 'completed' },
      assignee: 'Ana',
      project: 'Platform',
    });
    expect(issueFromMcp('not an issue')).toBeNull();
  });

  it('throws a typed error when the MCP client is rejected after a refresh', async () => {
    fakeFetch({
      [`${ISSUER}/mcp`]: () => new Response(null, { status: 401 }),
    });

    const client = new McpHttpClient(`${ISSUER}/mcp`, async () => 'token-abcdefgh');

    await expect(client.callTool('whoami', {})).rejects.toThrow(LinearAuthError);
  });
});

async function demoApp(options: Parameters<typeof createApp>[1]) {
  const store = new Store(':memory:');
  const sync = new SyncService(
    store,
    new FixtureGitHub(() => defaultScenario(Date.parse('2026-11-05T10:00:00Z'))),
    new EventBus(),
  );

  await sync.sync();

  const app = await createApp(sync, { sessionToken: 'session-token-abcdef0123', ...options });
  const write = (url: string) =>
    app.inject({
      method: 'POST',
      url,
      headers: {
        host: '127.0.0.1:4317',
        'content-type': 'application/json',
        'x-review-desk': '1',
        'x-review-desk-session': 'session-token-abcdef0123',
      },
      payload: '{}',
    });
  const read = (url: string) =>
    app.inject({ method: 'GET', url, headers: { host: '127.0.0.1:4317' } });

  return { app, store, sync, write, read };
}

describe('Linear sign-in routes', () => {
  it('connects through the callback and disconnects', async () => {
    const { app, store, write, read } = await demoApp({ linear: new FixtureLinear(false) });

    try {
      expect((await read('/api/linear/status')).json()).toMatchObject({
        connected: false,
        canSignIn: true,
        method: null,
      });

      // Starting a sign-in needs the session token like every other write.
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/linear/connect',
            headers: {
              host: '127.0.0.1:4317',
              'content-type': 'application/json',
              'x-review-desk': '1',
            },
            payload: '{}',
          })
        ).statusCode,
      ).toBe(401);

      const forged = await read('/api/linear/callback?state=forged&code=x');

      expect(forged.statusCode).toBe(303);
      expect(forged.headers.location).toBe('/settings?linear=failed');
      expect((await read('/api/linear/status')).json()).toMatchObject({
        connected: false,
        error: 'This Linear sign-in has expired or was already used. Start again from Settings.',
      });

      const { url } = (await write('/api/linear/connect')).json() as { url: string };

      expect(url).toMatch(/^\/api\/linear\/callback\?code=demo-code&state=/);

      const callback = await read(url);

      expect(callback.headers.location).toBe('/settings?linear=connected');
      expect((await read('/api/linear/status')).json()).toMatchObject({
        connected: true,
        method: 'oauth',
        workspace: 'Acme',
        error: null,
      });

      expect((await write('/api/linear/disconnect')).json()).toMatchObject({ connected: false });
    } finally {
      await app.close();
      store.close();
    }
  });

  it('keeps OAuth tokens out of every response when Linear echoes them back', async () => {
    const access = 'linear-oauth-access-CANARY-0123456789';

    fakeFetch({
      [`${ISSUER}/mcp`]: (call) =>
        json({
          jsonrpc: '2.0',
          id: JSON.parse(call.body).id,
          error: { code: -32001, message: `Token ${call.headers.authorization} is not allowed` },
        }),
    });

    const oauth = new LinearOAuth(signedIn(access));
    const { app, store, sync, read } = await demoApp({
      linear: new LinearMcp(oauth, `${ISSUER}/mcp`),
      linearConnector: oauth,
    });

    try {
      const id = sync.list().items.find((item) => item.number === 2041)!.id;
      const bodies = [
        (await read('/api/linear/status')).body,
        (await read(`/api/pulls/${id}/tickets`)).body,
      ].join('\n');

      expect(bodies).toContain('[redacted]');
      expect(bodies).not.toContain(access);
      expect(bodies).not.toContain('refresh-1-abcdef');
    } finally {
      await app.close();
      store.close();
    }
  });
});

describe('Linear sign-in callback address', () => {
  it('sends Linear back to the address the browser uses, even through the dev proxy', async () => {
    const redirects: string[] = [];
    const connector = {
      begin: async (redirectUri: string) => {
        redirects.push(redirectUri);

        return 'https://mcp.linear.app/authorize';
      },
      complete: async () => {},
      disconnect: async () => {},
    };
    const { app, store } = await demoApp({
      linear: new FixtureLinear(false),
      linearConnector: connector,
      ports: [4317, 4318],
    });

    try {
      const connect = (headers: Record<string, string>) =>
        app.inject({
          method: 'POST',
          url: '/api/linear/connect',
          headers: {
            'content-type': 'application/json',
            'x-review-desk': '1',
            'x-review-desk-session': 'session-token-abcdef0123',
            ...headers,
          },
          payload: '{}',
        });

      // Vite proxies /api with the API port as Host; the page itself is on the UI port.
      await connect({ host: '127.0.0.1:4318', origin: 'http://127.0.0.1:4317' });
      await connect({ host: 'localhost:4317', origin: 'http://localhost:4317' });
      await connect({ host: '127.0.0.1:4317' });

      expect(redirects).toEqual([
        'http://127.0.0.1:4317/api/linear/callback',
        'http://127.0.0.1:4317/api/linear/callback',
        'http://127.0.0.1:4317/api/linear/callback',
      ]);
    } finally {
      await app.close();
      store.close();
    }
  });
});

describe('Linear service with both methods', () => {
  it('reports how it is connected', async () => {
    const linear = new LinearService(new FixtureLinear(true));

    expect(await linear.status()).toMatchObject({ connected: true, method: 'oauth' });
  });
});
