import { describe, expect, it } from 'vitest';
import type { PullRequestItem, PullRequestSnapshot } from '@review-desk/shared/types';
import {
  MAX_ATTEMPTS,
  admits,
  afterStart,
  changedAfterCompare,
  changedWhile,
  dueRequests,
  followPush,
  outdatedHead,
  requestStage,
  requestedBefore,
  startStage,
  type AutoReviewCandidate,
} from '@/ai/auto-review-rules.js';
import type { AiRunRow, AutoReviewEntry } from '@/db/ai-runs.js';
import { GitHubError } from '@/github/errors.js';
import { ReviewError } from '@/review/errors.js';

/** Facts that say when they are read, in the order they are. */
function reads() {
  const order: string[] = [];
  const fact =
    <T>(name: string, value: T) =>
    () => {
      order.push(name);

      return value;
    };

  return { order, fact };
}

const item = (id = 'PR_1', changes: Partial<PullRequestItem> = {}) =>
  ({
    id,
    queue: 'attention',
    requestedVia: [{ kind: 'user', login: 'you', name: 'you' }],
    sources: ['requested'],
    reasons: [{ kind: 'first_review', key: 'first:e1', at: '2026-11-01T00:00:00Z' }],
    ...changes,
  }) as unknown as PullRequestItem;

const candidate = (id: string, at: string): AutoReviewCandidate => ({
  key: `${id}:first:e1`,
  reasonKey: 'first:e1',
  at,
  item: item(id),
});

const entry = (changes: Partial<AutoReviewEntry> = {}) =>
  ({
    account: 'you',
    key: 'PR_1:first:e1',
    prId: 'PR_1',
    status: 'waiting',
    runId: 'run-1',
    attempts: 0,
    error: null,
    headOid: 'head-1',
    restartAt: '2026-11-01T00:00:00Z',
    waitingSince: '2026-10-31T00:00:00Z',
    updatedAt: '2026-10-31T00:00:00Z',
    ...changes,
  }) as AutoReviewEntry;

const run = (changes: Partial<AiRunRow> = {}) =>
  ({ id: 'run-1', headOid: 'head-1', finishedAt: '2026-11-01T00:00:00Z', ...changes }) as AiRunRow;

const pr = (changes: Partial<PullRequestSnapshot> = {}) =>
  ({
    headOid: 'head-1',
    headCommittedAt: '2026-10-31T00:00:00Z',
    ...changes,
  }) as PullRequestSnapshot;

describe('the due requests', () => {
  it('takes new ones, failed ones with attempts left, and waits whose quiet period is over, oldest first', () => {
    const now = Date.parse('2026-11-02T00:00:00Z');
    const log = new Map([
      ['B:first:e1', entry({ key: 'B:first:e1', status: 'failed', attempts: MAX_ATTEMPTS - 1 })],
      ['C:first:e1', entry({ key: 'C:first:e1', status: 'failed', attempts: MAX_ATTEMPTS })],
      [
        'D:first:e1',
        entry({ key: 'D:first:e1', status: 'waiting', restartAt: '2026-11-02T00:00:00Z' }),
      ],
      [
        'E:first:e1',
        entry({ key: 'E:first:e1', status: 'waiting', restartAt: '2026-11-02T00:00:01Z' }),
      ],
      ['F:first:e1', entry({ key: 'F:first:e1', status: 'started' })],
    ]);
    const due = dueRequests(
      [
        candidate('D', '2026-10-30T00:00:00Z'),
        candidate('A', '2026-10-31T00:00:00Z'),
        candidate('B', '2026-10-29T00:00:00Z'),
        candidate('C', '2026-10-28T00:00:00Z'),
        candidate('E', '2026-10-27T00:00:00Z'),
        candidate('F', '2026-10-26T00:00:00Z'),
      ],
      log,
      now,
    );

    // A wait due at `restartAt` itself; a failure at its last attempt is not.
    expect(due.map(({ item }) => item.id)).toEqual(['B', 'D', 'A']);
  });

  it('leaves out a request no longer due', () => {
    const snoozed = {
      ...candidate('A', '2026-10-31T00:00:00Z'),
      item: item('A', { queue: 'snoozed' }),
    };

    expect(dueRequests([snoozed], new Map(), 0)).toEqual([]);
  });

  it('takes a request made at the very moment it was turned on as not backlog', () => {
    expect(requestedBefore('2026-11-01T00:00:00Z', '2026-11-01T00:00:00Z')).toBe(false);
    expect(requestedBefore('2026-10-31T23:59:59Z', '2026-11-01T00:00:00Z')).toBe(true);
  });
});

describe('the request stage', () => {
  const stage = (
    waiting: AutoReviewEntry | null,
    previous: boolean,
    values: Partial<Record<string, unknown>>,
  ) => {
    const { order, fact } = reads();
    const decided = requestStage({
      waiting,
      previous,
      requestedBeforeSince: fact(
        'requestedBefore',
        values.requestedBefore ?? false,
      ) as () => boolean,
      checkingPr: fact('checkingPr', values.checkingPr ?? false) as () => boolean,
      pendingWait: fact('pendingWait', values.pendingWait ?? null) as () => AutoReviewEntry | null,
      replacement: fact('replacement', values.replacement ?? null) as () => AiRunRow | null,
    });

    return { decided, order };
  };

  it.each([
    ['backlog', null, false, { requestedBefore: true }, 'primed', ['requestedBefore']],
    [
      'held for a check',
      null,
      false,
      { checkingPr: true },
      'hold',
      ['requestedBefore', 'checkingPr'],
    ],
    [
      'joining a wait',
      null,
      false,
      { pendingWait: entry() },
      'join',
      ['requestedBefore', 'checkingPr', 'pendingWait'],
    ],
    [
      'new and clear',
      null,
      false,
      {},
      'continue',
      ['requestedBefore', 'checkingPr', 'pendingWait'],
    ],
    ['a failure tried again', null, true, {}, 'continue', ['requestedBefore', 'checkingPr']],
    [
      'a restart replaced',
      entry(),
      true,
      { replacement: run({ id: 'run-2' }) },
      'skip',
      ['replacement'],
    ],
    [
      'a restart',
      entry(),
      true,
      { requestedBefore: true, checkingPr: true },
      'continue',
      ['replacement'],
    ],
  ])('decides %s, reading only what it needs', (_case, waiting, previous, values, kind, order) => {
    const { decided, order: read } = stage(waiting, previous, values);

    expect(decided.kind).toBe(kind);
    expect(read).toEqual(order);
  });
});

describe('the start stage', () => {
  it.each([
    ['not current', false, true, null, 'stop', ['current']],
    ['Codex not ready', true, false, null, 'stop', ['current', 'codexReady']],
    ['a run in progress', true, true, run(), 'skip', ['current', 'codexReady', 'activeRun']],
    ['clear to start', true, true, null, 'start', ['current', 'codexReady', 'activeRun']],
  ])(
    'decides %s, asking Codex only when current',
    async (_case, current, ready, active, kind, order) => {
      const { order: read, fact } = reads();
      const decided = await startStage({
        current: fact('current', current),
        codexReady: () => Promise.resolve(fact('codexReady', ready)()),
        activeRun: fact('activeRun', active),
      });

      expect(decided.kind).toBe(kind);
      expect(read).toEqual(order);
    },
  );
});

describe('admission', () => {
  const facts = (
    waiting: AutoReviewEntry | null,
    head: string,
    values: Partial<Record<string, unknown>> = {},
  ) => {
    const { order, fact } = reads();
    const decided = admits({
      waiting,
      head,
      current: fact('current', values.current ?? true) as () => boolean,
      stillDue: fact('stillDue', values.stillDue ?? true) as () => boolean,
      activeRun: fact('activeRun', values.activeRun ?? null) as () => AiRunRow | null,
      replacement: fact('replacement', values.replacement ?? null) as () => AiRunRow | null,
      checkingPr: fact('checkingPr', values.checkingPr ?? false) as () => boolean,
      pendingWait: fact('pendingWait', values.pendingWait ?? null) as () => AutoReviewEntry | null,
    });

    return { decided, order };
  };

  it('refuses first a restart whose PR moved during the wait, with the head it moved to', () => {
    expect(facts(entry(), 'head-2')).toEqual({
      decided: { admit: false, pushed: 'head-2' },
      order: [],
    });
  });

  it('reads every fact afresh, in order, for a new request', () => {
    expect(facts(null, 'head-1')).toEqual({
      decided: { admit: true, pushed: null },
      order: ['current', 'stillDue', 'activeRun', 'checkingPr', 'pendingWait'],
    });
  });

  it('asks a restart for its replacement, and never for a pending wait', () => {
    expect(facts(entry(), 'head-1')).toEqual({
      decided: { admit: true, pushed: null },
      order: ['current', 'stillDue', 'activeRun', 'replacement', 'checkingPr'],
    });
  });

  it.each([
    ['not current', { current: false }, ['current']],
    ['no longer due', { stillDue: false }, ['current', 'stillDue']],
    ['a run in progress', { activeRun: run() }, ['current', 'stillDue', 'activeRun']],
    [
      'a check in progress',
      { checkingPr: true },
      ['current', 'stillDue', 'activeRun', 'checkingPr'],
    ],
    [
      'a wait to join',
      { pendingWait: entry() },
      ['current', 'stillDue', 'activeRun', 'checkingPr', 'pendingWait'],
    ],
  ])('refuses a new request %s, stopping there', (_case, values, order) => {
    expect(facts(null, 'head-1', values)).toEqual({
      decided: { admit: false, pushed: null },
      order,
    });
  });

  it('refuses a restart a review replaced meanwhile', () => {
    expect(facts(entry(), 'head-1', { replacement: run({ id: 'run-2' }) }).decided.admit).toBe(
      false,
    );
  });
});

describe('after the start', () => {
  const key = { key: 'PR_1:first:e1', prId: 'PR_1' };
  const after = (
    outcome: Parameters<typeof afterStart>[0],
    options: {
      previous?: AutoReviewEntry;
      waiting?: AutoReviewEntry | null;
      pushed?: string | null;
      current?: boolean;
      head?: string;
    },
  ) => {
    const { order, fact } = reads();
    const decided = afterStart(outcome, {
      entry: key,
      previous: options.previous,
      waiting: options.waiting ?? null,
      pushed: options.pushed ?? null,
      current: fact('current', options.current ?? true),
      latestHead: fact('latestHead', options.head),
    });

    return { ...decided, order };
  };
  const error = (code: string) => ({
    kind: 'error' as const,
    error: new ReviewError(code, 409, code),
  });

  it('records a run started on the head it waited for, reading nothing', () => {
    expect(
      after({ kind: 'run', run: { id: 'run-2', headOid: 'head-1' } }, { waiting: entry() }),
    ).toEqual({
      actions: [{ kind: 'record', status: 'started', runId: 'run-2' }],
      goOn: true,
      order: [],
    });
  });

  it('waits again for a saved review returned on another head, bypassing admission, while current', () => {
    const other = { kind: 'run' as const, run: { id: 'run-0', headOid: 'head-0' } };

    expect(after(other, { waiting: entry() })).toEqual({
      actions: [{ kind: 'wait', entry: entry(), head: 'head-0' }],
      goOn: true,
      order: ['current'],
    });
    expect(after(other, { waiting: entry(), current: false }).actions).toEqual([]);
  });

  it('stops on a refusal of admission once no longer current, and waits again for a pushed head', () => {
    expect(after(error('NOT_ADMITTED'), { current: false })).toMatchObject({
      goOn: false,
      order: ['current'],
    });
    expect(after(error('NOT_ADMITTED'), { waiting: entry(), pushed: 'head-2' })).toMatchObject({
      actions: [{ kind: 'wait', entry: entry(), head: 'head-2' }],
      goOn: true,
    });
    expect(after(error('NOT_ADMITTED'), {})).toMatchObject({ actions: [], goOn: true });
  });

  it('waits on a moved head, reading it first and asking whether current only once there is one', () => {
    const previous = entry({ status: 'failed', runId: 'run-0', attempts: 1 });

    expect(after(error('HEAD_MOVED'), { previous, head: 'head-3' })).toEqual({
      actions: [{ kind: 'wait', entry: { ...key, runId: 'run-0', attempts: 1 }, head: 'head-3' }],
      goOn: true,
      order: ['latestHead', 'current'],
    });
    expect(after(error('HEAD_MOVED'), {})).toEqual({
      actions: [],
      goOn: true,
      order: ['latestHead'],
    });
  });

  it.each([
    ['PLAN_LIMIT', error('PLAN_LIMIT')],
    [
      'a rate limit',
      { kind: 'error' as const, error: new GitHubError('Slow down', null, 429, 'rate_limit') },
    ],
  ])('stops the pass on %s, reading nothing', (_case, outcome) => {
    expect(after(outcome, { waiting: entry() })).toEqual({ actions: [], goOn: false, order: [] });
  });

  it('stops on any other failure once no longer current, before counting it', () => {
    expect(after(error('BOOM'), { current: false })).toEqual({
      actions: [],
      goOn: false,
      order: ['current'],
    });
  });

  it('waits again for a restart that failed with attempts left, on the latest head or its own', () => {
    const waiting = entry({ attempts: MAX_ATTEMPTS - 2 });

    expect(after(error('BOOM'), { waiting, previous: waiting, head: 'head-4' }).actions).toEqual([
      { kind: 'wait', entry: { ...waiting, attempts: MAX_ATTEMPTS - 1 }, head: 'head-4' },
    ]);
    expect(after(error('BOOM'), { waiting, previous: waiting }).actions).toEqual([
      { kind: 'wait', entry: { ...waiting, attempts: MAX_ATTEMPTS - 1 }, head: 'head-1' },
    ]);
  });

  it('records a failure once its attempts reach the limit, or for a new request at once', () => {
    const waiting = entry({ attempts: MAX_ATTEMPTS - 1 });
    const failed = after(error('BOOM'), { waiting, previous: waiting });

    expect(failed.actions).toEqual([
      {
        kind: 'record',
        status: 'failed',
        runId: 'run-1',
        attempts: MAX_ATTEMPTS,
        error: expect.any(ReviewError),
      },
    ]);
    expect(failed.order).toEqual(['current']);
    expect(after(error('BOOM'), {}).actions).toEqual([
      {
        kind: 'record',
        status: 'failed',
        runId: undefined,
        attempts: 1,
        error: expect.any(ReviewError),
      },
    ]);
  });
});

describe('following pushes', () => {
  it.each([
    ['a wait whose PR stayed', entry(), pr(), undefined, { kind: 'none' }],
    [
      'a wait whose PR moved',
      entry(),
      pr({ headOid: 'head-2' }),
      undefined,
      { kind: 'rewait', head: 'head-2' },
    ],
    [
      'a review whose PR moved',
      entry({ status: 'started' }),
      pr({ headOid: 'head-2' }),
      run(),
      { kind: 'cancelAndWait', head: 'head-2' },
    ],
    ['a review whose PR stayed', entry({ status: 'started' }), pr(), run(), { kind: 'none' }],
    [
      'a request with no run to stop',
      entry({ status: 'started' }),
      pr({ headOid: 'head-2' }),
      undefined,
      { kind: 'none' },
    ],
  ])('decides %s', (_case, following, current, stoppable, action) => {
    expect(followPush(following, current, stoppable)).toEqual(action);
  });
});

describe('whether a finished review is outdated', () => {
  it.each([
    ['the same head', pr(), false, false],
    ['a new head as it finished', pr({ headOid: 'head-2' }), true, true],
    [
      'a head committed before it finished',
      pr({ headOid: 'head-2', headCommittedAt: '2026-10-31T00:00:00Z' }),
      false,
      true,
    ],
    [
      'a head committed as it finished',
      pr({ headOid: 'head-2', headCommittedAt: '2026-11-01T00:00:00Z' }),
      false,
      true,
    ],
    [
      'a head committed after it finished',
      pr({ headOid: 'head-2', headCommittedAt: '2026-11-02T00:00:00Z' }),
      false,
      'compare',
    ],
  ])('decides %s', (_case, current, asItFinished, changed) => {
    expect(changedWhile(run(), current, asItFinished)).toBe(changed);
  });

  it.each([
    ['unknown history', null, true],
    ['no commits between', { commits: [] }, false],
    ['a commit without a date', { commits: [{ committedAt: null }] }, true],
    ['a commit before it finished', { commits: [{ committedAt: '2026-10-31T00:00:00Z' }] }, true],
    [
      'only commits after it finished',
      { commits: [{ committedAt: '2026-11-02T00:00:00Z' }] },
      false,
    ],
  ])('reads a compare: %s', (_case, compare, changed) => {
    expect(changedAfterCompare(run(), compare)).toBe(changed);
  });

  it('asks whether a later review covers it only once its PR changed', () => {
    const { order, fact } = reads();

    expect(outdatedHead(null, fact('covered', false))).toBeNull();
    expect(order).toEqual([]);
    expect(outdatedHead(pr(), fact('covered', true))).toBeNull();
    expect(outdatedHead(pr(), fact('covered', false))).toEqual(pr());
    expect(order).toEqual(['covered', 'covered']);
  });
});
