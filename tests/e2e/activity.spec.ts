import { expect, test, type Page } from '@playwright/test';
import type { OperationList } from '@review-desk/shared/operations';
import { demoWrites, expectAccessible, failNext, openFresh } from '@/e2e/helpers';

test.describe.configure({ mode: 'serial' });

async function command(page: Page, path: string, body: Record<string, unknown>) {
  return page.evaluate(
    async ({ path, body }) => {
      const token = document.querySelector<HTMLMetaElement>(
        'meta[name="review-desk-session"]',
      )!.content;
      const response = await fetch(path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Review-Desk': '1',
          'X-Review-Desk-Session': token,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) throw new Error(await response.text());

      return response.json();
    },
    { path, body },
  );
}

async function activity(page: Page) {
  await page.getByRole('button', { name: /^Activity/ }).click();

  return page.getByRole('dialog', { name: 'Activity', exact: true });
}

async function operations(page: Page): Promise<OperationList> {
  return (await page.request.get('/api/accounts/you/operations')).json();
}

test('queues a review, advances from the inbox, and keeps its result after navigation and reload', async ({
  page,
}) => {
  await openFresh(page, '/inbox/attention/acme/web/1839');
  await command(page, '/api/dev/operations', { delayMs: 1200 });
  // Enter opens the files of the PR shown, so the PR must have loaded first.
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/files\?inbox=attention/);
  // The workspace loads after the URL changes; its shortcuts exist once it shows.
  await expect(page.getByRole('button', { name: /Finish review/ })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });
  await sheet.getByRole('radio', { name: /Approve/ }).click();
  await sheet.getByRole('textbox').fill('Saved review survives navigation.');
  await sheet.getByRole('button', { name: 'Submit Approve to GitHub' }).click();

  await expect(page).toHaveURL(/\/inbox\/attention\/acme\//);
  await expect(page).not.toHaveURL(/1839/);
  expect(await demoWrites(page)).toEqual([]);

  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.reload();
  const drawer = await activity(page);
  await expect(drawer.getByText('Submit approval', { exact: true })).toBeVisible();
  await expect(drawer.getByText('Confirmed by GitHub', { exact: true })).toBeVisible({
    timeout: 10_000,
  });
  await drawer.getByText('Saved content and details').click();
  await expect(
    drawer.getByText('Saved review survives navigation.', { exact: true }),
  ).toBeVisible();
  await expectAccessible(page, ['.diff-surface']);
});

test('locks the queued review across reloads and another browser tab', async ({
  page,
  context,
}) => {
  await openFresh(page, '/pr/acme/web/1839/files');
  await command(page, '/api/dev/operations', { delayMs: 2000 });
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  const sheet = page.getByRole('dialog', { name: 'Finish your review' });
  await sheet.getByRole('textbox').fill('Exact queued snapshot.');
  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();
  await expect(page).toHaveURL(/\/pr\/acme\/web\/1839\/files/);

  const other = await context.newPage();
  await other.goto('/pr/acme/web/1839/files');
  await expect(other.getByRole('button', { name: 'Review queued · View activity' })).toBeVisible();
  await other.keyboard.press('ControlOrMeta+Shift+Enter');
  const lockedSheet = other.getByRole('dialog', { name: 'Finish your review' });
  await expect(lockedSheet.getByRole('textbox')).toBeDisabled();
  await expect(
    lockedSheet.getByRole('button', { name: 'Review queued', exact: true }),
  ).toBeDisabled();
  await other.close();
});

test('restores a rejected reply into its editor without losing text', async ({ page }) => {
  await openFresh(page, '/pr/acme/api/2041/files?mode=all');
  await expect(page.getByText('Good catch, batched in chunks of 5k now.')).toBeVisible();
  await failNext(page, 'ReplyToThread');
  await page.keyboard.press('u');
  await page.keyboard.press('r');
  const body = 'Keep this reply through background failure.';
  await page.getByRole('textbox', { name: 'Reply to thread' }).fill(body);
  await page.keyboard.press('ControlOrMeta+Enter');

  const drawer = await activity(page);
  await expect(drawer.getByText(/Injected failure/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Return to draft' }).click();
  await expect(page.getByRole('textbox', { name: 'Reply to thread' })).toHaveValue(body);
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect
    .poll(
      async () => (await demoWrites(page)).filter((write) => write.op === 'ReplyToThread').length,
    )
    .toBe(1);
});

test('keeps an accepted reply with a lost response unconfirmed without duplicate retries', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/api/2041/files?mode=all');
  await expect(page.getByText('Good catch, batched in chunks of 5k now.')).toBeVisible();
  await command(page, '/api/dev/fail', { op: 'ReplyToThread', after: true });
  await page.keyboard.press('u');
  await page.keyboard.press('r');
  await page
    .getByRole('textbox', { name: 'Reply to thread' })
    .fill('Check GitHub before repeating this reply.');
  await page.keyboard.press('ControlOrMeta+Enter');

  const drawer = await activity(page);
  await expect(drawer.getByText('Unconfirmed', { exact: true })).toBeVisible();
  await expect(drawer.getByRole('button', { name: 'Retry remaining steps' })).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Check GitHub', exact: true }).click();
  await expect(drawer.getByText('Unconfirmed', { exact: true })).toBeVisible();
  await page.reload();
  const reopened = await activity(page);
  await expect(reopened.getByText('Unconfirmed', { exact: true })).toBeVisible();
  expect((await demoWrites(page)).filter((write) => write.op === 'ReplyToThread')).toHaveLength(1);
  await expectAccessible(page, ['.diff-surface']);
});

test('preserves a partial review and restores an editable draft through confirmed cleanup', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839/files');
  await expect(page.getByRole('navigation', { name: 'Changed files' })).toBeVisible();
  await page.keyboard.press('c');

  const composer = page.getByRole('textbox', { name: /^Comment on src\// });

  await composer.fill('Keep the entire file comment.');
  await page.keyboard.press('ControlOrMeta+Enter');
  // Saved as a draft before the review is finished: the shortcut does nothing while it is open.
  await expect(composer).not.toBeVisible();
  await failNext(page, 'SubmitReview');
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  const sheet = page.getByRole('dialog', { name: 'Finish your review' });
  await sheet.getByRole('textbox').fill('Preserve this summary too.');
  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();

  const drawer = await activity(page);
  await expect(drawer.getByRole('button', { name: 'Restore editable draft' })).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await drawer.getByRole('button', { name: 'Restore editable draft' }).click();
  await expect
    .poll(
      async () =>
        (await operations(page)).items.find((item) => item.action.type === 'discard')?.status,
    )
    .toBe('succeeded');
  await drawer.getByRole('button', { name: 'Close activity' }).click();
  await expect(page.getByRole('button', { name: 'Finish review', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(sheet.getByRole('textbox')).toHaveValue('Preserve this summary too.');
  await expect(sheet.getByText('Keep the entire file comment.', { exact: true })).toBeVisible();
  expect((await demoWrites(page)).map((write) => write.op)).toEqual([
    'AddPendingReview',
    'AddReviewThread',
    'DeleteReview',
  ]);
});
