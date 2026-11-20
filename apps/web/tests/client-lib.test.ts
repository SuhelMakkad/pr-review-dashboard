import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { deriveItem, emptyTriage } from '@review-desk/shared/attention';
import { matchesFilters } from '@/features/inbox/filters';
import { filesUrl, formatRef, parsePrRef, placeRef, refOf } from '@/lib/pr-ref';
import { adoptStatus, handle, refresh } from '@/lib/live';
import { applyOptimistic, runTriage } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';
import { keyCaps } from '@/lib/shortcuts';
import { parseSnooze, shortAge, snoozePresets } from '@/lib/time';
import { review, snapshot, status, thread } from '@test/fixtures';

// Thursday 5 November 2026, 10:30 local time.
const now = new Date(2026, 10, 5, 10, 30);
const local = (day: number, hours: number, minutes = 0) =>
  new Date(2026, 10, day, hours, minutes).getTime();

describe('snooze parsing', () => {
  it.each([
    ['2h', now.getTime() + 2 * 3_600_000],
    ['in 30 min', now.getTime() + 30 * 60_000],
    ['3 days', now.getTime() + 3 * 86_400_000],
    ['tomorrow', local(6, 9)],
    ['tomorrow 2pm', local(6, 14)],
    ['tmrw 14:30', local(6, 14, 30)],
    ['fri', local(6, 9)],
    ['monday 10am', local(9, 10)],
    ['thu', local(12, 9)],
    ['next week', local(9, 9)],
    ['tonight', local(5, 18)],
    ['4pm', local(5, 16)],
    ['9am', local(6, 9)],
    ['3', local(5, 15)],
  ])('understands "%s"', (text, expected) => {
    expect(parseSnooze(text, now)?.getTime()).toBe(expected);
  });

  it.each(['', 'whenever', 'yesterday', '0h', 'tomorrow at noonish'])('rejects "%s"', (text) => {
    expect(parseSnooze(text, now)).toBeNull();
  });

  it('offers presets that are always in the future', () => {
    for (const hour of [6, 12, 13, 16, 17, 22]) {
      const at = new Date(2026, 10, 5, hour);

      for (const preset of snoozePresets(at))
        expect(preset.until.getTime()).toBeGreaterThan(at.getTime());
    }

    expect(snoozePresets(now).map((preset) => preset.label)).toEqual([
      'In 1 hour',
      'This afternoon',
      'Tomorrow morning',
      'Next week',
    ]);
  });

  it('formats compact ages', () => {
    const base = Date.parse('2026-11-05T10:00:00Z');

    expect(shortAge('2026-11-05T09:59:30Z', base)).toBe('now');
    expect(shortAge('2026-11-05T09:15:00Z', base)).toBe('45m');
    expect(shortAge('2026-11-04T10:00:00Z', base)).toBe('1d');
    expect(shortAge('2026-10-01T10:00:00Z', base)).toBe('5w');
  });
});

describe('client helpers', () => {
  const item = deriveItem(
    snapshot({ headOid: 'new', reviews: [review({ commitOid: 'old' })], threads: [thread()] }),
    emptyTriage(),
    'me',
    [],
  );

  it('predicts triage effects for instant feedback', () => {
    const at = Date.parse('2026-11-05T10:00:00Z');

    expect(applyOptimistic(item, { done: true }, at)).toMatchObject({
      queue: 'caught_up',
      doneAt: '2026-11-05T10:00:00.000Z',
    });
    expect(applyOptimistic(item, { snoozeUntil: '2026-11-06T09:00:00.000Z' }, at)).toMatchObject({
      queue: 'snoozed',
    });
    expect(applyOptimistic(item, { note: '  ' }, at).hasNote).toBe(false);

    const seen = applyOptimistic(item, { seenReplyKeys: item.unreadReplyKeys }, at);

    expect(seen.unreadReplyKeys).toEqual([]);
    expect(seen.reasons.some((reason) => reason.kind === 'reply')).toBe(false);
    expect(seen.reasons.some((reason) => reason.kind === 'changed')).toBe(true);
  });

  it('filters by free text terms and structured filters', () => {
    expect(matchesFilters(item, { q: 'queue #1' })).toBe(true);
    expect(matchesFilters(item, { q: 'queue nope' })).toBe(false);
    expect(matchesFilters(item, { reason: 'changed', ci: 'success' })).toBe(true);
    expect(matchesFilters(item, { reason: 'dismissed' })).toBe(false);
    expect(matchesFilters(item, { draft: 'only' })).toBe(false);
  });

  it('parses pasted GitHub PR links and owner/repo#number references', () => {
    const ref = { owner: 'acme', repo: 'api', number: 12 };

    expect(parsePrRef('https://github.com/acme/api/pull/12/files#diff')).toEqual({
      ...ref,
      host: 'github.com',
    });
    expect(parsePrRef(' acme/api#12 ')).toEqual(ref);
    expect(parsePrRef('acme/api/pull/12')).toEqual(ref);
    expect(parsePrRef('example-org/example-repo#111')).toEqual({
      owner: 'example-org',
      repo: 'example-repo',
      number: 111,
    });
    expect(formatRef(ref)).toBe('acme/api#12');

    for (const text of [
      'https://github.com/acme/api/issues/12',
      'https://notgithub.com/acme/api/pull/12',
      'api#12',
      'acme/api#0',
      'fix acme/api#12 soon',
      'acme/api',
    ])
      expect(parsePrRef(text)).toBeNull();
  });

  it('parses GitLab MR links on any host and group/project!number references', () => {
    expect(
      parsePrRef('https://gitlab.example.com/platform/web/app/-/merge_requests/7/diffs'),
    ).toEqual({
      owner: 'platform/web',
      repo: 'app',
      number: 7,
      host: 'gitlab.example.com',
      gitlab: true,
    });
    // A custom port is part of the host; a relative URL root stays in the path for the server.
    expect(parsePrRef('http://Git.Example.com:8443/gitlab/team/app/-/merge_requests/3')).toEqual({
      owner: 'gitlab/team',
      repo: 'app',
      number: 3,
      host: 'git.example.com:8443',
      gitlab: true,
    });
    expect(parsePrRef('team/sub/app!42')).toEqual({
      owner: 'team/sub',
      repo: 'app',
      number: 42,
      gitlab: true,
    });
    expect(formatRef({ owner: 'team/sub', repo: 'app', number: 42, gitlab: true })).toBe(
      'team/sub/app!42',
    );

    for (const text of [
      'https://gitlab.example.com/team/app/-/issues/7',
      'https://gitlab.example.com/app/-/merge_requests/7',
      'app!7',
      'team/app!0',
    ])
      expect(parsePrRef(text)).toBeNull();
  });

  it('places a pasted reference for the account in use, or names where it belongs', () => {
    const ref = parsePrRef('https://other.example.com/team/app/-/merge_requests/1')!;
    const account = { login: 'rev@git.example.com', webUrl: 'https://web.example.com/rev' };

    expect(placeRef(ref, account).elsewhere).toBe('other.example.com');
    expect(placeRef({ ...ref, host: 'web.example.com' }, account).ref).toMatchObject({
      owner: 'team',
    });
    expect(placeRef({ ...ref, host: 'git.example.com' }, account).elsewhere).toBeNull();
    expect(placeRef(parsePrRef('team/app!1')!, account).elsewhere).toBeNull();

    // A GitLab reference cannot open on GitHub, where the same path is someone else's PR.
    expect(placeRef(parsePrRef('team/app!1')!, { login: 'octocat' }).elsewhere).toBe('GitLab');
    expect(placeRef(ref, { login: 'octocat' }).elsewhere).toBe('GitLab');

    // Under a relative URL root, links into this GitLab lose the root; others are elsewhere.
    const rooted = { login: 'rev@example.com', webUrl: 'https://example.com/gitlab/rev' };

    const placed = placeRef(
      parsePrRef('https://example.com/gitlab/team/app/-/merge_requests/2')!,
      rooted,
    ).ref;

    // Without its host, adding it sends a path the server does not strip a second time.
    expect(placed).toEqual({ owner: 'team', repo: 'app', number: 2, gitlab: true });
    expect(
      placeRef(parsePrRef('https://example.com/other/team/app/-/merge_requests/2')!, rooted)
        .elsewhere,
    ).toBe('example.com/other');
  });

  it('splits nested GitLab paths at the project name and links to each forge', () => {
    const url = 'https://gitlab.example.com/team/sub/app/-/merge_requests/5';

    expect(refOf({ repository: 'team/sub/app', number: 5, url })).toEqual({
      owner: 'team/sub',
      repo: 'app',
      number: 5,
      gitlab: true,
    });
    expect(refOf({ repository: 'acme/api', number: 1 })).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 1,
    });
    expect(filesUrl(url)).toBe(`${url}/diffs`);
    expect(filesUrl('https://github.com/acme/api/pull/1')).toBe(
      'https://github.com/acme/api/pull/1/files',
    );
  });

  it('renders key caps for shortcuts and sequences', () => {
    expect(keyCaps('g i')).toEqual([['G'], ['I']]);
    expect(keyCaps('Shift+s')).toEqual([['⇧', 'S']]);
    expect(keyCaps('[Shift]+?')).toEqual([['?']]);
  });
});

describe('account switches', () => {
  const as = (login: string, revision?: number) =>
    status({ account: { login }, ...(revision === undefined ? {} : { revision }) });

  function cacheFor(login: string) {
    const client = new QueryClient();

    client.setQueryData(queryKeys.status, as(login));
    client.setQueryData(queryKeys.accounts, { switchable: true, accounts: [] });
    client.setQueryData(queryKeys.pulls(login), { account: login, items: [] });
    client.setQueryData(queryKeys.detail(login, 'pr-1'), { account: login });
    client.setQueryData(queryKeys.draft('pr-1', login), { body: 'Draft' });

    return client;
  }

  it("keeps answers keyed by an account across a switch, and drops the rest of the previous one's", () => {
    const client = cacheFor('me');

    adoptStatus(client, as('other'));

    expect(client.getQueryData(queryKeys.status)).toEqual(as('other'));
    expect(client.getQueryData(queryKeys.accounts)).toBeDefined();
    // Keyed by `me`, so never shown for `other`: left to expire on their own.
    expect(client.getQueryData(queryKeys.pulls('me'))).toEqual({ account: 'me', items: [] });
    expect(client.getQueryData(queryKeys.pulls('other'))).toBeUndefined();
    // Not yet keyed that way: dropped.
    expect(client.getQueryData(queryKeys.draft('pr-1', 'me'))).toBeUndefined();
  });

  it('reads an account’s kept answers again when it is switched back to', () => {
    const client = cacheFor('me');

    adoptStatus(client, as('other'));
    expect(client.getQueryState(queryKeys.pulls('me'))?.isInvalidated).toBe(false);

    // A snooze may have ended since: its queue is read again, not trusted.
    adoptStatus(client, as('me'));
    expect(client.getQueryState(queryKeys.pulls('me'))?.isInvalidated).toBe(true);
    expect(client.getQueryState(queryKeys.detail('me', 'pr-1'))?.isInvalidated).toBe(true);
  });

  it('keeps cached answers when the account stays the same', () => {
    const client = cacheFor('me');

    adoptStatus(client, { ...as('me'), syncing: true });

    expect(client.getQueryData(queryKeys.pulls('me'))).toEqual({ account: 'me', items: [] });
    expect(client.getQueryData(queryKeys.draft('pr-1', 'me'))).toEqual({ body: 'Draft' });
  });

  it('ignores a status older than the one shown, however late it arrives', () => {
    const client = new QueryClient();

    adoptStatus(client, as('other', 5));
    // A reply sent before the switch, arriving after it.
    adoptStatus(client, as('me', 3));
    expect(client.getQueryData(queryKeys.status)).toEqual(as('other', 5));

    // The same revision is the same state; a newer one is shown.
    adoptStatus(client, { ...as('other', 5), syncing: true });
    expect(client.getQueryData<{ syncing: boolean }>(queryKeys.status)?.syncing).toBe(true);
    adoptStatus(client, as('me', 6));
    expect(client.getQueryData(queryKeys.status)).toEqual(as('me', 6));
  });

  it('reloads the page for a status from another server process, as for its event stream', () => {
    const reload = vi.fn();

    // No DOM here: the page's boot id and its location, as a browser has them.
    vi.stubGlobal('document', {
      querySelector: (selector: string) =>
        selector.includes('review-desk-boot') ? { content: 'boot-1' } : null,
    });
    vi.stubGlobal('window', { location: { reload } });

    const client = new QueryClient();

    try {
      adoptStatus(client, { ...as('me', 1), bootId: 'boot-1' });
      expect(reload).not.toHaveBeenCalled();

      adoptStatus(client, { ...as('me', 1), bootId: 'boot-2' });
      expect(reload).toHaveBeenCalledTimes(1);
      // Never shown: the page is about to reload.
      expect(client.getQueryData<{ bootId: string }>(queryKeys.status)?.bootId).toBe('boot-1');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  describe('a triage reply that arrives late', () => {
    afterEach(() => vi.unstubAllGlobals());

    /** Sends a note for `me` whose reply is held until `answer()`. */
    async function send(reply: { ok: boolean; status: number; body: unknown }) {
      const client = cacheFor('me');
      const paths: string[] = [];
      let answer: (() => void) | null = null;

      vi.stubGlobal(
        'fetch',
        (path: string) =>
          new Promise((resolve) => {
            paths.push(path);
            answer = () =>
              resolve({ ok: reply.ok, status: reply.status, json: async () => reply.body });
          }),
      );

      client.setQueryData(queryKeys.mine('me'), { account: 'me', items: [] });

      const sent = runTriage(client, { id: 'pr-1', account: 'me', update: { note: 'For me' } });

      await vi.waitFor(() => expect(answer).not.toBeNull());

      return { client, sent, paths, answer: () => answer!() };
    }

    it("is sent for its account, and never touches the next account's queue or PR", async () => {
      const { client, sent, paths, answer } = await send({
        ok: true,
        status: 200,
        body: { account: 'me', triage: { note: 'For me' } },
      });

      adoptStatus(client, as('other'));
      client.setQueryData(queryKeys.pulls('other'), { account: 'other', items: [] });
      client.setQueryData(queryKeys.detail('other', 'pr-1'), { account: 'other' });
      answer();
      await sent;

      expect(paths).toEqual(['/api/accounts/me/pulls/pr-1/triage']);
      expect(client.getQueryData(queryKeys.detail('other', 'pr-1'))).toEqual({ account: 'other' });
      expect(client.getQueryData(queryKeys.pulls('other'))).toEqual({
        account: 'other',
        items: [],
      });
    });

    it('never restores an older PR over a newer one of the same account, and reads it again', async () => {
      const { client, sent, answer } = await send({
        ok: true,
        status: 200,
        body: { account: 'me', snapshot: { headOid: 'old-head' }, triage: { note: 'For me' } },
      });

      // A refresh brought a newer head (triage unchanged) before the reply arrived.
      client.setQueryData(queryKeys.detail('me', 'pr-1'), {
        account: 'me',
        snapshot: { headOid: 'new-head' },
      });
      answer();
      await sent;

      expect(client.getQueryData(queryKeys.detail('me', 'pr-1'))).toEqual({
        account: 'me',
        snapshot: { headOid: 'new-head' },
      });
      expect(client.getQueryState(queryKeys.detail('me', 'pr-1'))?.isInvalidated).toBe(true);
      expect(client.getQueryState(queryKeys.mine('me'))?.isInvalidated).toBe(true);
    });

    it('shows the triage it saved at once, unless the PR was read again with another', async () => {
      const key = queryKeys.detail('me', 'pr-1');
      const before = { account: 'me', snapshot: { headOid: 'head' }, triage: { note: '' } };
      const reply = { account: 'me', snapshot: { headOid: 'older' }, triage: { note: 'For me' } };

      /** Saves a note over `before`, doing `meanwhile` while the request is on its way. */
      const save = async (meanwhile?: (client: QueryClient) => void) => {
        const client = cacheFor('me');
        let answer: (() => void) | null = null;

        vi.stubGlobal(
          'fetch',
          () =>
            new Promise((resolve) => {
              answer = () => resolve({ ok: true, status: 200, json: async () => reply });
            }),
        );
        client.setQueryData(key, before);

        const sent = runTriage(client, { id: 'pr-1', account: 'me', update: { note: 'For me' } });

        await vi.waitFor(() => expect(answer).not.toBeNull());
        meanwhile?.(client);
        answer!();
        await sent;

        return client.getQueryData(key);
      };

      // Unchanged since it was sent: the reply's triage shows, and only its triage.
      expect(await save()).toEqual({ ...before, triage: { note: 'For me' } });

      // A refresh brought a newer head with the same triage: both show.
      expect(
        await save((client) =>
          client.setQueryData<typeof before>(key, (detail) => ({
            ...detail!,
            snapshot: { headOid: 'newer' },
          })),
        ),
      ).toEqual({ account: 'me', snapshot: { headOid: 'newer' }, triage: { note: 'For me' } });

      // Read again with another triage (another window's note) before the reply: that one stays.
      const theirs = { ...before, triage: { note: 'Theirs' } };

      expect(await save((client) => client.setQueryData(key, theirs))).toEqual(theirs);
    });

    it("rolls back only its own account's queue", async () => {
      const { client, sent, answer } = await send({
        ok: false,
        status: 409,
        body: { error: 'Refused.' },
      });

      adoptStatus(client, as('other'));
      client.setQueryData(queryKeys.pulls('other'), { account: 'other', items: [] });
      answer();

      await expect(sent).rejects.toThrow('Refused.');
      expect(client.getQueryData(queryKeys.pulls('me'))).toEqual({ account: 'me', items: [] });
      expect(client.getQueryData(queryKeys.pulls('other'))).toEqual({
        account: 'other',
        items: [],
      });
    });
  });
});

describe('event refreshes', () => {
  it('refreshes only the account whose PRs changed, tickets included', () => {
    const client = new QueryClient();
    const keys = (login: string) => [
      queryKeys.pulls(login),
      queryKeys.mine(login),
      queryKeys.detail(login, 'pr-1'),
      queryKeys.diff(login, 'pr-1', 'full'),
      queryKeys.tickets(login, 'pr-1'),
    ];
    const stale = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;

    for (const key of [...keys('me'), ...keys('other')]) client.setQueryData(key, {});

    handle(client, { type: 'pulls.changed', account: 'me', ids: ['pr-1'] }, { value: false });

    expect(keys('me').map(stale)).toEqual([true, true, true, true, true]);
    expect(keys('other').map(stale)).toEqual([false, false, false, false, false]);

    // Triage changes the queue, My PRs (which notes a note) and the PR, of its account only.
    for (const key of keys('me')) client.setQueryData(key, {});
    handle(client, { type: 'triage.updated', account: 'other', id: 'pr-1' }, { value: false });

    expect(keys('me').map(stale)).toEqual([false, false, false, false, false]);
    expect(keys('other').slice(0, 3).map(stale)).toEqual([true, true, true]);
  });

  it('loads again when an event arrives while the first load is on its way', async () => {
    const client = new QueryClient();
    const answers: ((value: string) => void)[] = [];
    const observer = new QueryObserver(client, {
      queryKey: ['operations', 'me'],
      queryFn: () => new Promise<string>((resolve) => answers.push(resolve)),
    });
    const unsubscribe = observer.subscribe(() => {});

    try {
      await vi.waitFor(() => expect(answers).toHaveLength(1));

      // The server answered before the change the event announces.
      refresh(client, ['operations', 'me']);
      answers[0]('Checking');

      await vi.waitFor(() => expect(answers).toHaveLength(2));
      answers[1]('Unconfirmed');
      await vi.waitFor(() => expect(observer.getCurrentResult().data).toBe('Unconfirmed'));
    } finally {
      unsubscribe();
      client.clear();
    }
  });
});
