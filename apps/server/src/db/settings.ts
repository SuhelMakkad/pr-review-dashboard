import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { defaultAiSettings, type AiSettings, type AiTask } from '@review-desk/shared/ai';
import {
  defaultNotificationSettings,
  type NotificationKind,
  type NotificationSettings,
} from '@review-desk/shared/notify';
import type { SyncStatus } from '@review-desk/shared/types';
import { log, type SettingName } from '@/log.js';
import { settings as table } from '@/db/schema.js';
import type { Database } from '@/db/store.js';

/**
 * Every setting the app keeps, declared once: its key, the canonical shape every value written must
 * have, and how a stored value is read back. Values are stored as they were written, unwrapped.
 *
 * A reader decodes field by field and tells three cases apart:
 * - present and valid: kept;
 * - absent: the field's legacy rule where it has one, else its default;
 * - present but invalid: its default, and the read is logged as `settings.invalid`, by name only.
 */
export interface Setting<T> {
  readonly name: SettingName;
  readonly key: string;
  /** Checked before every write; no recovery runs on writes. */
  readonly write: z.ZodType<T>;
  /** Reads back a stored value; `undefined` stands for one whose JSON is malformed. */
  readonly read: (raw: unknown) => Decoded<T | null>;
}

/** A setting kept per account: `status:<account>` and the like. */
export interface SettingFamily<T> {
  readonly name: SettingName;
  readonly prefix: string;
  of(account: string): Setting<T>;
}

export interface Decoded<T> {
  value: T;
  /** True when any part of the stored value was present but did not fit, and was replaced. */
  invalid: boolean;
}

/** Keys GitLab keeps its own state under, opaque to the registry (see `Settings.forgeLocal`). */
export const FORGE_LOCAL_PREFIX = 'gitlab:';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Reads an object's fields one at a time, noting any that is present but does not fit. */
class Fields {
  invalid = false;

  constructor(private readonly source: Record<string, unknown>) {}

  has(name: string): boolean {
    return Object.hasOwn(this.source, name);
  }

  /** The field when it fits; `absent()` when it is missing; `fallback()` when it does not fit. */
  take<T>(name: string, schema: z.ZodType<T>, absent: () => T, fallback: () => T = absent): T {
    if (!this.has(name)) return absent();

    const parsed = schema.safeParse(this.source[name]);

    if (parsed.success) return parsed.data;

    this.invalid = true;

    return fallback();
  }

  /** The field's own fields, read the same way, when it is an object. */
  nested(name: string): Fields | null {
    if (!this.has(name)) return null;

    const value = this.source[name];

    if (isObject(value)) return new Fields(value);

    this.invalid = true;

    return null;
  }

  /** Carries a nested reader's invalid fields into this one. */
  merge(fields: Fields | null): void {
    if (fields?.invalid) this.invalid = true;
  }
}

/** A value read whole: kept when it fits, null otherwise. */
const whole =
  <T>(schema: z.ZodType<T>) =>
  (raw: unknown): Decoded<T | null> => {
    const parsed = schema.safeParse(raw);

    return parsed.success ? { value: parsed.data, invalid: false } : { value: null, invalid: true };
  };

function setting<T>(
  name: SettingName,
  key: string,
  write: z.ZodType<T>,
  read: (raw: unknown) => Decoded<T | null> = whole(write),
): Setting<T> {
  return { name, key, write, read };
}

function family<T>(
  name: SettingName,
  prefix: string,
  write: z.ZodType<T>,
  read: (raw: unknown, account: string) => Decoded<T | null> = whole(write),
): SettingFamily<T> {
  return {
    name,
    prefix,
    of: (account) => ({
      name,
      key: `${prefix}:${account}`,
      write,
      read: (raw) => read(raw, account),
    }),
  };
}

const login = z.string().min(1);
const time = z.string().refine((value) => !Number.isNaN(Date.parse(value)));
const nullableString = z.string().nullable();

// Account and status ------------------------------------------------------------------------------

export const initialStatus = (): SyncStatus => ({
  account: null,
  teams: [],
  syncing: false,
  lastAttemptAt: null,
  lastCompletedAt: null,
  lastSuccessfulSync: null,
  nextSyncAt: null,
  retryAt: null,
  error: null,
  warnings: [],
});

/** Shown for an account whose saved status had to be rebuilt; the next sync replaces it. */
export const STATUS_RECOVERED = 'Saved status could not be read; the next sync refreshes it.';

// Read leniently, so a saved object with a field since dropped still reads; written strictly.
const actorFields = {
  login: z.string(),
  avatarUrl: z.string().optional(),
  webUrl: z.string().optional(),
};
const actor = z.object(actorFields);
const capabilities = z.object({ requestChanges: z.boolean() });
/** A deadline or a sync time: a time `Date.parse` reads, or none. */
const nullableTime = time.nullable();
const syncStatus = z.strictObject({
  account: z.strictObject(actorFields).nullable(),
  capabilities: z.strictObject({ requestChanges: z.boolean() }).optional(),
  teams: z.array(z.string()),
  syncing: z.boolean(),
  lastAttemptAt: nullableTime,
  lastCompletedAt: nullableTime,
  lastSuccessfulSync: nullableTime,
  nextSyncAt: nullableTime,
  retryAt: nullableTime,
  error: nullableString,
  warnings: z.array(z.string()),
}) satisfies z.ZodType<SyncStatus>;

/**
 * A saved status, which names the account it is kept under. Its identity is usable only when it
 * names that same account; otherwise it is rebuilt from the key, with every other valid field kept
 * (a sync cooldown among them) and an account-local error saying so. A value that is not an object
 * is rebuilt whole. A missing row stays missing: the account is then unknown.
 */
function readStatus(raw: unknown, account: string): Decoded<SyncStatus> {
  const base = initialStatus();

  if (!isObject(raw))
    return {
      value: { ...base, account: { login: account }, error: STATUS_RECOVERED },
      invalid: true,
    };

  const fields = new Fields(raw);
  const parsed = actor.safeParse(raw.account);
  const identity = parsed.success && parsed.data.login === account ? parsed.data : null;
  const usable = identity !== null;
  const value: SyncStatus = {
    account: identity ?? { login: account },
    teams: fields.take('teams', z.array(z.string()), () => base.teams),
    syncing: fields.take('syncing', z.boolean(), () => base.syncing),
    // A deadline that is not a time would read as NaN, and hide a valid write cooldown.
    lastAttemptAt: fields.take('lastAttemptAt', nullableTime, () => null),
    lastCompletedAt: fields.take('lastCompletedAt', nullableTime, () => null),
    lastSuccessfulSync: fields.take('lastSuccessfulSync', nullableTime, () => null),
    nextSyncAt: fields.take('nextSyncAt', nullableTime, () => null),
    retryAt: fields.take('retryAt', nullableTime, () => null),
    error: usable ? fields.take('error', nullableString, () => null) : STATUS_RECOVERED,
    warnings: fields.take('warnings', z.array(z.string()), () => base.warnings),
  };
  // Absent means everything is supported (GitHub, or before the first sync): kept absent.
  const read = fields.take('capabilities', capabilities.optional(), () => undefined);

  if (read) value.capabilities = read;

  return { value, invalid: fields.invalid || !usable };
}

export const LAST_ACCOUNT = setting('lastAccount', 'lastAccount', login);
/** The account picked in the app; when absent, the GitHub CLI's active account is used. */
export const SELECTED_ACCOUNT = setting('selectedAccount', 'selectedAccount', login);
export const STATUS = family<SyncStatus>('status', 'status', syncStatus, readStatus);
/** The later of the deadlines a write or a refresh met, per account. */
export const WRITE_COOLDOWN = family('writeCooldown', 'github-write-retry', time);

// Preferences -------------------------------------------------------------------------------------

const provider = z.enum(['codex', 'claude']);
const effort = z.enum(['low', 'medium', 'high', 'xhigh']);
const taskSettings = z.strictObject({
  provider: provider.nullable(),
  effort,
  model: z.string().nullable(),
});
const aiTasks = Object.keys(defaultAiSettings().tasks) as AiTask[];
const aiSettings = z.strictObject({
  defaultProvider: provider,
  tasks: z.strictObject(Object.fromEntries(aiTasks.map((task) => [task, taskSettings]))),
  autoReview: z.strictObject({ enabled: z.boolean(), since: nullableString }),
  postFindings: z.boolean(),
  approveFindings: z.boolean(),
  resolveThreads: z.boolean(),
}) as unknown as z.ZodType<AiSettings>;

/**
 * Saved AI settings over the defaults. Posting used to approve and resolve threads, so an absent
 * `approveFindings` or `resolveThreads` follows a valid saved `postFindings`; an invalid one is
 * off, so a damaged value never turns on automatic approval or resolution.
 */
function readAiSettings(raw: unknown): Decoded<AiSettings | null> {
  if (!isObject(raw)) return { value: null, invalid: true };

  const defaults = defaultAiSettings();
  const fields = new Fields(raw);
  const tasks = fields.nested('tasks');
  const autoReview = fields.nested('autoReview');
  const postFindings = fields.take<boolean | undefined>(
    'postFindings',
    z.boolean(),
    () => undefined,
  );
  const inherited = (name: 'approveFindings' | 'resolveThreads') =>
    fields.take(
      name,
      z.boolean(),
      () => postFindings ?? defaults[name],
      () => false,
    );
  const value: AiSettings = {
    defaultProvider: fields.take('defaultProvider', provider, () => defaults.defaultProvider),
    tasks: Object.fromEntries(
      aiTasks.map((task) => {
        const fallback = defaults.tasks[task];
        const saved = tasks?.nested(task) ?? null;
        const read = saved
          ? {
              provider: saved.take('provider', provider.nullable(), () => fallback.provider),
              effort: saved.take('effort', effort, () => fallback.effort),
              model: saved.take('model', z.string().nullable(), () => fallback.model),
            }
          : { ...fallback };

        tasks?.merge(saved);

        return [task, read];
      }),
    ) as AiSettings['tasks'],
    autoReview: {
      enabled:
        autoReview?.take('enabled', z.boolean(), () => defaults.autoReview.enabled) ??
        defaults.autoReview.enabled,
      since:
        autoReview?.take('since', nullableString, () => defaults.autoReview.since) ??
        defaults.autoReview.since,
    },
    postFindings: postFindings ?? defaults.postFindings,
    approveFindings: inherited('approveFindings'),
    resolveThreads: inherited('resolveThreads'),
  };

  fields.merge(tasks);
  fields.merge(autoReview);

  return { value, invalid: fields.invalid };
}

const notificationKinds = Object.keys(defaultNotificationSettings().kinds) as NotificationKind[];
const clockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const quietHoursFields = { start: clockTime, end: clockTime };
const quietHours = z.object(quietHoursFields).nullable();
const notificationSettings = z.strictObject({
  kinds: z.strictObject(Object.fromEntries(notificationKinds.map((kind) => [kind, z.boolean()]))),
  quietHours: z.strictObject(quietHoursFields).nullable(),
  macosWhenClosed: z.boolean(),
  badgeIncludesMine: z.boolean(),
}) as unknown as z.ZodType<NotificationSettings>;

/** Saved notification settings over the defaults, each kind on its own. */
function readNotificationSettings(raw: unknown): Decoded<NotificationSettings | null> {
  if (!isObject(raw)) return { value: null, invalid: true };

  const defaults = defaultNotificationSettings();
  const fields = new Fields(raw);
  const kinds = fields.nested('kinds');
  const value: NotificationSettings = {
    kinds: Object.fromEntries(
      notificationKinds.map((kind) => [
        kind,
        kinds?.take(kind, z.boolean(), () => defaults.kinds[kind]) ?? defaults.kinds[kind],
      ]),
    ) as NotificationSettings['kinds'],
    quietHours: fields.take('quietHours', quietHours, () => defaults.quietHours),
    macosWhenClosed: fields.take('macosWhenClosed', z.boolean(), () => defaults.macosWhenClosed),
    badgeIncludesMine: fields.take(
      'badgeIncludesMine',
      z.boolean(),
      () => defaults.badgeIncludesMine,
    ),
  };

  fields.merge(kinds);

  return { value, invalid: fields.invalid };
}

export const AI_SETTINGS = setting('aiSettings', 'ai-settings', aiSettings, readAiSettings);
export const NOTIFICATION_SETTINGS = setting(
  'notificationSettings',
  'notification-settings',
  notificationSettings,
  readNotificationSettings,
);
export const REVIEW_SLA_HOURS = setting(
  'reviewSlaHours',
  'review-sla-hours',
  z.number().int().min(1).max(240),
);

// Background work ---------------------------------------------------------------------------------

export interface SavedBackfill {
  doneWindows: string[];
  finishedAt: string | null;
  lastError: string | null;
}

const savedBackfill = z.strictObject({
  doneWindows: z.array(z.string()),
  finishedAt: nullableString,
  lastError: nullableString,
}) satisfies z.ZodType<SavedBackfill>;

function readBackfill(raw: unknown): Decoded<SavedBackfill | null> {
  if (!isObject(raw)) return { value: null, invalid: true };

  const fields = new Fields(raw);
  const value = {
    doneWindows: fields.take('doneWindows', z.array(z.string()), () => []),
    finishedAt: fields.take('finishedAt', nullableString, () => null),
    lastError: fields.take('lastError', nullableString, () => null),
  };

  return { value, invalid: fields.invalid };
}

/** The history import's progress, per account. */
export const BACKFILL = family('backfill', 'backfill', savedBackfill, readBackfill);
/** The `since` of the automatic review whose waiting requests were primed, per account. */
export const AUTO_REVIEW_PRIMED = family('autoReviewPrimed', 'auto-review-primed', z.string());

// Access ------------------------------------------------------------------------------------------

/** The typed settings, read and written through their declarations. */
export class Settings {
  /** Keys already reported invalid: each is logged once. */
  private readonly reported = new Set<string>();

  constructor(private readonly db: Database) {}

  /** The stored value, decoded; null when nothing is stored. */
  get<T>(setting: Setting<T>): T | null {
    const text = this.text(setting.key);

    if (text === null) return null;

    const decoded = setting.read(parse(text));

    if (decoded.invalid && !this.reported.has(setting.key)) {
      this.reported.add(setting.key);
      log.event('warn', 'settings.invalid', { setting: setting.name });
    }

    return decoded.value;
  }

  /** Writes `value`, which must have the setting's canonical shape; it is stored as given. */
  set<T>(setting: Setting<T>, value: T): void {
    setting.write.parse(value);
    this.put(setting.key, value);
  }

  delete(setting: Setting<unknown>): void {
    this.remove(setting.key);
  }

  /**
   * GitLab's own state, which only its adapter reads: raw values under `gitlab:` keys, and no
   * others, so it can never write or delete a typed setting. Item 12 gives it its own home.
   */
  readonly forgeLocal = {
    getSetting: <T>(key: string): T | null => {
      const text = this.text(forgeLocalKey(key));

      // Malformed state throws, as it always has: a corrupt review head or submission must
      // never look like none at all.
      return text === null ? null : (JSON.parse(text) as T);
    },
    setSetting: (key: string, value: unknown): void => this.put(forgeLocalKey(key), value),
    deleteSetting: (key: string): void => this.remove(forgeLocalKey(key)),
  };

  /** The stored text, read as text: malformed JSON must not throw before it can be recovered. */
  private text(key: string): string | null {
    const row = this.db.$client.prepare('SELECT data FROM settings WHERE key = ?').get(key) as
      { data: string } | undefined;

    return row?.data ?? null;
  }

  private put(key: string, value: unknown): void {
    this.db
      .insert(table)
      .values({ key, data: value })
      .onConflictDoUpdate({ target: table.key, set: { data: value } })
      .run();
  }

  private remove(key: string): void {
    this.db.delete(table).where(eq(table.key, key)).run();
  }
}

/** Parsed JSON, or `undefined` for text that is not JSON. */
function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function forgeLocalKey(key: string): string {
  if (!key.startsWith(FORGE_LOCAL_PREFIX))
    throw new Error('Only GitLab state, under its own prefix, is kept through this handle.');

  return key;
}
