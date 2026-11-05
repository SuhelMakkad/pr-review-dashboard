import { expect, test } from '@playwright/test';

test('demo mode serves the dashboard with the scenario workload', async ({ page }) => {
  await page.goto('/');

  await expect(
    page.getByText('Product metadata schema with versioned migrations').first(),
  ).toBeVisible();
  await expect(page.locator('meta[name="review-desk-session"]')).toHaveAttribute(
    'content',
    /.{20,}/,
  );
});

test('writes carry the session token end to end', async ({ page }) => {
  await page.goto('/');

  const status = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;
    const pulls = await (await fetch('/api/pulls')).json();
    const response = await fetch(`/api/pulls/${pulls.items[0].id}/triage`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Desk': '1',
        'X-Review-Desk-Session': token,
      },
      body: JSON.stringify({ account: pulls.account, note: 'from e2e' }),
    });

    return response.status;
  });

  expect(status).toBe(200);
});
