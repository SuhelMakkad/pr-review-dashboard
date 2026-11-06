import { expect, test } from '@playwright/test';
import { expectAccessible, openFresh } from '@/e2e/helpers';

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
  await expect(
    page.getByText('Connected to Acme with your Linear sign-in. Teams: DEMO.'),
  ).toBeVisible();
  await expectAccessible(page);
});

test('signs in to Linear from settings and signs out again', async ({ page }) => {
  await openFresh(page, '/settings');

  const linear = page.getByRole('region', { name: 'Linear' });

  await linear.getByRole('button', { name: 'Disconnect' }).click();
  await expect(page.getByText('Disconnected from Linear')).toBeVisible();
  await expect(linear.getByText('Use a personal API key instead')).toBeVisible();
  await expectAccessible(page);

  // Demo mode's "Linear" page is the local callback, so the whole round trip stays in the app.
  await linear.getByRole('button', { name: 'Connect Linear' }).click();
  await expect(page.getByText('Linear connected')).toBeVisible();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(
    linear.getByText('Connected to Acme with your Linear sign-in. Teams: DEMO.'),
  ).toBeVisible();
});
