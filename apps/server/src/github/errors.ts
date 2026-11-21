import { ForgeError as GitHubError } from '@/forge/port.js';

/** A forge's failure under its original name: one class, so `instanceof` holds either way. */
export { GitHubError };

/** Redaction lives in `redact.ts`; these names stay for the modules that import them here. */
export { redact, registerSecret, safeError } from '@/redact.js';
