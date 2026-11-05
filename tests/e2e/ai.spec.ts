import { expect, test } from '@playwright/test';
import { demoWrites, failNextAi, openFresh } from './helpers';

test.describe.configure({ mode: 'serial' });

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
