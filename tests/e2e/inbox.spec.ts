import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

const NOW = new Date('2026-11-05T10:00:00.000Z');

/** Restores the scenario and clears local triage so every test starts from the same state. */
async function resetDemo(page: Page) {
  await page.goto('/settings');
  await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;

    await fetch('/api/dev/reset', {
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

async function open(page: Page, path = '/') {
  await page.clock.setFixedTime(NOW);
  await resetDemo(page);
  await page.goto(path);
  await expect(page.getByRole('listbox', { name: /pull requests/i })).toBeVisible();
}

async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).analyze();
  const serious = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

  expect(
    serious.map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`,
    ),
  ).toEqual([]);
}

test.describe.configure({ mode: 'serial' });

test('triages from the keyboard: select, mark done, undo', async ({ page }) => {
  await open(page);

  const heading = page.getByRole('heading', { level: 2 });

  // Follow-ups first (oldest pending activity), then first reviews.
  await expect(heading).toHaveText('Rate-limit the public search endpoint');
  await page.keyboard.press('j');
  await expect(heading).toHaveText('Collection filter editor with live validation');
  await page.keyboard.press('j');
  await expect(heading).toHaveText('Product metadata schema with versioned migrations');

  await page.keyboard.press('e');
  await expect(heading).toHaveText('Calendar settings use the design-system tab buttons');
  await expect(page.getByRole('option', { name: /Product metadata schema/ })).toHaveCount(0);

  await page.keyboard.press('z');
  await expect(page.getByRole('option', { name: /Product metadata schema/ })).toHaveCount(1);
});

test('shows mentions in the conversation', async ({ page }) => {
  await open(page, '/inbox/attention/acme/api/2050');
  await expect(page.getByText('You were mentioned in the conversation')).toBeVisible();
  await expect(page.getByText('Mentions you')).toBeVisible();

  await page.keyboard.press('m');
  await expect(page.getByText('Mentions you')).toHaveCount(0);
});

test('receives live updates over server-sent events', async ({ page }) => {
  await open(page, '/inbox/attention/acme/api/2041');
  await expect(page.getByText('2 new replies in threads you joined')).toBeVisible();

  const response = await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;
    const result = await fetch('/api/dev/advance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Desk': '1',
        'X-Review-Desk-Session': token,
      },
      body: '{}',
    });

    return result.json();
  });

  expect(response.label).toMatch(/new reply/);
  await expect(page.getByText('3 new replies in threads you joined')).toBeVisible();
});

test('deep links, palette navigation and GitHub-style paths', async ({ page }) => {
  await open(page, '/inbox/waiting');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Waiting on author');

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Jump to a PR/).fill('structured logging');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/pr\/acme\/api\/2033$/);
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    'Structured logging for the indexing worker',
  );

  await page.goto('/acme/web/pull/1839/files');
  await expect(page).toHaveURL(/\/pr\/acme\/web\/1839$/);
});

test('has no serious accessibility violations', async ({ page }) => {
  await open(page);
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await expectAccessible(page);

  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expectAccessible(page);
});

test('matches the visual baseline', async ({ page }) => {
  await open(page, '/inbox/attention/acme/api/2041');
  await expect(page.getByRole('heading', { level: 2 })).toBeVisible();
  await expect(page).toHaveScreenshot('inbox-reading-pane.png', {
    mask: [page.locator('[data-volatile]')],
  });

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByPlaceholder(/Jump to a PR/)).toBeVisible();
  await expect(page).toHaveScreenshot('command-palette.png', {
    mask: [page.locator('[data-volatile]')],
  });
});
