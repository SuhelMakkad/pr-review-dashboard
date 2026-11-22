import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, projectRoot, serverRoot } from '@/config.js';
import { migrationsFolder } from '@/db/migrate.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('workspace runtime paths', () => {
  it('keeps application data in the OS folder, moved from the checkout’s, and serves the web build', () => {
    const config = loadConfig([], {}, { platform: 'darwin', home: '/Users/you' });
    const folder = '/Users/you/Library/Application Support/Review Desk';

    expect(resolve(projectRoot)).toBe(resolve(repositoryRoot));
    expect(config.dataDir).toBe(folder);
    expect(config.databasePath).toBe(`${folder}/review-desk.sqlite`);
    expect(config.dataLocation.legacy).toBe(resolve(repositoryRoot, '.data'));
    expect(config.webRoot).toBe(resolve(repositoryRoot, 'apps/web/dist'));
    expect(migrationsFolder).toBe(resolve(serverRoot, 'drizzle'));
  });

  it('keeps demo mode’s data in the checkout, with its own ports', () => {
    const config = loadConfig(['--dev'], { REVIEW_DESK_MODE: 'demo' });

    expect(config.dataDir).toBe(resolve(repositoryRoot, '.data-demo'));
    expect(config.webRoot).toBeNull();
    expect(config.allowedPorts).toEqual([4320, 4319]);
  });

  it('resolves relative data overrides from the repository root', () => {
    const config = loadConfig([], { REVIEW_DESK_DATA_DIR: '.data-test' });

    expect(config.dataDir).toBe(resolve(repositoryRoot, '.data-test'));
  });
});
