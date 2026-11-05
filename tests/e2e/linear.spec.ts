import { expect, test } from '@playwright/test';
import { expectAccessible, openFresh } from './helpers';

test('shows the linked Linear issue next to the PR and in the queue', async ({ page }) => {
  await openFresh(page, '/inbox/attention/acme/api/2041');

  const linear = page.getByRole('region', { name: 'Linear' });

  await expect(linear.getByText('Store extracted product metadata')).toBeVisible();
  await expect(linear.getByText('In Progress')).toBeVisible();
  await expect(linear.getByRole('link')).toHaveAttribute(
    'href',
    'https://linear.app/acme/issue/demo-101',
  );
  await expect(
    page.getByRole('option', { name: /Product metadata schema/ }).getByText('DEMO-101'),
  ).toBeVisible();
});

test('settings show AI agents and the Linear connection', async ({ page }) => {
  await openFresh(page, '/settings');

  await expect(page.getByRole('radio', { name: 'Codex' })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByText('Codex: demo')).toBeVisible();
  await expect(page.getByText('Connected to Acme. Teams: DEMO.')).toBeVisible();
  await expectAccessible(page);
});
