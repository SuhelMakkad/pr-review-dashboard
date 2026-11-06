import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { registerSecret, safeError } from '@/github/errors.js';
import type { CredentialStore, LinearCredentials } from '@/linear/credentials.js';

/** Linear's hosted MCP server; it is also the OAuth authorization server for it. */
export const LINEAR_MCP_URL = 'https://mcp.linear.app/mcp';
export const LINEAR_MCP_ISSUER = 'https://mcp.linear.app';

/** Review Desk only reads from Linear. */
const SCOPE = 'read';
const FLOW_TTL_MS = 10 * 60_000;
const MAX_PENDING = 5;
const REFRESH_MARGIN_MS = 60_000;

export class LinearAuthError extends Error {}

const metadataSchema = z.object({
  issuer: z.string(),
  authorization_endpoint: z.string(),
  token_endpoint: z.string(),
  registration_endpoint: z.string().optional(),
  revocation_endpoint: z.string().optional(),
  token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
});

type Metadata = z.infer<typeof metadataSchema>;

const registrationSchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().optional(),
  token_endpoint_auth_method: z.string().optional(),
});

const tokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  scope: z.string().optional(),
});

/** What Linear sends back to the callback URL. */
export interface CallbackParams {
  state?: string;
  code?: string;
  error?: string;
  error_description?: string;
  iss?: string;
}

/** Signing in to Linear from Settings: start the flow, finish it on the callback, sign out. */
export interface LinearConnector {
  begin(redirectUri: string): Promise<string>;
  complete(params: CallbackParams): Promise<void>;
  disconnect(): Promise<void>;
}

const base64url = (buffer: Buffer) => buffer.toString('base64url');

function isLinearUrl(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      url.protocol === 'https:' &&
      (url.hostname === 'linear.app' || url.hostname.endsWith('.linear.app'))
    );
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<unknown> {
  return response.json().catch(() => ({}));
}

function oauthError(body: unknown): { error?: string; description?: string } {
  const value = (body ?? {}) as { error?: unknown; error_description?: unknown };

  return {
    error: typeof value.error === 'string' ? value.error : undefined,
    description: typeof value.error_description === 'string' ? value.error_description : undefined,
  };
}

/**
 * OAuth 2.1 sign-in to Linear's MCP server for a local app: dynamic client registration, a PKCE
 * authorization code flow back to a loopback URL, and refresh-token rotation. It works in
 * workspaces where personal API keys are turned off, and only ever asks for read access.
 */
export class LinearOAuth implements LinearConnector {
  private metadata: Metadata | null = null;
  private readonly pending = new Map<
    string,
    { verifier: string; client: LinearCredentials['client']; at: number }
  >();
  private refreshing: Promise<string> | null = null;

  constructor(
    private readonly store: CredentialStore,
    private readonly options: { issuer?: string; resource?: string; now?: () => number } = {},
  ) {}

  private get issuer() {
    return this.options.issuer ?? LINEAR_MCP_ISSUER;
  }

  private get resource() {
    return this.options.resource ?? LINEAR_MCP_URL;
  }

  private now() {
    return this.options.now?.() ?? Date.now();
  }

  async connected(): Promise<boolean> {
    return Boolean((await this.store.read())?.tokens);
  }

  forget(): void {
    this.store.forget();
  }

  private async discover(): Promise<Metadata> {
    if (this.metadata) return this.metadata;

    const response = await fetch(`${this.issuer}/.well-known/oauth-authorization-server`, {
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      throw new Error(`Linear's sign-in server responded with HTTP ${response.status}.`);
    }

    const metadata = metadataSchema.parse(await readJson(response));
    const endpoints = [
      metadata.authorization_endpoint,
      metadata.token_endpoint,
      metadata.registration_endpoint,
      metadata.revocation_endpoint,
    ].filter((value): value is string => Boolean(value));

    if (metadata.issuer !== this.issuer || !endpoints.every(isLinearUrl)) {
      throw new Error('Linear’s sign-in server described unexpected endpoints.');
    }

    this.metadata = metadata;

    return metadata;
  }

  private async register(metadata: Metadata, redirectUri: string) {
    if (!metadata.registration_endpoint) {
      throw new Error('Linear’s sign-in server does not accept new apps.');
    }

    const response = await fetch(metadata.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        client_name: 'Review Desk',
        redirect_uris: [redirectUri],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
        scope: SCOPE,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await readJson(response);

    if (!response.ok) {
      const { error, description } = oauthError(body);

      throw new Error(
        `Linear did not register Review Desk: ${description ?? error ?? `HTTP ${response.status}`}.`,
      );
    }

    const registration = registrationSchema.parse(body);
    const method = registration.token_endpoint_auth_method;

    if (registration.client_secret) registerSecret(registration.client_secret);

    return {
      id: registration.client_id,
      secret: registration.client_secret,
      authMethod:
        method === 'client_secret_basic' || method === 'client_secret_post'
          ? method
          : registration.client_secret
            ? 'client_secret_post'
            : 'none',
      redirectUri,
    } satisfies LinearCredentials['client'];
  }

  /** Returns the Linear page to send the browser to. */
  async begin(redirectUri: string): Promise<string> {
    const metadata = await this.discover();
    const stored = await this.store.read();
    const client =
      stored?.client.redirectUri === redirectUri
        ? stored.client
        : await this.register(metadata, redirectUri);
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(24));
    const now = this.now();

    for (const [key, flow] of this.pending) {
      if (now - flow.at > FLOW_TTL_MS) this.pending.delete(key);
    }

    while (this.pending.size >= MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value!);
    }

    this.pending.set(state, { verifier, client, at: now });

    const url = new URL(metadata.authorization_endpoint);

    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: client.id,
      redirect_uri: redirectUri,
      code_challenge: base64url(createHash('sha256').update(verifier).digest()),
      code_challenge_method: 'S256',
      state,
      scope: SCOPE,
      resource: this.resource,
    }).toString();

    return url.toString();
  }

  async complete(params: CallbackParams): Promise<void> {
    const flow = params.state ? this.pending.get(params.state) : undefined;

    if (params.state) this.pending.delete(params.state);

    if (!flow || this.now() - flow.at > FLOW_TTL_MS) {
      throw new LinearAuthError(
        'This Linear sign-in has expired or was already used. Start again from Settings.',
      );
    }

    if (params.error) {
      throw new LinearAuthError(
        params.error === 'access_denied'
          ? 'Linear sign-in was cancelled.'
          : `Linear did not grant access: ${params.error_description ?? params.error}.`,
      );
    }

    const metadata = await this.discover();

    if (params.iss && params.iss !== metadata.issuer) {
      throw new LinearAuthError('The sign-in response did not come from Linear.');
    }

    if (!params.code) throw new LinearAuthError('Linear did not return a sign-in code.');

    const tokens = await this.token(metadata, flow.client, {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: flow.client.redirectUri,
      code_verifier: flow.verifier,
    });

    await this.store.write({ client: flow.client, tokens });
  }

  /** A valid access token, refreshed when it is about to expire or when `force` is set. */
  async accessToken(force = false): Promise<string> {
    const stored = await this.store.read();

    if (!stored?.tokens) throw new LinearAuthError('Linear is not connected.');

    const { expiresAt } = stored.tokens;

    if (!force && (!expiresAt || expiresAt - REFRESH_MARGIN_MS > this.now())) {
      return stored.tokens.access;
    }

    this.refreshing ??= this.refresh(stored).finally(() => (this.refreshing = null));

    return this.refreshing;
  }

  private async refresh(stored: LinearCredentials): Promise<string> {
    const refreshToken = stored.tokens?.refresh;

    if (!refreshToken) {
      await this.store.write({ client: stored.client });

      throw new LinearAuthError('Your Linear sign-in expired. Connect again in Settings.');
    }

    const metadata = await this.discover();

    try {
      const tokens = await this.token(metadata, stored.client, {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      });

      // Linear may rotate the refresh token; keep the old one if it did not.
      tokens.refresh ??= refreshToken;
      await this.store.write({ client: stored.client, tokens });

      return tokens.access;
    } catch (error) {
      if (error instanceof LinearAuthError) {
        await this.store.write({ client: stored.client });

        throw new LinearAuthError('Your Linear sign-in expired. Connect again in Settings.');
      }

      throw error;
    }
  }

  private async token(
    metadata: Metadata,
    client: LinearCredentials['client'],
    grant: Record<string, string>,
  ): Promise<NonNullable<LinearCredentials['tokens']>> {
    const form = new URLSearchParams({ ...grant, resource: this.resource });
    const headers: Record<string, string> = {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/json',
    };

    if (client.authMethod === 'client_secret_basic' && client.secret) {
      headers.Authorization = `Basic ${Buffer.from(
        `${encodeURIComponent(client.id)}:${encodeURIComponent(client.secret)}`,
      ).toString('base64')}`;
    } else {
      form.set('client_id', client.id);

      if (client.authMethod === 'client_secret_post' && client.secret) {
        form.set('client_secret', client.secret);
      }
    }

    const response = await fetch(metadata.token_endpoint, {
      method: 'POST',
      headers,
      body: form.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readJson(response);

    if (!response.ok) {
      const { error, description } = oauthError(body);

      // A rejected grant means signing in again; anything else may be temporary.
      if (error === 'invalid_grant' || error === 'invalid_client' || response.status === 401) {
        throw new LinearAuthError(`Linear rejected the sign-in (${description ?? error}).`);
      }

      throw new Error(
        `Linear’s sign-in server failed: ${description ?? error ?? `HTTP ${response.status}`}.`,
      );
    }

    const parsed = tokenSchema.parse(body);

    registerSecret(parsed.access_token);

    if (parsed.refresh_token) registerSecret(parsed.refresh_token);

    return {
      access: parsed.access_token,
      refresh: parsed.refresh_token,
      expiresAt: parsed.expires_in ? this.now() + parsed.expires_in * 1000 : undefined,
      scope: parsed.scope,
    };
  }

  /** Signs out: revokes the refresh token where Linear allows it, then forgets everything. */
  async disconnect(): Promise<void> {
    const stored = await this.store.read();
    const token = stored?.tokens?.refresh ?? stored?.tokens?.access;

    if (stored && token) {
      try {
        const metadata = await this.discover();

        if (metadata.revocation_endpoint) {
          await fetch(metadata.revocation_endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              token,
              token_type_hint: stored.tokens?.refresh ? 'refresh_token' : 'access_token',
              client_id: stored.client.id,
            }).toString(),
            signal: AbortSignal.timeout(10_000),
          });
        }
      } catch (error) {
        // Revoking is a courtesy; signing out locally must still work offline.
        console.warn('Could not revoke the Linear token:', safeError(error));
      }
    }

    this.pending.clear();
    await this.store.clear();
  }
}
