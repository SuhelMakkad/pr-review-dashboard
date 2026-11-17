import { expect, test, type Page } from '@playwright/test';
import { demoWrites, expectAccessible, openFresh } from '@/e2e/helpers';

test.describe.configure({ mode: 'serial' });

/** Applies the next scripted demo step and syncs; returns its label. */
async function advance(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;
    const response = await fetch('/api/dev/advance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Desk': '1',
        'X-Review-Desk-Session': token,
      },
      body: '{}',
    });

    return ((await response.json()) as { label: string | null }).label;
  });
}

test('reviews a newly requested PR automatically and leaves posting to you', async ({ page }) => {
  await openFresh(page, '/settings/automation');

  const toggle = page.getByRole('switch', { name: 'Review requested PRs automatically' });

  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(
    page.getByText('Requests already waiting when you turned this on are not reviewed.', {
      exact: false,
    }),
  ).toBeVisible();
  await expectAccessible(page);

  await page.goto('/inbox/attention');
  await expect(page.getByRole('listbox', { name: /pull requests/i })).toBeVisible();
  expect(await advance(page)).toMatch(/new reply/);
  expect(await advance(page)).toMatch(/new review request/);

  const row = page.getByRole('option').filter({ hasText: 'Reminder banner for upcoming events' });

  await expect(row.getByText('AI review ready')).toBeVisible();
  await expect(page.getByText(/^AI review ready · /)).toBeVisible();

  // Requests that were already waiting are not reviewed.
  await expect(page.getByRole('option').getByText(/^AI review/)).toHaveCount(1);

  await page.goto('/inbox/attention/acme/web/1846');

  const report = page.getByRole('region', { name: 'Full review' });

  await expect(
    report.getByText('Started automatically when your review was requested.', { exact: false }),
  ).toBeVisible();
  await expect(report.getByRole('button', { name: 'Prepare GitHub review' })).toBeVisible();
  expect(await demoWrites(page)).toEqual([]);
});

test('automatically approves a review with no blocking findings when posting is enabled', async ({
  page,
}) => {
  await openFresh(page, '/settings/automation');

  const post = page.getByRole('switch', { name: 'Post findings to the PR' });

  await expect(post).not.toBeChecked();

  // Saved back to back: the second save must not undo the first.
  await post.check();
  await page.getByRole('switch', { name: 'Review requested PRs automatically' }).check();
  await expect(
    page.getByText('Findings are posted to the PR when each review finishes.', { exact: false }),
  ).toBeVisible();
  await expectAccessible(page);

  await page.reload();
  await expect(post).toBeChecked();

  await page.goto('/inbox/attention');
  await expect(page.getByRole('listbox', { name: /pull requests/i })).toBeVisible();
  await advance(page);
  await advance(page);

  await expect
    .poll(async () => (await demoWrites(page)).map((write) => write.op))
    .toEqual(['ApproveReview']);
  await page.goto('/pr/acme/web/1846');

  const report = page.getByRole('region', { name: 'Full review' });

  await expect(report.getByText('Approved the PR.')).toBeVisible();
  await expect(report.getByRole('link', { name: 'Open on GitHub' })).toHaveAttribute(
    'href',
    /#pullrequestreview-/,
  );

  // Its own approval does not make the review out of date.
  await expect(report.getByText('Up to date', { exact: false })).toBeVisible();

  const writes = await demoWrites(page);

  expect(writes.map((write) => write.op)).toEqual(['ApproveReview']);
  expect(String(writes[0].details.body)).toContain('**AI review** · ');
});

test('resolves all open threads before automatically approving a completed review', async ({
  page,
}) => {
  await openFresh(page, '/settings/automation');
  await page.getByRole('switch', { name: 'Post findings to the PR' }).check();
  await expect(
    page.getByText(/approves the PR and resolves all open review threads/),
  ).toBeVisible();
  await page.goto('/pr/acme/api/2041');
  await page.getByRole('button', { name: 'Run review', exact: true }).click();

  const report = page.getByRole('region', { name: 'Full review' });

  await expect(report.getByText('Approved the PR.')).toBeVisible();
  await expect
    .poll(async () => (await demoWrites(page)).map((write) => write.op))
    .toEqual(['ResolveThread', 'ResolveThread', 'ApproveReview']);
});

test('does nothing when automatic review is off', async ({ page }) => {
  await openFresh(page, '/inbox/attention');
  await expect(page.getByRole('listbox', { name: /pull requests/i })).toBeVisible();
  await advance(page);
  await advance(page);

  await expect(
    page.getByRole('option').filter({ hasText: 'Reminder banner for upcoming events' }),
  ).toBeVisible();
  await expect(page.getByRole('option').getByText(/^AI review/)).toHaveCount(0);
});
