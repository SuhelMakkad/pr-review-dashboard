import { expect, test } from '@playwright/test';
import { demoWrites, failNextAi, openFresh } from './helpers';

test.describe.configure({ mode: 'serial' });

test('keeps a full review in the dashboard and posts selected findings only after submission', async ({
  page,
}) => {
  await openFresh(page, '/inbox/attention/acme/web/1839');
  await page.getByRole('button', { name: 'Run review', exact: true }).click();

  const report = page.getByRole('region', { name: 'Full review' });

  await expect(report.getByText('No blocking findings')).toBeVisible();
  await expect(
    report.getByText('The implementation is mostly sound', { exact: false }),
  ).toBeVisible();
  await expect(report.getByRole('checkbox', { name: 'Include finding 1' })).toBeChecked();
  expect(await demoWrites(page)).toEqual([]);

  await page.reload();
  await expect(
    report.getByText('The implementation is mostly sound', { exact: false }),
  ).toBeVisible();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await expect(sheet.getByRole('textbox')).toHaveValue(
    'The implementation is mostly sound, but the empty-input behavior needs a regression test.',
  );
  await expect(sheet.getByText('1 inline comment')).toBeVisible();
  await expect(sheet.getByRole('radio', { name: /Comment/ })).toBeChecked();
  expect(await demoWrites(page)).toEqual([]);

  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();
  await expect(sheet.getByText('1 inline comment')).toBeVisible();
  await sheet.getByRole('textbox').fill('Please cover the empty-input case.');
  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();

  await expect(sheet).not.toBeVisible();
  await expect(
    report.getByText('The implementation is mostly sound', { exact: false }),
  ).toBeVisible();

  const writes = await demoWrites(page);

  expect(writes.map((write) => write.op)).toEqual([
    'AddPendingReview',
    'AddReviewThread',
    'SubmitReview',
  ]);
  expect(writes[2].details).toMatchObject({
    event: 'COMMENT',
    comments: 1,
    body: 'Please cover the empty-input case.',
  });
});

test('lets the user exclude findings and post only the review summary', async ({ page }) => {
  await openFresh(page, '/pr/acme/web/1839');
  await page.getByRole('button', { name: 'Run review', exact: true }).click();

  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('checkbox', { name: 'Include finding 1' }).uncheck();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await expect(sheet.getByText('No inline comments')).toBeVisible();
  expect(await demoWrites(page)).toEqual([]);

  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();
  await expect(sheet).not.toBeVisible();

  const writes = await demoWrites(page);

  expect(writes.map((write) => write.op)).toEqual(['AddPendingReview', 'SubmitReview']);
  expect(writes[1].details).toMatchObject({ event: 'COMMENT', comments: 0 });
});

test('writes a brief with Codex by default, and with Claude on request', async ({ page }) => {
  await openFresh(page, '/inbox/attention/acme/web/1839');
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    'Calendar settings use the design-system tab buttons',
  );

  await page.keyboard.press('b');

  const brief = page
    .locator('div')
    .filter({ hasText: /^✦?\s*Brief/ })
    .first();

  await expect(page.getByText('Look closely at')).toBeVisible();
  await expect(page.getByText(/Codex · [0-9a-f]{7}/)).toBeVisible();
  await expect(
    page.getByText('AI-generated; check it against the code before relying on it.'),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Run again' }).first().click();
  await expect(page.getByText(/Codex · [0-9a-f]{7}/)).toBeVisible();
  expect(brief).toBeDefined();
});

test('suggests review comments and adds one to the draft without posting anything', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839/files');
  await expect(page.getByRole('navigation', { name: 'Changed files' })).toBeVisible();

  await page.keyboard.press('Shift+b');
  await expect(
    page.getByText('Mostly solid; one thing worth checking before merging.'),
  ).toBeVisible();
  await expect(page.getByText('(whole file)')).toBeVisible();

  await page.getByRole('button', { name: 'Add to review' }).first().click();
  await expect(page.getByText('AI suggestion you accepted · in your review')).toBeVisible();
  await expect(page.getByText('1 pending comment')).toBeVisible();
  expect(await demoWrites(page)).toEqual([]);
});

test('judges each of your threads since your review', async ({ page }) => {
  await openFresh(page, '/pr/acme/api/2041/files');
  await page.getByRole('tab', { name: '✦ Assist' }).click();
  await page
    .locator('text=What changed since your review')
    .locator('..')
    .getByRole('button', { name: 'Run' })
    .click();

  await expect(page.getByText('Addressed.')).toBeVisible();
  await expect(page.getByText('Partly.')).toBeVisible();

  await page.getByRole('button', { name: '0042_product_metadata.sql:18' }).click();
  await expect(page).toHaveURL(/thread=t-2041-1/);
});

test('shows agent failures and drafts a review summary', async ({ page }) => {
  await openFresh(page, '/inbox/attention/acme/api/2050');
  await failNextAi(page, 'Codex is not logged in.');
  await page.keyboard.press('b');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Codex is not logged in.' }),
  ).toBeVisible();

  await page.goto('/pr/acme/api/2050/files');
  await expect(page.getByRole('button', { name: /Finish review/ })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Changed files' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await sheet.getByRole('button', { name: 'Draft summary' }).click();
  await expect(sheet.getByRole('textbox')).toHaveValue(/The direction looks right/);
});

test('settings show the Codex plan and let a task pick one of its models', async ({ page }) => {
  await openFresh(page, '/settings');

  await expect(page.getByText('ChatGPT Plus')).toBeVisible();
  await expect(page.getByText(/5-hour: 35% used/)).toBeVisible();

  const model = () => page.getByRole('combobox', { name: 'Brief model' });
  const agent = page.getByRole('combobox', { name: 'Brief agent' });

  await expect(model()).toHaveValue('');
  await model().selectOption('gpt-demo-mini');
  await page.reload();
  await expect(model()).toHaveValue('gpt-demo-mini');

  // Model ids belong to Codex: another agent drops the choice.
  await agent.selectOption('claude');
  await expect(model()).toHaveCount(0);
  await agent.selectOption('');
  await expect(model()).toHaveValue('');
});
