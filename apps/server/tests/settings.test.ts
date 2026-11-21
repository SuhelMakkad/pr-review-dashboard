import { afterEach, describe, expect, it } from 'vitest';
import { defaultAiSettings } from '@review-desk/shared/ai';
import type { SyncStatus } from '@review-desk/shared/types';
import { systemClock } from '@/clock.js';
import {
  AI_SETTINGS,
  initialStatus,
  NOTIFICATION_SETTINGS,
  STATUS,
  STATUS_RECOVERED,
  WRITE_COOLDOWN,
} from '@/db/settings.js';
import { Store } from '@/db/store.js';
import { EventBus } from '@/events.js';
import { log } from '@/log.js';
import { AccountState } from '@/sync/accounts.js';
import { storeRaw } from './raw-settings.js';

const cleanups: (() => unknown)[] = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();

  log.silence();
});

function memoryStore() {
  const store = new Store(':memory:');

  cleanups.push(() => store.close());

  return store;
}

/** The records the log writes from here on, parsed. */
function captured() {
  const lines: string[] = [];

  log.open({ write: (line) => void lines.push(line) }, 'debug');

  return () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

const later = new Date(Date.now() + 60 * 60_000).toISOString();

/** The text stored under `key`, or null. */
const stored = (store: Store, key: string) =>
  (
    store.db.$client.prepare('SELECT data FROM settings WHERE key = ?').get(key) as
      { data: string } | undefined
  )?.data ?? null;
const saved = (overrides: Record<string, unknown>) => ({
  ...initialStatus(),
  account: { login: 'ann' },
  teams: ['acme/reviewers'],
  retryAt: later,
  nextSyncAt: later,
  ...overrides,
});

describe('saved status', () => {
  it('stays missing when nothing is stored, so the account is unknown', () => {
    const store = memoryStore();
    const state = new AccountState(store, new EventBus(), null, systemClock);

    expect(store.settings.get(STATUS.of('ann'))).toBeNull();
    expect(state.knows('ann')).toBe(false);
  });

  it.each([
    ['an identity that is not an account', { account: 42 }],
    ['an identity naming another account', { account: { login: 'bob' } }],
    ['no identity', { account: null }],
  ])('rebuilds %s from its key, keeping the cooldown and teams', (_, overrides) => {
    const store = memoryStore();
    const records = captured();

    storeRaw(store, 'status:ann', saved(overrides));

    const status = store.settings.get(STATUS.of('ann'))!;
    const state = new AccountState(store, new EventBus(), null, systemClock);

    expect(status).toMatchObject({
      account: { login: 'ann' },
      teams: ['acme/reviewers'],
      retryAt: later,
      nextSyncAt: later,
      error: STATUS_RECOVERED,
    });
    // The account stays known, and its sync cooldown still holds it back.
    expect(state.knows('ann')).toBe(true);
    expect(state.cooldown('ann')).toBe(later);
    // Logged by the setting's name alone: no key, account or value.
    expect(records()).toEqual([
      expect.objectContaining({ level: 'warn', event: 'settings.invalid', setting: 'status' }),
    ]);
    expect(JSON.stringify(records())).not.toContain('ann');
  });

  it('reads a deadline that is not a time as none, so a write cooldown still holds', () => {
    const store = memoryStore();
    const state = new AccountState(store, new EventBus(), null, systemClock);

    storeRaw(store, 'status:ann', saved({ retryAt: 'soon', nextSyncAt: 'soon' }));
    store.settings.set(WRITE_COOLDOWN.of('ann'), later);

    expect(store.settings.get(STATUS.of('ann'))).toMatchObject({
      account: { login: 'ann' },
      retryAt: null,
      nextSyncAt: null,
    });
    expect(state.cooldown('ann')).toBe(later);
  });

  it('rebuilds a value that is not an object, or not JSON, whole', () => {
    const store = memoryStore();

    storeRaw(store, 'status:ann', 'not a status');
    store.db.$client
      .prepare('INSERT INTO settings (key, data) VALUES (?, ?)')
      .run('status:bob', '{not json');

    for (const login of ['ann', 'bob'])
      expect(store.settings.get(STATUS.of(login))).toEqual({
        ...initialStatus(),
        account: { login },
        error: STATUS_RECOVERED,
      });
  });

  it('keeps each valid field when others are invalid, and capabilities absent when absent', () => {
    const store = memoryStore();

    storeRaw(store, 'status:ann', saved({ teams: 'acme', warnings: [1], error: 'Rate limited.' }));
    storeRaw(store, 'status:bob', { ...saved({ account: { login: 'bob' } }), capabilities: 'all' });

    const ann = store.settings.get(STATUS.of('ann'))!;
    const bob = store.settings.get(STATUS.of('bob'))!;

    expect(ann).toMatchObject({ account: { login: 'ann' }, teams: [], warnings: [] });
    // A usable identity keeps its own error: nothing was rebuilt.
    expect(ann.error).toBe('Rate limited.');
    expect(ann.retryAt).toBe(later);
    expect('capabilities' in ann).toBe(false);
    expect('capabilities' in bob).toBe(false);
  });

  it('keeps the recovery notice through a switch, and clears any other error', () => {
    const store = memoryStore();
    const accounts = { list: async () => [], select: () => undefined };
    const state = new AccountState(store, new EventBus(), accounts, systemClock);

    store.saveStatus({ ...initialStatus(), account: { login: 'you' } } as SyncStatus);
    state.status = { ...initialStatus(), account: { login: 'you' } };
    storeRaw(store, 'status:ann', saved({ account: 42 }));
    storeRaw(store, 'status:bob', saved({ account: { login: 'bob' }, error: 'Rate limited.' }));

    state.applySwitch('you', 'ann');
    expect(state.status).toMatchObject({ account: { login: 'ann' }, error: STATUS_RECOVERED });

    state.applySwitch('ann', 'bob');
    expect(state.status).toMatchObject({ account: { login: 'bob' }, error: null });
  });
});

describe('AI settings', () => {
  it('lets an absent approval or resolution follow a saved postFindings', () => {
    const store = memoryStore();

    storeRaw(store, 'ai-settings', { postFindings: true });

    expect(store.settings.get(AI_SETTINGS)).toMatchObject({
      postFindings: true,
      approveFindings: true,
      resolveThreads: true,
    });
  });

  it('turns an invalid approval or resolution off, whatever postFindings says', () => {
    const store = memoryStore();

    storeRaw(store, 'ai-settings', {
      postFindings: true,
      approveFindings: 'yes',
      resolveThreads: 1,
    });

    expect(store.settings.get(AI_SETTINGS)).toMatchObject({
      postFindings: true,
      approveFindings: false,
      resolveThreads: false,
    });
  });

  it('keeps a valid saved choice, and reads each task field on its own', () => {
    const store = memoryStore();
    const defaults = defaultAiSettings();

    storeRaw(store, 'ai-settings', {
      postFindings: true,
      approveFindings: false,
      tasks: { brief: { provider: 'claude', effort: 'extreme' }, since_review: 'fast' },
    });

    const settings = store.settings.get(AI_SETTINGS)!;

    expect(settings.approveFindings).toBe(false);
    expect(settings.resolveThreads).toBe(true);
    expect(settings.tasks.brief).toEqual({
      provider: 'claude',
      effort: defaults.tasks.brief.effort,
      model: defaults.tasks.brief.model,
    });
    expect(settings.tasks.since_review).toEqual(defaults.tasks.since_review);
  });

  it('reads malformed JSON as nothing saved, and logs it once', () => {
    const store = memoryStore();
    const records = captured();

    store.db.$client
      .prepare('INSERT INTO settings (key, data) VALUES (?, ?)')
      .run('ai-settings', '{"postFindings": tr');

    expect(store.settings.get(AI_SETTINGS)).toBeNull();
    expect(store.settings.get(AI_SETTINGS)).toBeNull();
    expect(records()).toEqual([
      expect.objectContaining({ event: 'settings.invalid', setting: 'aiSettings' }),
    ]);
  });
});

describe('writes', () => {
  it('refuse a value without the canonical shape, and write nothing', () => {
    const store = memoryStore();

    expect(() => store.settings.set(AI_SETTINGS, { postFindings: true } as never)).toThrow();
    expect(() => store.settings.set(WRITE_COOLDOWN.of('ann'), 'soon')).toThrow();
    expect(() =>
      store.settings.set(NOTIFICATION_SETTINGS, { kinds: {}, quietHours: null } as never),
    ).toThrow();
    expect(store.settings.get(AI_SETTINGS)).toBeNull();
    expect(store.settings.get(WRITE_COOLDOWN.of('ann'))).toBeNull();
  });

  it('refuse a field the canonical shape does not have, at any depth', () => {
    const store = memoryStore();
    const defaults = defaultAiSettings();

    expect(() => store.settings.set(AI_SETTINGS, { ...defaults, extra: true } as never)).toThrow();
    expect(() =>
      store.settings.set(AI_SETTINGS, {
        ...defaults,
        tasks: { ...defaults.tasks, brief: { ...defaults.tasks.brief, extra: true } },
      } as never),
    ).toThrow();
    expect(() =>
      store.settings.set(STATUS.of('ann'), {
        ...saved({}),
        account: { login: 'ann', name: 'Ann' },
      } as never),
    ).toThrow();
    expect(stored(store, 'ai-settings')).toBeNull();
    expect(stored(store, 'status:ann')).toBeNull();
  });

  it('store a canonical value exactly as given', () => {
    const store = memoryStore();
    const settings = { ...defaultAiSettings(), postFindings: true };

    store.settings.set(AI_SETTINGS, settings);

    expect(stored(store, 'ai-settings')).toBe(JSON.stringify(settings));
  });
});

describe("GitLab's own state", () => {
  it('is kept raw under its prefix, and nothing else is reachable through it', () => {
    const store = memoryStore();
    const local = store.settings.forgeLocal;

    local.setSetting('gitlab:ann@gitlab.com:viewed:pr-1', { 'a.ts': 'sha' });
    expect(local.getSetting('gitlab:ann@gitlab.com:viewed:pr-1')).toEqual({ 'a.ts': 'sha' });

    local.deleteSetting('gitlab:ann@gitlab.com:viewed:pr-1');
    expect(local.getSetting('gitlab:ann@gitlab.com:viewed:pr-1')).toBeNull();

    store.settings.set(WRITE_COOLDOWN.of('ann'), later);

    // A corrupt review head or submission must never read as none at all.
    store.db.$client
      .prepare('INSERT INTO settings (key, data) VALUES (?, ?)')
      .run('gitlab:ann@gitlab.com:head:review-1', '{"oid": ');
    expect(() => local.getSetting('gitlab:ann@gitlab.com:head:review-1')).toThrow(SyntaxError);

    expect(() => local.getSetting('github-write-retry:ann')).toThrow();
    expect(() => local.setSetting('github-write-retry:ann', 'soon')).toThrow();
    expect(() => local.deleteSetting('github-write-retry:ann')).toThrow();
    expect(store.settings.get(WRITE_COOLDOWN.of('ann'))).toBe(later);
  });
});
