import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { deriveItem, emptyTriage } from '@review-desk/shared/attention';
import { matchesFilters } from '@/features/inbox/filters';
import { filesUrl, formatRef, parsePrRef, placeRef, refOf } from '@/lib/pr-ref';
import { adoptStatus, refresh } from '@/lib/live';
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
  const as = (login: string) => status({ account: { login } });

  function cacheFor(login: string) {
    const client = new QueryClient();

    client.setQueryData(queryKeys.status, as(login));
    client.setQueryData(queryKeys.accounts, { switchable: true, accounts: [] });
    client.setQueryData(queryKeys.pulls, { account: login, items: [] });
    client.setQueryData(queryKeys.detail('pr-1'), { account: login });
    client.setQueryData(queryKeys.draft('pr-1', login), { body: 'Draft' });

    return client;
  }

  it("drops the previous account's cached answers, keeping the status and account list", () => {
    const client = cacheFor('me');

    adoptStatus(client, as('other'));

    expect(client.getQueryData(queryKeys.status)).toEqual(as('other'));
    expect(client.getQueryData(queryKeys.accounts)).toBeDefined();
    expect(client.getQueryData(queryKeys.pulls)).toBeUndefined();
    expect(client.getQueryData(queryKeys.detail('pr-1'))).toBeUndefined();
    expect(client.getQueryData(queryKeys.draft('pr-1', 'me'))).toBeUndefined();
  });

  it('keeps cached answers when the account stays the same', () => {
    const client = cacheFor('me');

    adoptStatus(client, { ...as('me'), syncing: true });

    expect(client.getQueryData(queryKeys.pulls)).toEqual({ account: 'me', items: [] });
    expect(client.getQueryData(queryKeys.detail('pr-1'))).toEqual({ account: 'me' });
  });

  describe('a triage reply that arrives after a switch', () => {
    afterEach(() => vi.unstubAllGlobals());

    /**
     * Sends a note for `me` whose reply is held, then lets `other` reach the cache: through its
     * status (a switch here) or only through its data (another window switched).
     */
    async function sendThenSwitch(
      reply: { ok: boolean; status: number; body: unknown },
      through: 'status' | 'data' = 'status',
    ) {
      const client = cacheFor('me');
      let answer: (() => void) | null = null;

      vi.stubGlobal(
        'fetch',
        () =>
          new Promise((resolve) => {
            answer = () =>
              resolve({ ok: reply.ok, status: reply.status, json: async () => reply.body });
          }),
      );

      const sent = runTriage(client, { id: 'pr-1', account: 'me', update: { note: 'For me' } });

      await vi.waitFor(() => expect(answer).not.toBeNull());
      if (through === 'status') adoptStatus(client, as('other'));
      client.setQueryData(queryKeys.pulls, { account: 'other', items: [] });
      client.setQueryData(queryKeys.detail('pr-1'), { account: 'other' });
      answer!();

      return { client, sent };
    }

    it("does not put the previous account's PR back in the cache", async () => {
      const { client, sent } = await sendThenSwitch({
        ok: true,
        status: 200,
        body: { account: 'me', triage: { note: 'For me' } },
      });

      await sent;

      expect(client.getQueryData(queryKeys.detail('pr-1'))).toEqual({ account: 'other' });
    });

    it("does not roll the previous account's queue back over the new one", async () => {
      const { client, sent } = await sendThenSwitch({
        ok: false,
        status: 409,
        body: { error: 'GitHub account changed.' },
      });

      await expect(sent).rejects.toThrow('GitHub account changed.');

      expect(client.getQueryData(queryKeys.pulls)).toEqual({ account: 'other', items: [] });
    });

    it('also holds when the new account reached the cache before its status', async () => {
      const success = await sendThenSwitch(
        { ok: true, status: 200, body: { account: 'me', triage: { note: 'For me' } } },
        'data',
      );

      await success.sent;

      expect(success.client.getQueryData(queryKeys.status)).toEqual(as('me'));
      expect(success.client.getQueryData(queryKeys.detail('pr-1'))).toEqual({ account: 'other' });

      const failure = await sendThenSwitch(
        { ok: false, status: 409, body: { error: 'GitHub account changed.' } },
        'data',
      );

      await expect(failure.sent).rejects.toThrow('GitHub account changed.');

      expect(failure.client.getQueryData(queryKeys.pulls)).toEqual({
        account: 'other',
        items: [],
      });
    });
  });
});

describe('event refreshes', () => {
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
