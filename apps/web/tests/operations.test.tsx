// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { githubCommand } from '@/lib/operation-command';

afterEach(() => {
  cleanup();
  localStorage.clear();
  vi.unstubAllGlobals();
});

const response = (body: unknown) => ({ ok: true, status: 202, json: async () => body }) as Response;

it('reuses the command ID after a lost acceptance response and creates a new ID for a later action', async () => {
  const ids: string[] = [];
  const fetch = vi.fn(async (_path: string, options: RequestInit) => {
    const { operationId } = JSON.parse(String(options.body));
    ids.push(operationId);
    if (ids.length === 1) throw new TypeError('Connection closed after acceptance');

    return response({ operation: { id: operationId } });
  });
  vi.stubGlobal('fetch', fetch);
  const path = `/api/test/${crypto.randomUUID()}`;

  await expect(githubCommand(path, { account: 'you', body: 'Saved reply' })).rejects.toThrow(
    'not reachable',
  );
  await githubCommand(path, { account: 'you', body: 'Saved reply' });
  await githubCommand(path, { account: 'you', body: 'Saved reply' });

  expect(ids[0]).toBe(ids[1]);
  expect(ids[2]).not.toBe(ids[1]);
});
