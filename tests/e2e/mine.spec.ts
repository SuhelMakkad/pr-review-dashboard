import { expect, test } from '@playwright/test';
import { demoWrites, expectAccessible, openFresh } from './helpers';

test.describe.configure({ mode: 'serial' });

test('groups your PRs by whose move it is and explains each blocker', async ({ page }) => {
  await openFresh(page, '/inbox/attention');
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await expect(page).toHaveURL(/\/mine$/);

  const list = page.getByRole('listbox', { name: 'My pull requests' });

  await expect(
    list
      .getByRole('group')
      .evaluateAll((groups) => groups.map((group) => group.getAttribute('aria-label'))),
  ).resolves.toEqual(['Needs you', 'Waiting on reviewers', 'Ready to merge', 'Drafts']);

  await page.keyboard.press('j');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    'Retry webhooks with exponential backoff',
  );

  const blockers = page.getByRole('region', { name: 'What blocks this PR' });

  await expect(blockers.getByText('Checks are failing')).toBeVisible();
  await expect(blockers.getByText('Changes requested by mara')).toBeVisible();
  await expect(blockers.getByText(/thread is waiting for your reply/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Snooze' })).toHaveCount(0);
  await expectAccessible(page);
});

test('re-requests a review from the author view', async ({ page }) => {
  await openFresh(page, '/mine/acme/api/3001');

  await page.getByRole('button', { name: 'Ask mara to review' }).click();
  await expect(page.getByText('Review requested from mara')).toBeVisible();
  expect((await demoWrites(page)).map((write) => write.op)).toEqual(['RequestReviews']);
});

test('flags reviews waiting past the one-day target', async ({ page }) => {
  await openFresh(page, '/mine/acme/web/882');

  const blockers = page.getByRole('region', { name: 'What blocks this PR' });

  await expect(blockers.getByText('Waiting for jonas')).toBeVisible();
  await expect(
    blockers.getByText(/Waiting \d+ hours for review — past the one-day mark/),
  ).toBeVisible();
});
