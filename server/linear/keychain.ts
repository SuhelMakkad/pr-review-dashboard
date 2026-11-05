import { execFile } from 'node:child_process';
import { registerSecret } from '../github/errors.js';

export const KEYCHAIN_SERVICE = 'review-desk.linear';
export const KEYCHAIN_ACCOUNT = 'api-key';
export const SETUP_COMMAND = `security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`;

const TTL_MS = 10 * 60_000;

export interface KeySource {
  read(): Promise<string | null>;
  forget?(): void;
}

/**
 * Reads the Linear API key from the macOS Keychain. The app never accepts the key through its own
 * API or stores it; the user adds it with `security add-generic-password` in a terminal.
 */
export class KeychainKeySource implements KeySource {
  private cached: { key: string | null; at: number } | null = null;

  async read(): Promise<string | null> {
    if (this.cached && Date.now() - this.cached.at < TTL_MS) return this.cached.key;

    const key = await new Promise<string | null>((resolve) => {
      execFile(
        'security',
        ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
        { timeout: 5000 },
        (error, stdout) => resolve(error ? null : stdout.trim() || null),
      );
    });

    if (key) registerSecret(key);

    this.cached = { key, at: Date.now() };

    return key;
  }

  forget(): void {
    this.cached = null;
  }
}
