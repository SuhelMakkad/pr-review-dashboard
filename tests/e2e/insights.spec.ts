import { expect, test } from '@playwright/test';
import { expectAccessible, openFresh } from '@/e2e/helpers';

test('shows review speed, volume and verdicts from the backfilled history', async ({ page }) => {
  await openFresh(page, '/inbox/attention');
  await page.keyboard.press('g');
  await page.keyboard.press('t');
  await expect(page).toHaveURL(/\/insights$/);
  await expect(page.getByText(/History up to date/)).toBeVisible({ timeout: 15_000 });

  await page.getByRole('radio', { name: 'Last 90 days' }).click();
  await expect(page.getByText('Median time to review')).toBeVisible();
  await expect(page.getByText(/across \d+ review requests/)).toBeVisible();
  await expect(page.getByRole('img', { name: 'Queue size over time' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Review verdicts' })).toBeVisible();

  // Every chart has a table view, so no value is only reachable by hovering.
  const verdicts = page.getByRole('region', { name: 'Your verdicts' });

  await verdicts.getByRole('button', { name: 'Table' }).click();
  await expect(verdicts.getByRole('cell', { name: 'Changes requested' })).toBeVisible();

  await expectAccessible(page);
});

test('re-scores against a stricter review target', async ({ page }) => {
  await openFresh(page, '/insights');
  await expect(page.getByText(/History up to date/)).toBeVisible({ timeout: 15_000 });
  await page.getByRole('radio', { name: 'Last 90 days' }).click();

  const tile = page.getByText('Over your target').locator('..');
  const before = await tile.innerText();

  await page.getByLabel('Review target').selectOption('4');
  await expect(page.getByText(/target 4h/)).toBeVisible();
  await expect(tile).not.toHaveText(before);
});
