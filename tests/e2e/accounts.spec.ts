import { expect, test } from '@playwright/test';
import { demoWrites, expectAccessible, openFresh } from '@/e2e/helpers';

// Demo mode has a second sign-in, you-personal. No feed returns a scenario PR for it, but it can
// add one by hand, so both accounts can track the same PR.
test.describe.configure({ mode: 'serial' });

test('switches to another GitHub CLI account and back, keeping each queue', async ({ page }) => {
  await openFresh(page, '/inbox/attention');

  const rows = page.getByRole('listbox', { name: /pull requests/i }).getByRole('option');

  await expect(rows.first()).toBeVisible();

  const count = await rows.count();

  await page.getByRole('button', { name: /^Switch GitHub account, now you\b(?!-)/ }).click();

  const menu = page.getByRole('menu');

  await expect(menu.getByRole('menuitemradio', { name: 'you', exact: true })).toBeChecked();
  await expect(menu.getByRole('menuitemradio', { name: 'you-personal' })).not.toBeChecked();
  await expectAccessible(page);

  await menu.getByRole('menuitemradio', { name: 'you-personal' }).click();

  await expect(page.getByText('Switched to you-personal')).toBeVisible();
  await expect(
    page.getByRole('button', { name: /^Switch GitHub account, now you-personal/ }),
  ).toBeVisible();
  await expect(rows).toHaveCount(0);

  await page.keyboard.press('ControlOrMeta+k');
  await page.getByPlaceholder(/Jump to a PR/).fill('switch github');
  await expect(
    page.getByRole('option', { name: 'Switch GitHub account to you-personal' }),
  ).toHaveCount(0);
  await page.getByRole('option', { name: 'Switch GitHub account to you', exact: true }).click();

  await expect(
    page.getByRole('button', { name: /^Switch GitHub account, now you\b(?!-)/ }),
  ).toBeVisible();
  await expect(rows).toHaveCount(count);
});

test('switches from Settings', async ({ page }) => {
  await openFresh(page, '/settings/github');

  const main = page.getByRole('main');

  await main.getByRole('button', { name: /^Switch GitHub account, now you\b(?!-)/ }).click();
  await page.getByRole('menuitemradio', { name: 'you-personal' }).click();

  await expect(
    main.getByRole('button', { name: /^Switch GitHub account, now you-personal/ }),
  ).toBeVisible();
});

test("keeps each account's private note on a PR both accounts track", async ({ page }) => {
  const id = 'PR_acme_api_2050';
  const note = page.getByRole('textbox', { name: 'Private note' });
  const savedNote = async () =>
    ((await (await page.request.get(`/api/pulls/${id}`)).json()) as { triage?: { note: string } })
      .triage?.note;
  const switchTo = async (login: string) => {
    await page.getByRole('button', { name: /^Switch GitHub account, now / }).click();
    await page.getByRole('menuitemradio', { name: login, exact: true }).click();
    // The sidebar names the account once the switch is done (it says "Switching…" until then);
    // toasts from earlier switches can still be showing, with the same text.
    await expect(
      page.getByRole('button', { name: new RegExp(`account, now ${login} via GitHub CLI`) }),
    ).toBeVisible();
  };
  /** Longer than the note's 800 ms autosave, so a wrong save would have reached the server. */
  const pastAutosave = () => page.waitForTimeout(1500);

  await openFresh(page, '/inbox/attention/acme/api/2050');
  await note.fill('Note for you');
  await expect.poll(savedNote).toBe('Note for you');

  await switchTo('you-personal');
  await page.getByRole('button', { name: 'Add to review queue' }).click();
  await expect(note).toHaveValue('');
  await note.fill('Note for personal');
  await expect.poll(savedNote).toBe('Note for personal');

  // Both accounts track this PR now, so its page stays open across each switch.
  await switchTo('you');
  await expect(note).toHaveValue('Note for you');
  await pastAutosave();
  expect(await savedNote()).toBe('Note for you');

  await switchTo('you-personal');
  await expect(note).toHaveValue('Note for personal');
  await pastAutosave();
  expect(await savedNote()).toBe('Note for personal');
});

test('saves a note held across a switch for the account it was written for', async ({ page }) => {
  const id = 'PR_acme_api_2050';
  const note = page.getByRole('textbox', { name: 'Private note' });
  const savedFor = async (login: string) =>
    (
      (await (await page.request.get(`/api/accounts/${login}/pulls/${id}`)).json()) as {
        triage?: { note: string };
      }
    ).triage?.note;
  const switchTo = async (login: string) => {
    await page.getByRole('button', { name: /^Switch GitHub account, now / }).click();
    await page.getByRole('menuitemradio', { name: login, exact: true }).click();
    await expect(
      page.getByRole('button', { name: new RegExp(`account, now ${login} via GitHub CLI`) }),
    ).toBeVisible();
  };

  // Both accounts track the PR, with notes of their own.
  await openFresh(page, '/inbox/attention/acme/api/2050');
  await note.fill('Note for you');
  await expect.poll(() => savedFor('you')).toBe('Note for you');
  await switchTo('you-personal');

  await page.getByRole('button', { name: 'Add to review queue' }).click();
  await expect(note).toHaveValue('');
  await note.fill('Personal note');
  await expect.poll(() => savedFor('you-personal')).toBe('Personal note');
  await switchTo('you');
  // The page has remounted for you once its note shows.
  await expect(note).toHaveValue('Note for you');

  // you's next save is held on its way to the server until the window has switched.
  const held: { continue: () => Promise<void> }[] = [];

  await page.route(`**/api/accounts/you/pulls/${id}/triage`, (route) => {
    held.push(route);
  });
  await note.fill('Held for you');
  await expect.poll(() => held.length).toBeGreaterThan(0);
  await switchTo('you-personal');
  await expect(note).toHaveValue('Personal note');

  // Released after the switch, it still saves for you, and you-personal's note is untouched.
  for (const route of held) await route.continue();
  await page.unroute(`**/api/accounts/you/pulls/${id}/triage`);

  // What the client does with the late reply is covered by the unit tests of its cache.
  await expect.poll(() => savedFor('you')).toBe('Held for you');
  expect(await savedFor('you-personal')).toBe('Personal note');
});

test('refuses a review sent from a window that missed a switch, queueing nothing', async ({
  page,
}) => {
  const id = 'PR_acme_web_1839';
  const draftFor = async (login: string) =>
    (
      (await (await page.request.get(`/api/accounts/${login}/pulls/${id}/draft`)).json()) as {
        body: string;
      }
    ).body;
  const operationsFor = async (login: string) =>
    (
      (await (await page.request.get(`/api/accounts/${login}/operations`)).json()) as {
        items: unknown[];
      }
    ).items;
  // Another window switches: this one's event stream is cut, so it still shows you.
  const switchElsewhere = (from: string, to: string) =>
    page.evaluate(
      async ({ from, to }) => {
        const token = document.querySelector<HTMLMetaElement>(
          'meta[name="review-desk-session"]',
        )!.content;

        await fetch('/api/accounts/switch', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Review-Desk': '1',
            'X-Review-Desk-Session': token,
          },
          body: JSON.stringify({ from, to }),
        });
      },
      { from, to },
    );

  await page.route('**/api/events', (route) => route.abort());
  await openFresh(page, '/pr/acme/web/1839/files');
  await expect(page.getByRole('button', { name: 'Finish review', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');

  const sheet = page.getByRole('dialog', { name: 'Finish your review' });

  await sheet.getByRole('textbox').fill('Written as you');
  await expect.poll(() => draftFor('you')).toBe('Written as you');

  await switchElsewhere('you', 'you-personal');
  await sheet.getByRole('button', { name: 'Submit Comment to GitHub' }).click();

  await expect(
    sheet.getByText("You're using you-personal now. Switch back to you to do this."),
  ).toBeVisible();
  expect(await operationsFor('you')).toEqual([]);
  expect(await demoWrites(page)).toEqual([]);

  // Back as you, the draft is as it was.
  await switchElsewhere('you-personal', 'you');
  await page.unroute('**/api/events');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Finish review', exact: true })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+Shift+Enter');
  await expect(sheet.getByRole('textbox')).toHaveValue('Written as you');
});
