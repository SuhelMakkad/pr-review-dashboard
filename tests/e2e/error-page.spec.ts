import { expect, test, type Page } from '@playwright/test';
import { expectAccessible, openFresh } from '@/e2e/helpers';

const crashed = 'Something went wrong on this page';

// The service worker only answers navigations; keep it out of the way of the routes below.
test.use({ serviceWorkers: 'block' });

/** Answers Insights with an empty body, so the page reads fields that are missing and crashes. */
async function crashInsights(page: Page) {
  await page.route(/\/api\/accounts\/[^/]+\/insights\?/, (route) => route.fulfill({ json: {} }));
}

const openInsights = (page: Page) =>
  page.getByRole('navigation', { name: 'Insights' }).getByRole('link').click();

test('a crashed page keeps the app frame, explains itself and leads back', async ({ page }) => {
  const volatile = { mask: [page.locator('[data-volatile]')] };

  await crashInsights(page);
  await openFresh(page, '/inbox/attention');
  await openInsights(page);

  await expect(page.getByRole('heading', { name: crashed })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Queues' })).toBeVisible();
  await expect(page).toHaveScreenshot('route-error.png', volatile);
  await expectAccessible(page);

  await page.getByRole('button', { name: 'Technical details' }).click();
  await expect(page.getByText(/TypeError/)).toBeVisible();
  await expect(page).toHaveScreenshot('route-error-details.png', volatile);
  await expectAccessible(page);

  await page.getByRole('link', { name: 'Go to your inbox' }).click();
  await expect(page.getByRole('listbox', { name: /needs attention pull requests/i })).toBeVisible();
  await expect(page.getByRole('heading', { name: crashed })).toHaveCount(0);
});

test('a page whose code fails to load offers a reload', async ({ page }) => {
  // TanStack reloads once on its own; the chunk fails again, so the page explains and offers more.
  await page.route(/\/assets\/insights-page-[\w-]+\.js$/, (route) => route.abort());
  await openFresh(page, '/inbox/attention');
  await openInsights(page);

  await expect(page.getByRole('heading', { name: "Couldn't load this page" })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reload', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Queues' })).toBeVisible();
  await expectAccessible(page);
});

test.describe('with motion on', () => {
  test.use({ reducedMotion: 'no-preference' });

  test('the page rises in, its details unfold, and copying confirms itself', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await crashInsights(page);
    await openFresh(page, '/inbox/attention');

    // Sample, frame by frame inside the page, how opaque the heading is drawn from the moment it
    // appears: it starts faded and settles fully opaque, so the entrance ran and finished.
    const entrance = page.evaluate(async (name) => {
      const frame = () => new Promise(requestAnimationFrame);
      const find = () => [...document.querySelectorAll('h3')].find((h) => h.textContent === name);
      const drawn = (element: Element) => {
        let opacity = 1;

        for (let node: Element | null = element; node; node = node.parentElement) {
          opacity *= Number(getComputedStyle(node).opacity);
        }

        return opacity;
      };

      while (!find()) await frame();

      const seen: number[] = [];

      for (let count = 0; count < 120 && seen.at(-1) !== 1; count++) {
        seen.push(drawn(find()!));
        await frame();
      }

      return seen;
    }, crashed);

    await openInsights(page);

    const seen = await entrance;

    expect(seen[0]).toBeLessThan(1);
    expect(seen.at(-1)).toBe(1);

    const toggle = page.getByRole('button', { name: 'Technical details' });

    await toggle.click();
    await expect(page.getByText(/TypeError/)).toBeVisible();
    await expect(toggle.locator('svg')).toHaveClass(/rotate-90/);

    await page.getByRole('button', { name: 'Copy details' }).click();
    await expect(page.getByText('Copied')).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Page: /insights');
    // It pops away again on its own.
    await expect(page.getByText('Copied')).toBeHidden({ timeout: 5_000 });

    await toggle.click();
    await expect(page.getByText(/TypeError/)).toBeHidden();
  });
});
