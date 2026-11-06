import { describe, expect, it } from 'vitest';
import { deriveItem, emptyTriage } from '@review-desk/shared/attention';
import { matchesFilters } from '../apps/web/src/features/inbox/filters';
import { parsePrUrl } from '../apps/web/src/lib/pr-ref';
import { applyOptimistic } from '../apps/web/src/lib/queries';
import { keyCaps } from '../apps/web/src/lib/shortcuts';
import { parseSnooze, shortAge, snoozePresets } from '../apps/web/src/lib/time';
import { review, snapshot, thread } from './fixtures';

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

  it('parses pasted GitHub PR links', () => {
    expect(parsePrUrl('https://github.com/acme/api/pull/12/files#diff')).toEqual({
      owner: 'acme',
      repo: 'api',
      number: 12,
    });
    expect(parsePrUrl('https://github.com/acme/api/issues/12')).toBeNull();
  });

  it('renders key caps for shortcuts and sequences', () => {
    expect(keyCaps('g i')).toEqual([['G'], ['I']]);
    expect(keyCaps('Shift+s')).toEqual([['⇧', 'S']]);
    expect(keyCaps('[Shift]+?')).toEqual([['?']]);
  });
});
