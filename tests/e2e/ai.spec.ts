import { expect, test, type Page } from '@playwright/test';
import { demoWrites, expectAccessible, failNextAi, openFresh } from '@/e2e/helpers';

test.describe.configure({ mode: 'serial' });

async function pauseNextAiStart(page: Page, pattern = '**/api/pulls/*/ai') {
  let markRequested!: () => void;
  let resume!: () => void;

  const requested = new Promise<void>((resolve) => {
    markRequested = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resume = resolve;
  });

  await page.route(
    pattern,
    async (route) => {
      markRequested();
      await resumed;

      await route.continue();
    },
    { times: 1 },
  );

  return { requested, resume };
}

test('shows immediate feedback while preparing a full review and running it again', async ({
  page,
}) => {
  await openFresh(page, '/inbox/attention/acme/web/1839');

  const report = page.getByRole('region', { name: 'Full review' });

  for (const label of ['Run review', 'Run again']) {
    const start = await pauseNextAiStart(page);

    await report.getByRole('button', { name: label, exact: true }).click();
    await start.requested;

    try {
      const button = report.getByRole('button', {
        name: label === 'Run review' ? 'Preparing review…' : 'Starting…',
        exact: true,
      });

      await expect(button).toBeDisabled();
      await expect(button).toHaveAttribute('aria-busy', 'true');
      await expect(report.getByText('No blocking findings')).not.toBeVisible();

      if (label === 'Run again') {
        await expect(report.getByRole('status')).toHaveText('Preparing review…');
        await expect(report.getByRole('button', { name: 'Prepare GitHub review' })).toHaveCount(0);
      }
    } finally {
      start.resume();
    }

    await expect(report.getByText('No blocking findings')).toBeVisible();
  }

  expect(await demoWrites(page)).toEqual([]);
});

test('shows a keyboard-started brief as busy and prevents duplicate starts', async ({ page }) => {
  await openFresh(page, '/pr/acme/web/1839/files');
  await expect(page.getByRole('navigation', { name: 'Changed files' })).toBeVisible();

  const start = await pauseNextAiStart(page);
  const requests: string[] = [];

  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().endsWith('/ai')) {
      requests.push(request.url());
    }
  });

  await page.keyboard.press('b');
  await start.requested;

  try {
    await expect(page.getByRole('tab', { name: '✦ Assist' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(page.getByRole('button', { name: /^Working…/ })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Choose the AI agent' }).first()).toBeDisabled();

    await page.keyboard.press('b');
    await page.keyboard.press('b');
  } finally {
    start.resume();
  }

  await expect(page.getByText('Look closely at')).toBeVisible();
  expect(requests).toHaveLength(1);
});

test('restores the previous review and allows retrying when a new review cannot start', async ({
  page,
}) => {
  await openFresh(page, '/inbox/attention/acme/web/1839');

  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await expect(report.getByText('No blocking findings')).toBeVisible();
  await page.route(
    '**/api/pulls/*/ai',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: 'The review could not start. Try again.' },
      }),
    { times: 1 },
  );
  await report.getByRole('button', { name: 'Run again', exact: true }).click();

  await expect(report.getByRole('alert')).toHaveText('The review could not start. Try again.');
  await expect(report.getByText('No blocking findings')).toBeVisible();
  await expect(report.getByRole('button', { name: 'Run again', exact: true })).toBeEnabled();

  await report.getByRole('button', { name: 'Run again', exact: true }).click();
  await expect(report.getByRole('alert')).toHaveCount(0);
  await expect(report.getByText('No blocking findings')).toBeVisible();
});

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
  await report.getByRole('button', { name: 'Use prepared review' }).click();
  await expect(sheet.getByText('1 inline comment')).toBeVisible();
  await sheet.getByRole('textbox').fill('Please cover the empty-input case.');
  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();

  await expect(sheet).not.toBeVisible();
  await expect(page).not.toHaveURL(/1839/);
  await page.goto('/pr/acme/web/1839');
  await expect(
    report.getByText('The implementation is mostly sound', { exact: false }),
  ).toBeVisible();

  await expect
    .poll(async () => (await demoWrites(page)).map((write) => write.op))
    .toEqual(['AddPendingReview', 'AddReviewThread', 'SubmitReview']);
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

  await expect
    .poll(async () => (await demoWrites(page)).map((write) => write.op))
    .toEqual(['AddPendingReview', 'SubmitReview']);
  const writes = await demoWrites(page);

  expect(writes.map((write) => write.op)).toEqual(['AddPendingReview', 'SubmitReview']);
  expect(writes[1].details).toMatchObject({ event: 'COMMENT', comments: 0 });
});

test('removes previously prepared findings when the selection changes, including after reload', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839');

  const report = page.getByRole('region', { name: 'Full review' });
  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();
  await expect(sheet.getByText('1 inline comment')).toBeVisible();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await page.reload();
  await report.getByRole('checkbox', { name: 'Include finding 1' }).uncheck();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();

  await expect(sheet.getByText('No inline comments')).toBeVisible();
  await expect(sheet.getByRole('textbox')).toHaveValue(
    'The implementation is mostly sound, but the empty-input behavior needs a regression test.',
  );
  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();

  await expect
    .poll(async () => (await demoWrites(page)).map((write) => write.op))
    .toEqual(['AddPendingReview', 'SubmitReview']);
});

test('confirms replacement of edited prepared content and keeps the old draft accessible', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839');

  const report = page.getByRole('region', { name: 'Full review' });
  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();
  await sheet.getByRole('textbox').fill('My edited review, saved before replacement.');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await report.getByRole('checkbox', { name: 'Include finding 1' }).uncheck();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();

  await expect(report.getByRole('alert')).toContainText('Your prepared review has edits.');
  await expect(sheet).not.toBeVisible();
  await report.getByRole('button', { name: 'View current draft' }).click();
  await expect(sheet.getByRole('textbox')).toHaveValue(
    'My edited review, saved before replacement.',
  );
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await report.getByRole('button', { name: 'Save a copy and replace' }).click();

  await expect(sheet.getByText('No inline comments')).toBeVisible();
  await expect(sheet.getByRole('textbox')).toHaveValue(
    'The implementation is mostly sound, but the empty-input behavior needs a regression test.',
  );
  await expectAccessible(page);
  await page.reload();
  await report.getByRole('button', { name: 'Use prepared review' }).click();
  await sheet.getByText('Saved drafts before replacement', { exact: true }).click();
  await sheet.getByText(/^Draft saved /).click();

  await expect(
    sheet.getByText('My edited review, saved before replacement.', { exact: true }),
  ).toBeVisible();
  await expect(
    sheet
      .locator('details')
      .filter({ hasText: /^Draft saved / })
      .getByText(/regression test for empty input/),
  ).toBeVisible();
  expect(await demoWrites(page)).toEqual([]);
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
  await sheet.getByRole('button', { name: 'Use generated summary' }).click();
  await expect(sheet.getByRole('textbox')).toHaveValue(/The direction looks right/);
});

test('keeps review startup loading when navigating away and returning', async ({ page }) => {
  await openFresh(page, '/pr/acme/web/1839');
  const start = await pauseNextAiStart(page);
  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await start.requested;

  try {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.goBack();
    await expect(
      report.getByRole('button', { name: 'Preparing review…', exact: true }),
    ).toBeDisabled();
    await expect(report.getByText(/continue in the background/)).toBeVisible();
  } finally {
    start.resume();
  }

  await expect(report.getByText('No blocking findings')).toBeVisible();
  await expect(report.getByText(/Generated/)).toBeVisible();
  await expect(report.getByRole('button', { name: 'Run again' })).toBeEnabled();
});

test('continues preparing after navigation and reopens the saved draft with edits', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839');
  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await expect(report.getByText('No blocking findings')).toBeVisible();

  const preparation = await pauseNextAiStart(page, '**/api/ai/runs/*/draft');

  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();
  await preparation.requested;

  try {
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.goBack();
    await expect(report.getByRole('button', { name: 'Preparing draft…' })).toBeDisabled();
    await expect(report.getByRole('status')).toContainText('preparation will continue');
  } finally {
    preparation.resume();
  }

  await expect(report.getByRole('button', { name: 'Use prepared review' })).toBeEnabled();
  await page.reload();
  await report.getByRole('button', { name: 'Use prepared review' }).click();

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await sheet.getByRole('textbox').fill('My saved review edits.');
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.goBack();
  await report.getByRole('button', { name: 'Use prepared review' }).click();

  await expect(sheet.getByRole('textbox')).toHaveValue('My saved review edits.');
  await expect(sheet.getByText('1 inline comment')).toBeVisible();
  expect(await demoWrites(page)).toEqual([]);
});

test('saves generated summaries across navigation and reload until explicitly used', async ({
  page,
}, testInfo) => {
  await openFresh(page, '/pr/acme/web/1839');
  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });
  const start = await pauseNextAiStart(page);

  await sheet.getByRole('textbox').fill('Keep my current summary.');
  await sheet.getByRole('button', { name: 'Draft summary' }).click();
  await start.requested;

  try {
    await sheet.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.goBack();
    await report.getByRole('button', { name: 'Use prepared review' }).click();
    await expect(sheet.getByRole('status')).toContainText('Starting summary…');
    await expect(sheet.getByRole('button', { name: 'Working…' })).toBeDisabled();
  } finally {
    start.resume();
  }

  await expect(sheet.getByRole('button', { name: 'Use generated summary' })).toBeEnabled();
  await expect(sheet.getByRole('textbox')).toHaveValue('Keep my current summary.');
  await page.reload();
  await report.getByRole('button', { name: 'Use prepared review' }).click();
  await expect(sheet.getByRole('button', { name: 'Generate new summary' })).toBeEnabled();
  await expect(
    sheet.getByRole('region', { name: 'Generated review summary' }).locator('time'),
  ).toHaveAttribute('datetime', /T/);
  await expectAccessible(page);
  await page.screenshot({ path: testInfo.outputPath('saved-summary.png') });

  await page.route(
    '**/api/ai/runs/*/summary',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: 'Could not load the generated summary. Try again.' },
      }),
    { times: 1 },
  );
  await sheet.getByRole('button', { name: 'Use generated summary' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Could not load the generated summary');
  await expect(sheet.getByRole('textbox')).toHaveValue('Keep my current summary.');
  await sheet.getByRole('button', { name: 'Use generated summary' }).click();
  await expect(sheet.getByRole('textbox')).toHaveValue(/The direction looks right/);
  expect(await demoWrites(page)).toEqual([]);
});

test('keeps preparation errors visible after navigation and allows retrying', async ({ page }) => {
  await openFresh(page, '/pr/acme/web/1839');
  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await page.route(
    '**/api/ai/runs/*/draft',
    (route) =>
      route.fulfill({
        status: 503,
        json: { error: 'Draft preparation is temporarily unavailable.' },
      }),
    { times: 1 },
  );
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();
  await expect(report.getByRole('alert')).toContainText('temporarily unavailable');
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await page.goBack();
  await expect(report.getByRole('alert')).toContainText('temporarily unavailable');
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();
  await expect(page.getByRole('dialog', { name: 'Finish your review' })).toBeVisible();
});

test('shows a saved-review loading error and allows retrying without starting another review', async ({
  page,
}) => {
  const pattern = '**/api/pulls/*/ai?*';

  await page.route(pattern, (route) =>
    route.request().method() === 'GET'
      ? route.fulfill({
          status: 503,
          json: { error: 'Saved reviews are temporarily unavailable.' },
        })
      : route.continue(),
  );
  await openFresh(page, '/pr/acme/web/1839');

  const report = page.getByRole('region', { name: 'Full review' });

  await expect(report.getByRole('alert')).toContainText(
    'Saved reviews are temporarily unavailable',
  );
  await expect(report.getByRole('button', { name: 'Run review', exact: true })).toHaveCount(0);
  await page.unroute(pattern);
  await report.getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(report.getByRole('button', { name: 'Run review', exact: true })).toBeEnabled();
});

test('retains a saved summary after a failed regeneration and marks it stale after a verdict change', async ({
  page,
}) => {
  await openFresh(page, '/pr/acme/web/1839');
  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await report.getByRole('button', { name: 'Prepare GitHub review' }).click();

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await sheet.getByRole('button', { name: 'Draft summary' }).click();
  await expect(sheet.getByRole('button', { name: 'Use generated summary' })).toBeEnabled();
  await failNextAi(page, 'Summary generation unavailable.');
  await sheet.getByRole('button', { name: 'Generate new summary' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Summary generation unavailable.');
  await expect(sheet.getByRole('button', { name: 'Use generated summary' })).toBeEnabled();
  await sheet.getByRole('button', { name: 'Close', exact: true }).click();
  await report.getByRole('button', { name: 'Use prepared review' }).click();
  await expect(sheet.getByRole('alert')).toContainText('Summary generation unavailable.');
  await sheet.getByRole('radio', { name: /Approve/ }).click();
  await expect(sheet.getByRole('button', { name: 'Use generated summary' })).toBeDisabled();
  await expect(sheet.getByText(/verdict or draft comments changed/)).toBeVisible();
  await sheet.getByRole('button', { name: 'Generate new summary' }).click();
  await expect(sheet.getByRole('button', { name: 'Use generated summary' })).toBeEnabled();
});

test('marks a full review out of date after new review discussion arrives', async ({ page }) => {
  await openFresh(page, '/pr/acme/api/2041');
  const report = page.getByRole('region', { name: 'Full review' });

  await report.getByRole('button', { name: 'Run review', exact: true }).click();
  await expect(report.getByText('No blocking findings')).toBeVisible();
  await page.evaluate(async () => {
    const token = document.querySelector<HTMLMetaElement>(
      'meta[name="review-desk-session"]',
    )!.content;

    const response = await fetch('/api/dev/advance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Review-Desk': '1',
        'X-Review-Desk-Session': token,
      },
      body: '{}',
    });

    if (!response.ok) throw new Error('Could not advance the demo review discussion.');
  });

  await expect(report.getByRole('button', { name: 'Prepare GitHub review' })).toBeDisabled();
  await expect(report.getByText(/review discussion changed/)).toBeVisible();
  await report.getByRole('button', { name: 'Regenerate', exact: true }).click();
  await expect(report.getByRole('button', { name: 'Prepare GitHub review' })).toBeEnabled();
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
