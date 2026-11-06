import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { startServer, stopServer, unusedPort } from '@/fixtures/ai/restart-helper';
import { expectAccessible } from '@/e2e/helpers';

test('keeps a user-paused review across navigation and restart, then resumes the same run', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-desk-browser-recovery-'));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;

  try {
    child = await startServer(directory, port, 60_000, resolve('apps/web/dist'));
    await page.goto(`${base}/pr/acme/web/1839`);
    const report = page.getByRole('region', { name: 'Full review' });
    const started = page.waitForResponse(
      (response) => response.url().endsWith('/ai') && response.request().method() === 'POST',
    );

    await report.getByRole('button', { name: 'Run review', exact: true }).click();
    const run = await (await started).json();

    await expect(report.getByRole('status')).toContainText('Thinking…');
    await report.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(report.getByRole('status')).toHaveText('Paused. Your progress is saved.');
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.goBack();
    await expect(report.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled();
    await expectAccessible(page);

    await stopServer(child);
    child = await startServer(directory, port, 5, resolve('apps/web/dist'));
    await page.reload();
    await expect(report.getByRole('status')).toHaveText('Paused. Your progress is saved.');
    await page.route(
      '**/api/ai/runs/*/resume',
      (route) =>
        route.fulfill({
          status: 503,
          json: { error: 'Resume is temporarily unavailable. Try again.' },
        }),
      { times: 1 },
    );
    await report.getByRole('button', { name: 'Resume', exact: true }).click();
    await expect(report.getByRole('alert')).toContainText('Resume is temporarily unavailable');

    const resuming = page.waitForResponse((response) => response.url().endsWith('/resume'));

    await report.getByRole('button', { name: 'Resume', exact: true }).click();
    expect((await (await resuming).json()).id).toBe(run.id);
    await expect(report.getByText('No blocking findings')).toBeVisible();
    expect((await (await page.request.get(`${base}/api/dev/writes`)).json()).writes).toEqual([]);
  } finally {
    if (child) await stopServer(child);
    rmSync(directory, { recursive: true, force: true });
  }
});

test('automatically resumes a running review after a server restart without starting another review', async ({
  page,
}) => {
  const directory = mkdtempSync(join(tmpdir(), 'review-desk-browser-recovery-'));
  const port = await unusedPort();
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | null = null;
  const starts: string[] = [];

  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/ai')) starts.push(request.url());
  });

  try {
    child = await startServer(directory, port, 60_000, resolve('apps/web/dist'));
    await page.goto(`${base}/pr/acme/web/1839`);
    const report = page.getByRole('region', { name: 'Full review' });

    await report.getByRole('button', { name: 'Run review', exact: true }).click();
    await expect(report.getByRole('status')).toContainText('Thinking…');
    await stopServer(child);
    child = await startServer(directory, port, 5, resolve('apps/web/dist'));
    await page.reload();

    await expect(report.getByText('No blocking findings')).toBeVisible();
    expect(starts).toHaveLength(1);
    await expect(report.getByRole('button', { name: 'Prepare GitHub review' })).toBeEnabled();
  } finally {
    if (child) await stopServer(child);
    rmSync(directory, { recursive: true, force: true });
  }
});
