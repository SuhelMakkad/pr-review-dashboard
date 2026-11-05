import { expect, test } from '@playwright/test';
import { demoWrites, failNext, openFresh } from './helpers';

test.describe.configure({ mode: 'serial' });

const addedLine = (page: import('@playwright/test').Page, line: number) =>
  page
    .locator(`diffs-container [data-line-type="change-addition"][data-column-number="${line}"]`)
    .first();

test('drafts comments locally, then submits one review only after confirmation', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839/files');
  await expect(addedLine(page, 5)).toBeVisible();

  await addedLine(page, 5).click();
  await page.keyboard.press('c');
  await page
    .getByRole('textbox', { name: 'Comment on line 5' })
    .fill('Can this reuse the shared tabs helper?');
  await page.keyboard.press('ControlOrMeta+Enter');

  await expect(page.getByText('in your review, not posted yet')).toBeVisible();
  await expect(page.getByText('1 pending comment')).toBeVisible();
  expect(await demoWrites(page)).toEqual([]);

  await page.keyboard.press('ControlOrMeta+Shift+Enter');

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await expect(sheet.getByText('1 inline comment')).toBeVisible();
  await sheet.getByRole('textbox').fill('Nice cleanup overall.');
  await sheet.getByRole('radio', { name: /Approve/ }).click();
  await expect(sheet.getByText('Posts to GitHub as')).toContainText('@you');
  expect(await demoWrites(page)).toEqual([]);

  await sheet.getByRole('button', { name: 'Submit Approve to GitHub' }).click();
  await expect(page).toHaveURL(/\/inbox\/attention\/acme\//);

  const writes = await demoWrites(page);

  expect(writes.map((write) => write.op)).toEqual([
    'AddPendingReview',
    'AddReviewThread',
    'SubmitReview',
  ]);
  expect(writes[1].details).toMatchObject({
    path: 'src/scheduling/CalendarSettings.tsx',
    line: 5,
    side: 'RIGHT',
  });
  expect(writes[2].details).toMatchObject({
    event: 'APPROVE',
    body: 'Nice cleanup overall.',
    comments: 1,
  });
});

test('replies to and resolves a thread from the keyboard', async ({ page }) => {
  await openFresh(page, '/pr/acme/api/2041/files?mode=all');
  await expect(page.getByText('Good catch, batched in chunks of 5k now.')).toBeVisible();

  await page.keyboard.press('u');
  await page.keyboard.press('r');
  await page
    .getByRole('textbox', { name: 'Reply to thread' })
    .fill('Thanks, the batching looks right.');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect(page.getByText('Reply posted')).toBeVisible();
  await expect(page.getByText('Thanks, the batching looks right.')).toBeVisible();

  await page.keyboard.press('Shift+r');
  await expect
    .poll(async () => (await demoWrites(page)).map((write) => write.op))
    .toEqual(['ReplyToThread', 'ResolveThread']);
});

test('keeps your text when GitHub rejects a reply', async ({ page }) => {
  await openFresh(page, '/pr/acme/api/2041/files?mode=all');
  await expect(page.getByText('Good catch, batched in chunks of 5k now.')).toBeVisible();
  await failNext(page, 'ReplyToThread');

  await page.keyboard.press('u');
  await page.keyboard.press('r');

  const box = page.getByRole('textbox', { name: 'Reply to thread' });

  await box.fill('This should survive a failure.');
  await page.keyboard.press('ControlOrMeta+Enter');

  await expect(page.getByRole('alert').filter({ hasText: 'Injected failure' })).toBeVisible();
  await expect(box).toHaveValue('This should survive a failure.');
  expect(await demoWrites(page)).toEqual([]);
});

test('marks files viewed and moves on, and posts a file comment immediately', async ({ page }) => {
  await openFresh(page, '/pr/acme/web/1839/files');

  const tree = page.getByRole('navigation', { name: 'Changed files' });

  await expect(tree.getByText('0/3 viewed')).toBeVisible();

  const first = await tree.locator('[aria-current="true"]').innerText();

  await page.keyboard.press('v');
  await expect(tree.getByText('1/3 viewed')).toBeVisible();
  await expect(tree.locator('[aria-current="true"]')).not.toHaveText(first);

  await page.keyboard.press('c');
  await page
    .getByRole('textbox', { name: /^Comment on src\// })
    .fill('Overall this file reads well.');
  await page.keyboard.press('ControlOrMeta+Alt+Enter');
  await expect(page.getByText('Comment posted to GitHub')).toBeVisible();

  expect((await demoWrites(page)).map((write) => write.op)).toEqual([
    'MarkFileViewed',
    'AddPendingReview',
    'AddReviewThread',
    'SubmitReview',
  ]);
});
