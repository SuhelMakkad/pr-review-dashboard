import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inlineScriptHashes } from './security.js';

export interface SessionMeta {
  token: string;
  bootId: string;
  demo: boolean;
}

const escapeAttribute = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Meta tags the browser reads at startup: the write token, the boot id and the demo flag. */
export function sessionMetaTags(meta: SessionMeta): string {
  return [
    `<meta name="review-desk-session" content="${escapeAttribute(meta.token)}" />`,
    `<meta name="review-desk-boot" content="${escapeAttribute(meta.bootId)}" />`,
    `<meta name="review-desk-demo" content="${meta.demo ? '1' : '0'}" />`,
  ].join('\n    ');
}

/** Loads the built index.html once and injects the per-launch session meta tags. */
export function loadIndexHtml(
  webRoot: string,
  meta: SessionMeta,
): { html: string; hashes: string[] } {
  const template = readFileSync(join(webRoot, 'index.html'), 'utf8');
  const html = template.replace('</head>', `    ${sessionMetaTags(meta)}\n  </head>`);

  return { html, hashes: inlineScriptHashes(html) };
}
