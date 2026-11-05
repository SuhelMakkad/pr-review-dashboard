import { expect, test } from '@playwright/test';
import { expectAccessible, openFresh } from './helpers';

test.describe.configure({ mode: 'serial' });

test('re-reviews a force-pushed PR from the inbox, since your last review', async ({ page }) => {
  await openFresh(page, '/inbox/attention/acme/api/2041');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    'Product metadata schema with versioned migrations',
  );

  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/pr\/acme\/api\/2041\/files$/);
  await expect(
    page.getByRole('status').filter({ hasText: 'rebased or force-pushed' }),
  ).toBeVisible();
  await expect(page.getByRole('radio', { name: 'Since your review' })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  const tree = page.getByRole('navigation', { name: 'Changed files' });

  await expect(tree.getByText('5 files')).toBeVisible();
  await expect(tree.locator('[aria-current="true"]')).toContainText('0042_product_me');

  // The reply to your comment sits inline under its line.
  await expect(page.getByText('Good catch, batched in chunks of 5k now.')).toBeVisible();

  await page.keyboard.press('u');
  await expect(page).toHaveURL(/thread=t-2041-1/);
  await page.keyboard.press('u');
  await expect(page).toHaveURL(
    /file=src%2Ffacts%2Frepository\.ts.*thread=t-2041-2|thread=t-2041-2/,
  );
  await expect(page.getByText('Added in the migration.')).toBeVisible();

  await page.keyboard.press('d');
  await expect(page.getByRole('radio', { name: 'All changes' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await expect(tree.getByText('6 files')).toBeVisible();

  await page.keyboard.press('n');
  await expect(tree.locator('[aria-current="true"]')).toContainText('backfill.ts');
});

test('shows only the new commits after a fast-forward', async ({ page }) => {
  await openFresh(page, '/pr/acme/web/877/files');

  await expect(
    page.getByRole('status').filter({ hasText: 'New commits since your review' }),
  ).toBeVisible();
  await expect(
    page.getByRole('navigation', { name: 'Changed files' }).getByText('1 file', { exact: true }),
  ).toBeVisible();
});

test('collapses generated files until asked, and opens GitHub file links here', async ({
  page,
}) => {
  await openFresh(page, '/acme/api/pull/2041/files');
  await expect(page).toHaveURL(/\/pr\/acme\/api\/2041\/files$/);

  await page.getByRole('navigation', { name: 'Changed files' }).getByText('pnpm-lock.yaml').click();
  await expect(page.getByText(/Generated file/)).toBeVisible();

  await page.keyboard.press('x');
  await expect(page.getByText(/Generated file/)).toHaveCount(0);
});

test('workspace is accessible and matches the visual baseline', async ({ page }) => {
  await openFresh(page, '/pr/acme/api/2041/files');
  await expect(page.getByText('Good catch, batched in chunks of 5k now.')).toBeVisible();
  await page.waitForTimeout(500);

  // The diff body is a third-party renderer in its own shadow DOM; the chrome around it is ours.
  await expectAccessible(page, ['.diff-surface']);
  await expect(page).toHaveScreenshot('workspace-since-review.png', {
    mask: [page.locator('[data-volatile]')],
  });
});
