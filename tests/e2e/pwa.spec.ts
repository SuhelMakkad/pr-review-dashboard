import { expect, test } from '@playwright/test';
import { expectAccessible, openFresh } from './helpers';

test.describe.configure({ mode: 'serial' });

async function advance(page: import('@playwright/test').Page) {
  return page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;

    await fetch('/api/dev/advance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Desk': '1',
        'X-Review-Desk-Session': token,
      },
      body: '{}',
    });
  });
}

test('is installable: manifest, icons and a service worker', async ({ page }) => {
  await openFresh(page, '/inbox/attention');

  const manifest = await page.request.get('/manifest.webmanifest');

  expect(manifest.status()).toBe(200);
  expect((await manifest.json()).start_url).toBe('/inbox/attention');
  expect((await page.request.get('/icons/icon-512.png')).headers()['content-type']).toBe(
    'image/png',
  );
  await expect
    .poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())))
    .toBe(true);
  await expect(page).toHaveTitle('(4) Review Desk');
});

test('shows new activity as a toast while you are looking at the app', async ({ page }) => {
  await openFresh(page, '/inbox/attention');
  await expect(page.getByRole('listbox', { name: /pull requests/i })).toBeVisible();

  await advance(page);
  await expect(page.getByText('New reply in a thread you joined')).toBeVisible();
});

test('sends a desktop notification when the window is in the background', async ({ page }) => {
  // Headless Chromium cannot show OS notifications, so the boundary is stubbed: permission is
  // granted, the window is unfocused, and showNotification calls are recorded.
  await page.addInitScript(() => {
    (window as unknown as { __notes: string[] }).__notes = [];
    document.hasFocus = () => false;
    Object.defineProperty(Notification, 'permission', { get: () => 'granted' });
    ServiceWorkerRegistration.prototype.showNotification = async function (
      title: string,
      options?: NotificationOptions,
    ) {
      (window as unknown as { __notes: string[] }).__notes.push(
        `${title} | ${options?.body} | ${JSON.stringify(options?.data)}`,
      );
    };
  });
  await openFresh(page, '/inbox/attention');
  await expect
    .poll(() => page.evaluate(async () => Boolean(await navigator.serviceWorker.getRegistration())))
    .toBe(true);

  await advance(page);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __notes: string[] }).__notes))
    .toEqual([
      'api#2041 · Product metadata schema with versioned migrations | New reply in a thread you joined | {"path":"/inbox/attention/acme/api/2041"}',
    ]);
});

test('notification settings are accessible', async ({ page }) => {
  await openFresh(page, '/settings');
  await expect(page.getByRole('checkbox', { name: 'Mentions' })).toBeChecked();
  await page.getByRole('checkbox', { name: 'Use quiet hours' }).check();
  await expect(
    page
      .getByRole('textbox', { name: 'Quiet hours start' })
      .or(page.getByLabel('Quiet hours start')),
  ).toHaveValue('19:00');
  await expectAccessible(page);
});
