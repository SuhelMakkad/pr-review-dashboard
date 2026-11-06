import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

export const SESSION_HEADER = 'x-review-desk-session';
export const LEGACY_WRITE_HEADER = 'x-review-desk';

export function createSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

export function tokensMatch(expected: string, received: unknown): boolean {
  if (typeof received !== 'string') return false;

  const left = Buffer.from(expected);
  const right = Buffer.from(received);

  return left.length === right.length && timingSafeEqual(left, right);
}

export function allowedHosts(ports: number[]): Set<string> {
  return new Set(ports.flatMap((port) => [`127.0.0.1:${port}`, `localhost:${port}`]));
}

export function allowedOrigins(ports: number[]): Set<string> {
  return new Set(ports.flatMap((port) => [`http://127.0.0.1:${port}`, `http://localhost:${port}`]));
}

const MUTATING = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

/** SHA-256 CSP sources for every inline `<script>` in an HTML document. */
export function inlineScriptHashes(html: string): string[] {
  const hashes: string[] = [];

  for (const match of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)) {
    hashes.push(`'sha256-${createHash('sha256').update(match[1]).digest('base64')}'`);
  }

  return hashes;
}

export function contentSecurityPolicy(scriptHashes: string[] = []): string {
  return [
    "default-src 'self'",
    `script-src 'self' ${scriptHashes.join(' ')}`.trim(),
    // Radix positioning and the diff renderer set inline styles.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ');
}

export interface SecurityOptions {
  ports: number[];
  sessionToken: string;
  /** Redirect localhost page loads to 127.0.0.1 so the app has one origin (PWA, storage). */
  canonicalRedirect: boolean;
  scriptHashes?: () => string[];
}

export function registerSecurity(app: FastifyInstance, options: SecurityOptions): void {
  const hosts = allowedHosts(options.ports);
  const origins = allowedOrigins(options.ports);

  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host?.toLowerCase();

    if (!host || !hosts.has(host)) {
      await reply.code(403).send({ error: 'Review Desk accepts local requests only.' });
      return;
    }

    const origin = request.headers.origin;

    if (origin && !origins.has(origin)) {
      await reply.code(403).send({ error: 'Cross-origin requests are not allowed.' });
      return;
    }

    const isApi = request.url.startsWith('/api/');

    if (
      options.canonicalRedirect &&
      request.method === 'GET' &&
      !isApi &&
      host.startsWith('localhost:')
    ) {
      await reply.redirect(`http://127.0.0.1:${host.split(':')[1]}${request.url}`, 308);
      return;
    }

    if (!MUTATING.has(request.method)) return;

    if (
      !request.headers['content-type']?.startsWith('application/json') ||
      request.headers[LEGACY_WRITE_HEADER] !== '1'
    ) {
      await reply.code(403).send({ error: 'A local JSON request is required.' });
      return;
    }

    if (!tokensMatch(options.sessionToken, request.headers[SESSION_HEADER])) {
      await reply.code(401).send({
        error: 'This Review Desk session has expired. Reload the page.',
        code: 'SESSION_EXPIRED',
      });
    }
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Content-Security-Policy', contentSecurityPolicy(options.scriptHashes?.() ?? []));

    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
}
