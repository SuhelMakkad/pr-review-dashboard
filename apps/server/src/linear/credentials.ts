import { execFile, spawn } from 'node:child_process';
import { z } from 'zod';
import { registerSecret } from '@/github/errors.js';

/** The OAuth client Review Desk registered with Linear's MCP server, and the tokens it holds. */
export interface LinearCredentials {
  client: {
    id: string;
    secret?: string;
    authMethod: 'none' | 'client_secret_post' | 'client_secret_basic';
    redirectUri: string;
  };
  tokens?: {
    access: string;
    refresh?: string;
    /** Epoch milliseconds; absent when the server did not say. */
    expiresAt?: number;
    scope?: string;
  };
}

const credentialsSchema = z.object({
  client: z.object({
    id: z.string().min(1),
    secret: z.string().optional(),
    authMethod: z.enum(['none', 'client_secret_post', 'client_secret_basic']),
    redirectUri: z.string().min(1),
  }),
  tokens: z
    .object({
      access: z.string().min(1),
      refresh: z.string().optional(),
      expiresAt: z.number().optional(),
      scope: z.string().optional(),
    })
    .optional(),
});

export interface CredentialStore {
  read(): Promise<LinearCredentials | null>;
  write(credentials: LinearCredentials): Promise<void>;
  clear(): Promise<void>;
  /** Drops any in-memory copy so the next read goes back to the store. */
  forget(): void;
}

function registerAll(credentials: LinearCredentials | null): void {
  if (!credentials) return;

  for (const secret of [
    credentials.client.secret,
    credentials.tokens?.access,
    credentials.tokens?.refresh,
  ]) {
    if (secret) registerSecret(secret);
  }
}

export const OAUTH_KEYCHAIN_SERVICE = 'review-desk.linear-oauth';
export const OAUTH_KEYCHAIN_ACCOUNT = 'credentials';

/** `security -i` reads one command per line and drops lines longer than about 4 KB. */
const MAX_ENCODED = 3800;

/**
 * Keeps Linear OAuth credentials in the macOS Keychain. Values go to `security` on stdin, never on
 * its command line, so other processes cannot read them from the process list.
 */
export class KeychainCredentialStore implements CredentialStore {
  private cached: { value: LinearCredentials | null } | null = null;

  constructor(
    private readonly service = OAUTH_KEYCHAIN_SERVICE,
    private readonly account = OAUTH_KEYCHAIN_ACCOUNT,
    /** A specific keychain file; the user's default keychain when omitted. */
    private readonly keychain?: string,
  ) {}

  private target(): string[] {
    return this.keychain ? [this.keychain] : [];
  }

  async read(): Promise<LinearCredentials | null> {
    if (this.cached) return this.cached.value;

    const encoded = await new Promise<string | null>((resolve) => {
      execFile(
        'security',
        ['find-generic-password', '-s', this.service, '-a', this.account, '-w', ...this.target()],
        { timeout: 5000 },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    });
    let value: LinearCredentials | null = null;

    if (encoded) {
      try {
        const parsed = credentialsSchema.safeParse(
          JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')),
        );

        value = parsed.success ? parsed.data : null;
      } catch {
        value = null;
      }
    }

    registerAll(value);
    this.cached = { value };

    return value;
  }

  async write(credentials: LinearCredentials): Promise<void> {
    const encoded = Buffer.from(JSON.stringify(credentials), 'utf8').toString('base64url');

    if (encoded.length > MAX_ENCODED) {
      throw new Error('Linear returned credentials too large to store in the Keychain.');
    }

    registerAll(credentials);
    const keychain = this.keychain ? ` "${this.keychain}"` : '';

    await this.security(
      `add-generic-password -U -s ${this.service} -a ${this.account} -l "Review Desk Linear sign-in" -w ${encoded}${keychain}\n`,
    );
    this.cached = { value: credentials };
  }

  async clear(): Promise<void> {
    await new Promise<void>((resolve) => {
      execFile(
        'security',
        ['delete-generic-password', '-s', this.service, '-a', this.account, ...this.target()],
        { timeout: 5000 },
        // A missing item is already cleared.
        () => resolve(),
      );
    });
    this.cached = { value: null };
  }

  forget(): void {
    this.cached = null;
  }

  private security(command: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);

      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        clearTimeout(timer);

        // `security -i` echoes a failed command line back, which would include the secret.
        if (code === 0 && !stderr.trim()) resolve();
        else reject(new Error('Could not save the Linear sign-in to the macOS Keychain.'));
      });
      child.stdin.end(command);
    });
  }
}

/** In-memory store for tests and demo mode. */
export class MemoryCredentialStore implements CredentialStore {
  constructor(private value: LinearCredentials | null = null) {
    registerAll(value);
  }

  async read() {
    return this.value;
  }

  async write(credentials: LinearCredentials) {
    registerAll(credentials);
    this.value = credentials;
  }

  async clear() {
    this.value = null;
  }

  forget() {}
}
