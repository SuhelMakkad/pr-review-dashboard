import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { startServer, stopServer, unusedPort } from './fixtures/ai/restart-helper';

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'automatically recovers running and queued reviews after %s and a new server process',
  async (signal) => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-restart-'));
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    let child: ChildProcess | null = null;
    const request = async (path: string, body?: unknown) => {
      const response = await fetch(
        `${base}${path}`,
        body
          ? {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Review-Desk': '1',
                'X-Review-Desk-Session': 'recovery-test-session',
              },
              body: JSON.stringify(body),
            }
          : undefined,
      );

      expect(response.ok).toBe(true);
      return response.json();
    };

    try {
      child = await startServer(directory, port, 60_000);
      const pulls = await request('/api/pulls');
      const ids = [1839, 2041, 2050].map(
        (number) =>
          pulls.items.find((pull: { number: number }) => pull.number === number).id as string,
      );
      const runs = [];

      for (const id of ids)
        runs.push(
          await request(`/api/pulls/${encodeURIComponent(id)}/ai`, {
            account: 'you',
            task: 'full_review',
          }),
        );
      for (const id of ids.slice(0, 2)) {
        await expect
          .poll(
            async () =>
              (await request(`/api/pulls/${encodeURIComponent(id)}/ai?account=you`)).runs[0]
                .progress,
          )
          .toBe('Thinking…');
      }
      expect(runs[2].status).toBe('queued');
      await stopServer(child, signal);
      child = null;

      const db = new DatabaseSync(join(directory, 'state.sqlite'), { readOnly: true });
      const checkpoints = db
        .prepare('SELECT id, thread_id, status FROM ai_runs ORDER BY created_at, rowid')
        .all();

      db.close();
      expect(checkpoints.slice(0, 2).every((row) => typeof row.thread_id === 'string')).toBe(true);
      expect(checkpoints.map((row) => row.status)).toEqual(
        signal === 'SIGTERM' ? ['paused', 'paused', 'paused'] : ['running', 'running', 'queued'],
      );
      child = await startServer(directory, port, 5);

      for (const run of runs) {
        await expect
          .poll(
            async () =>
              (await request(`/api/pulls/${encodeURIComponent(run.prId)}/ai?account=you`)).runs[0]
                .status,
          )
          .toBe('done');
        const saved = (await request(`/api/pulls/${encodeURIComponent(run.prId)}/ai?account=you`))
          .runs[0];

        expect(saved.id).toBe(run.id);
        expect(saved.createdAt).toBe(run.createdAt);
      }
      expect((await request('/api/dev/writes')).writes).toEqual([]);
    } finally {
      if (child) await stopServer(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
