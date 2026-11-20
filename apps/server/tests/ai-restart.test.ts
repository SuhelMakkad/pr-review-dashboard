import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import type { AiRun } from '@review-desk/shared/ai';
import type { PullRequestList } from '@review-desk/shared/types';
import { startServer, stopServer, unusedPort } from '@test/fixtures/ai/restart-helper.js';

it.each(['SIGTERM', 'SIGKILL'] as const)(
  'automatically recovers running and queued reviews after %s and a new server process',
  async (signal) => {
    const directory = mkdtempSync(join(tmpdir(), 'review-desk-restart-'));
    const port = await unusedPort();
    const base = `http://127.0.0.1:${port}`;
    let child: ChildProcess | null = null;
    const request = async <T>(path: string, body?: unknown): Promise<T> => {
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
      return (await response.json()) as T;
    };

    try {
      child = await startServer(directory, port, 60_000);
      const pulls = await request<PullRequestList>('/api/accounts/you/pulls');
      const ids = [1839, 2041, 2050].map((number) => {
        const pull = pulls.items.find((item) => item.number === number);

        if (!pull) throw new Error(`Missing fixture pull request ${number}.`);

        return pull.id;
      });
      const runs: AiRun[] = [];

      for (const id of ids)
        runs.push(
          await request<AiRun>(`/api/accounts/you/pulls/${encodeURIComponent(id)}/ai`, {
            task: 'full_review',
          }),
        );
      for (const id of ids.slice(0, 2)) {
        await expect
          .poll(
            async () =>
              (
                await request<{ runs: AiRun[] }>(
                  `/api/accounts/you/pulls/${encodeURIComponent(id)}/ai`,
                )
              ).runs[0].progress,
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
              (
                await request<{ runs: AiRun[] }>(
                  `/api/accounts/you/pulls/${encodeURIComponent(run.prId)}/ai`,
                )
              ).runs[0].status,
          )
          .toBe('done');
        const saved = (
          await request<{ runs: AiRun[] }>(
            `/api/accounts/you/pulls/${encodeURIComponent(run.prId)}/ai`,
          )
        ).runs[0];

        expect(saved.id).toBe(run.id);
        expect(saved.createdAt).toBe(run.createdAt);
      }
      expect((await request<{ writes: unknown[] }>('/api/dev/writes')).writes).toEqual([]);
    } finally {
      if (child) await stopServer(child);
      rmSync(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
