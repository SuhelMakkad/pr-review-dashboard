import { expect, test } from '@playwright/test';
import { expectAccessible, openFresh } from '@/e2e/helpers';

// acme/api#2066 exists in the demo, but no search finds it: it is only tracked once added by hand.
const title = 'Cache product summaries per region';

test.describe.configure({ mode: 'serial' });

test('adds an untracked PR from the Not tracked screen, then removes it', async ({ page }) => {
  await openFresh(page, '/inbox/attention/acme/api/2066');

  await expect(page.getByRole('heading', { name: 'Not tracked' })).toBeVisible();
  await expect(page).toHaveScreenshot('not-tracked.png', {
    mask: [page.locator('[data-volatile]')],
  });
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Add to review queue' }).click();

  await expect(page.getByRole('heading', { level: 2 })).toHaveText(title);
  await expect(page.getByText('You added this PR to your queue')).toBeVisible();
  await expect(page.getByRole('option', { name: new RegExp(title) })).toHaveCount(1);

  await page.getByRole('button', { name: 'Remove from queue' }).click();
  await expect(page.getByRole('option', { name: new RegExp(title) })).toHaveCount(0);

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(page.getByRole('option', { name: new RegExp(title) })).toHaveCount(1);
});

test('adds a PR from the inbox header, explaining PRs it cannot find', async ({ page }) => {
  await openFresh(page, '/inbox/attention');
  await page.getByRole('button', { name: 'Add PR' }).click();

  const input = page.getByRole('textbox', { name: 'Pull request' });

  await input.fill('acme/api#9999');
  await input.press('Enter');
  await expect(page.getByText(/Couldn't find acme\/api#9999/)).toBeVisible();
  await expectAccessible(page);

  await input.fill('https://github.com/acme/api/pull/2066');
  await input.press('Enter');

  await expect(page).toHaveURL(/\/inbox\/attention\/acme\/api\/2066$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(title);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('adds a pasted PR from the command palette', async ({ page }) => {
  await openFresh(page, '/inbox/attention');
  await expect(page.getByRole('listbox', { name: /pull requests/i })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Jump to a PR/).fill('acme/api#2066');
  await page.getByRole('option', { name: 'Add acme/api#2066 to review queue' }).click();

  await expect(page).toHaveURL(/\/inbox\/attention\/acme\/api\/2066$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(title);
});
