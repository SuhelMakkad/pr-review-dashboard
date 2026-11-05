import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';

export const NOW = new Date('2026-11-05T10:00:00.000Z');

/** Restores the demo scenario and clears local triage so every test starts from the same state. */
export async function resetDemo(page: Page) {
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

export async function openFresh(page: Page, path: string) {
  await page.clock.setFixedTime(NOW);
  await resetDemo(page);
  await page.goto(path);
}

export async function expectAccessible(page: Page, exclude: string[] = []) {
  let builder = new AxeBuilder({ page });

  for (const selector of exclude) builder = builder.exclude(selector);

  const results = await builder.analyze();
  const serious = results.violations.filter((violation) =>
    ['serious', 'critical'].includes(violation.impact ?? ''),
  );

  expect(
    serious.map(
      (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target).join(', ')}`,
    ),
  ).toEqual([]);
}

export async function demoWrites(
  page: Page,
): Promise<{ op: string; details: Record<string, unknown> }[]> {
  return (await (await page.request.get('/api/dev/writes')).json()).writes;
}

/** Makes the next GitHub write with this name fail once. */
export async function failNext(page: Page, op: string) {
  await page.evaluate(async (name) => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;

    await fetch('/api/dev/fail', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Desk': '1',
        'X-Review-Desk-Session': token,
      },
      body: JSON.stringify({ op: name }),
    });
  }, op);
}
