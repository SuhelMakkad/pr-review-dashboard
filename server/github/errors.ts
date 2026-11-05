import { homedir } from 'node:os';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly retryAt: string | null = null,
    readonly status: number | null = null,
  ) {
    super(message);
  }
}

const registeredSecrets = new Set<string>();

/** Registers a runtime secret (session token, API key) so it is always redacted from diagnostics. */
export function registerSecret(secret: string): void {
  if (secret.length >= 8) registeredSecrets.add(secret);
}

const secretPatterns: RegExp[] = [
  /gh[opusr]_[A-Za-z0-9_]+/g,
  /github_pat_[A-Za-z0-9_]+/g,
  /lin_(?:api|oauth)_[A-Za-z0-9]+/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** `Authorization: Bearer <value>` style credentials keep their label so errors stay readable. */
const labelledCredential =
  /\b(authorization|bearer)(\s*[:=]?\s*)(?:token\s+|bearer\s+)?[A-Za-z0-9._~+/=-]{8,}/gi;

export function redact(text: string): string {
  let result = text;

  for (const pattern of secretPatterns) result = result.replace(pattern, '[redacted]');

  result = result.replace(
    labelledCredential,
    (_match, label: string, separator: string) => `${label}${separator}[redacted]`,
  );

  for (const secret of registeredSecrets) result = result.split(secret).join('[redacted]');

  const home = homedir();

  return home.length > 1 ? result.split(home).join('~') : result;
}

export function safeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);

  return redact(message).slice(0, 600);
}
