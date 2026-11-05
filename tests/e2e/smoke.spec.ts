import { expect, test } from '@playwright/test';

test('demo mode serves the app with a per-launch session token', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByText('Demo data')).toBeVisible();
  await expect(page.locator('meta[name="review-desk-session"]')).toHaveAttribute(
    'content',
    /.{20,}/,
  );
});

test('writes without the session token are refused', async ({ page }) => {
  await page.goto('/');

  const status = await page.evaluate(async () => {
    const pulls = await (await fetch('/api/pulls')).json();
    const response = await fetch(`/api/pulls/${pulls.items[0].id}/triage`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-Review-Desk': '1' },
      body: JSON.stringify({ account: pulls.account, note: 'no token' }),
    });

    return response.status;
  });

  expect(status).toBe(401);
});
