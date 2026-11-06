import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig, projectRoot, serverRoot } from '@/config.js';
import { migrationsFolder } from '@/db/migrate.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));

describe('workspace runtime paths', () => {
  it('keeps application data at the repository root and serves the web workspace build', () => {
    const config = loadConfig([], {});

    expect(resolve(projectRoot)).toBe(resolve(repositoryRoot));
    expect(config.dataDir).toBe(resolve(repositoryRoot, '.data'));
    expect(config.databasePath).toBe(resolve(repositoryRoot, '.data/review-desk.sqlite'));
    expect(config.webRoot).toBe(resolve(repositoryRoot, 'apps/web/dist'));
    expect(migrationsFolder).toBe(resolve(serverRoot, 'drizzle'));
  });

  it('uses the same repository data location during development and demo mode', () => {
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
