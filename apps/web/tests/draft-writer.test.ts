// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '@review-desk/shared/review';
import {
  ATTEMPT_TTL_MS,
  COMMAND_BOUND_MS,
  decode,
  DraftWriter,
  fromLookup,
  WriteRefused,
  type Transport,
  type WriteRequest,
} from '@/features/review/draft-writer';
import { newerDraft } from '@/features/review/use-draft-writer';
import type { Carried, CommandRequest } from '@/features/review/draft-commands';
import { ApiError } from '@/lib/api';

/** A draft at `revision`, `generation` and `observation`. */
const draft = (
  revision: number,
  fields: Partial<ReviewDraft> = {},
  generation = 0,
  observation = 0,
): ReviewDraft => ({
  prId: 'PR_1',
  body: '',
  event: 'COMMENT',
  comments: [],
  updatedAt: null,
  githubPendingReview: null,
  githubReviewId: null,
  versions: { revision, generation, observation },
  ...fields,
});

/** A server as the writer sees it: each request answered by the test, in order. */
function server() {
  const sent: WriteRequest[] = [];
  const answers: ((request: WriteRequest) => Promise<unknown>)[] = [];
  let revision = 0;
  // A commit is always past its base, as the server's.
  const next = (request: WriteRequest) =>
    (revision = Math.max(revision, Number(request.body.baseRevision ?? 0)) + 1);
  const committed = (request: WriteRequest, body: unknown = {}) => ({
    ...(body as object),
    attempt: { id: request.body.writeId, state: 'committed', revision: next(request) },
  });
  const transport: Transport = {
    send: vi.fn(async (request: WriteRequest) => {
      sent.push(request);

      const answer = answers.shift();

      if (answer) return answer(request);

      // A start joins or makes a run, on the draft as it is: it moves no revision.
      if (request.route === 'startAi')
        return {
          id: 'run-1',
          task: 'draft_summary',
          status: 'queued',
          attempt: {
            id: request.body.attemptId,
            state: 'committed',
            revision: Number(request.body.baseRevision),
          },
        };

      const at = next(request);

      return {
        ...(request.route === 'saveDraft' ? draft(at, request.body as Partial<ReviewDraft>) : {}),
        attempt: { id: request.body.writeId, state: 'committed', revision: at },
      };
    }),
    // A miss of an id this server sealed: provable, as within one run of it.
    lookup: vi.fn(async (): Promise<unknown> => ({
      arrived: false,
      fenced: false,
      provable: true,
    })),
    checkpoint: vi.fn(async (): Promise<unknown> => ({ checkpoint: 7, seal: '0123456789abcdef' })),
    abandonWrite: vi.fn(async (): Promise<unknown> => ({ outcome: 'not-admitted' })),
    started: vi.fn(),
    stamp: vi.fn(() => 0),
    committed: vi.fn(),
    stale: vi.fn(),
    refused: vi.fn(),
    epoch: vi.fn(async () => 0),
    // A command is admitted by default, as the server answers it.
    sendCommand: vi.fn(async (request: CommandRequest) => {
      sent.push(request as never);

      const answer = commands.shift();

      return answer
        ? answer(request)
        : request.route === 'submit'
          ? { operation: { id: request.body.operationId, status: 'queued' } }
          : { ok: true };
    }),
    receipt: vi.fn(async (): Promise<unknown> => null),
    abandon: vi.fn(async (): Promise<unknown> => ({ outcome: 'not-admitted' })),
  };
  const commands: ((request: CommandRequest) => Promise<unknown>)[] = [];

  return { sent, answers, commands, transport, committed };
}

/** A refusal for a change since, with the draft as it is now. */
const conflict = (fresh: ReviewDraft) => async (request: WriteRequest) => {
  throw new ApiError('Changed', 409, 'DRAFT_REVISION_CONFLICT', {
    draft: fresh,
    attempt: { id: request.body.writeId, state: 'refused' },
  });
};

/** An answer the test releases, made from the request it answers. */
function held() {
  let resolve: (answer: unknown) => void = () => {};
  let sent: WriteRequest;

  return {
    answer: (request: WriteRequest) => {
      sent = request;

      return new Promise<unknown>((done) => (resolve = done));
    },
    // An answer that throws rejects the send, as a refusal does.
    release: (make: (request: WriteRequest) => unknown) =>
      resolve(Promise.resolve(sent).then(make)),
  };
}

/** Fixes the clock at `at`. */
const clock = (at: number) => vi.spyOn(Date, 'now').mockReturnValue(at);

const instant = () => 0;
const pr = { account: 'you', id: 'PR_1' };

beforeEach(() => sessionStorage.clear());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the draft writer', () => {
  it('sends every draft write in the order it was made, a write behind a save waiting for it', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(0));
    writer.edit('event', 'APPROVE');

    const added = writer.write('addComment', pr, { body: 'Hi' });

    writer.edit('event', 'COMMENT');
    await added;
    await writer.settled();

    expect(sent.map((request) => [request.route, request.body.event ?? request.body.body])).toEqual(
      [
        ['saveDraft', 'APPROVE'],
        ['addComment', 'Hi'],
        ['saveDraft', 'COMMENT'],
      ],
    );
  });

  it('acts on the draft you saw, then on the revision each write before it made', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(5));

    const first = writer.write('addComment', pr, { body: 'One' });
    const second = writer.write('addComment', pr, { body: 'Two' });

    // A read meanwhile (another tab's change) never moves a queued write's base.
    writer.observe(draft(9));
    await Promise.all([first, second]);

    expect(sent.map((request) => request.body.baseRevision)).toEqual([5, 6]);
  });

  it('acknowledges a field only by a save of its version: an edit during its save is sent next', async () => {
    const { sent, answers, transport, committed } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const save = held();

    writer.observe(draft(0));
    answers.push(save.answer);
    writer.edit('body', 'A');

    const saving = writer.flush();

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    writer.edit('body', 'B');
    writer.edit('body', 'A');
    save.release((request) => committed(request, draft(1)));
    await saving;
    await writer.flush();

    // Back to A, which the first save also sent: still sent, as a newer version.
    expect(sent.map((request) => request.body.body)).toEqual(['A', 'A']);
    expect(writer.state('body')).toBe('saved');
  });

  it('rebases a save on a change elsewhere, and keeps it unsent after a discard elsewhere', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(3));
    answers.push(conflict(draft(4)));
    writer.edit('body', 'Mine');
    await writer.flush();

    // Changed elsewhere, same generation: your newest edit wins, on the draft as it is.
    expect(sent.map((request) => [request.body.body, request.body.baseRevision])).toEqual([
      ['Mine', 3],
      ['Mine', 4],
    ]);

    answers.push(conflict(draft(6, {}, 1)));
    writer.edit('body', 'After a discard');
    await writer.flush();

    // Discarded elsewhere: kept, and never sent into another draft.
    expect(sent).toHaveLength(3);
    expect(writer.state('body')).toBe('error');
    expect(writer.value('body', draft(6, {}, 1))).toBe('After a discard');
  });

  it('refuses an action queued behind a write that met a change elsewhere', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(2));
    answers.push(conflict(draft(3)));

    const first = writer.write('addComment', pr, { body: 'One' });
    const second = writer.write('editComment', { ...pr, cid: 'c' }, { body: 'Two' });

    await expect(first).rejects.toBeInstanceOf(WriteRefused);
    await expect(second).rejects.toMatchObject({ code: 'DRAFT_CHANGED_LOCALLY' });
  });

  it('stops the actions behind a save that met a discard elsewhere', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(2));
    answers.push(conflict(draft(4, {}, 1)));
    writer.edit('body', 'Mine');

    await expect(writer.write('addComment', pr, { body: 'Behind it' })).rejects.toMatchObject({
      code: 'DRAFT_CHANGED_LOCALLY',
    });
    expect(sent).toHaveLength(1);
  });

  it('rejects a refused write with the refusal as the server gave it, its details included', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(2));
    answers.push(async (request) => {
      throw new ApiError('Edited since.', 409, 'PREPARED_REVIEW_EDITED', {
        draftRevision: 'rev-7',
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    });

    const refusal = await writer
      .write<never>('prepareAi', { account: 'you', runId: 'r' }, { prId: 'PR_1', indices: [0] })
      .catch((error: unknown) => error);

    expect(refusal).toBeInstanceOf(ApiError);
    expect(refusal).toMatchObject({
      message: 'Edited since.',
      status: 409,
      code: 'PREPARED_REVIEW_EDITED',
      details: { draftRevision: 'rev-7' },
    });
  });

  it('sends a write whose answer said nothing again, with the same id and base, until it settles', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(1));
    answers.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    answers.push(async () => {
      throw new ApiError('Unreadable', 200, 'UNREADABLE');
    });
    // A server error before any outcome was recorded proves nothing either, even to a first send.
    answers.push(async () => {
      throw new ApiError('Internal error', 500);
    });

    await writer.write('addComment', pr, { body: 'Once' });

    expect(sent).toHaveLength(4);
    expect(new Set(sent.map((request) => request.body.writeId)).size).toBe(1);
    expect(new Set(sent.map((request) => request.body.baseRevision))).toEqual(new Set([1]));
  });

  it('looks a pending write up until it settles, and takes one that never arrived and never can as refused', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const pending = async (request: WriteRequest) => ({
      pending: true,
      attempt: { id: request.body.writeId, state: 'pending' },
    });

    writer.observe(draft(0));
    answers.push(pending);
    vi.mocked(transport.lookup).mockImplementationOnce(async (writeId) => ({
      attempt: { id: writeId, state: 'committed', revision: 1, result: { body: { id: 'c1' } } },
    }));

    await expect(writer.write('addComment', pr, { body: 'A' })).resolves.toEqual({ id: 'c1' });

    answers.push(pending);
    vi.mocked(transport.lookup).mockResolvedValueOnce({
      arrived: false,
      fenced: true,
      provable: true,
    });

    await expect(writer.write('addComment', pr, { body: 'B' })).rejects.toMatchObject({
      code: 'NOT_RECEIVED',
    });
  });

  it('stops sending a write at its deadline, and keeps it to be looked up or stopped', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    clock(1_000);
    writer.observe(draft(1));
    answers.push(async () => {
      clock(1_000 + ATTEMPT_TTL_MS);

      throw new ApiError('Not reachable', 0);
    });

    await expect(writer.write('addComment', pr, { body: 'Late' })).rejects.toMatchObject({
      code: 'WRITE_UNCONFIRMED',
    });
    expect(sent).toHaveLength(1);
    expect(writer.writeViews()).toMatchObject([
      { phase: 'unknown', text: 'Late', canStop: true, canSendAgain: false },
    ]);
  });

  it('shows an answer only under the account-switch stamp its write was first sent at', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    let stamp = 1;

    vi.mocked(transport.stamp).mockImplementation(() => stamp);
    writer.observe(draft(1));
    answers.push(async () => {
      // Away and back while it was on its way: its resend's answer is still from before.
      stamp = 3;

      throw new ApiError('Not reachable', 0);
    });
    writer.edit('event', 'APPROVE');
    await writer.settled();

    expect(transport.committed).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'APPROVE' }),
      1,
    );
  });

  it('settles once the saves queued before it settled, holding up nothing queued after it', async () => {
    const { sent, answers, transport, committed } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const save = held();
    const order: string[] = [];

    writer.observe(draft(1));
    answers.push(save.answer);
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    // The verdict is already queued: this still waits for its save's outcome.
    const settled = writer.settled().then(() => order.push(`settled, ${writer.state('event')}`));

    await Promise.resolve();
    expect(order).toEqual([]);

    save.release((request) => committed(request, draft(2, { event: 'APPROVE' })));
    await settled;

    // What waited on it, however slow, never holds up a write queued after.
    await writer.write('addComment', pr, { body: 'After' });

    expect(order).toEqual(['settled, saved']);
    expect(sent.map((request) => request.route)).toEqual(['saveDraft', 'addComment']);
  });

  it('never rebases expired text after a reload, however recently you typed since', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    clock(1_000);
    writer.observe(draft(2));
    writer.edit('body', 'Begun long ago');
    clock(1_000 + ATTEMPT_TTL_MS - 10);
    first.answers.push(() => new Promise(() => {}));
    void writer.flush();
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    clock(1_000 + ATTEMPT_TTL_MS);

    const second = server();
    const resend = held();

    second.answers.push(resend.answer);

    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    // Typed on while its replay is on its way: new text, but the replayed text is still old.
    reloaded.edit('body', 'Typed now');
    resend.release(conflict(draft(5)));
    await reloaded.settled();
    await reloaded.flush();

    expect(second.sent.map((request) => request.body.body)).toEqual([
      'Begun long ago',
      'Typed now',
    ]);
  });

  it('clears an expiry once a replay of the same text is confirmed', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    clock(1_000);
    writer.observe(draft(2));
    writer.edit('body', 'Begun long ago');
    // Sent only days later, and never answered.
    clock(1_000 + ATTEMPT_TTL_MS - 10);
    first.answers.push(() => new Promise(() => {}));
    void writer.flush();
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    clock(1_000 + ATTEMPT_TTL_MS);

    const reloaded = new DraftWriter('you', 'PR_1', server().transport, instant);

    expect(reloaded.state('body')).toBe('error');

    await reloaded.settled();

    expect(reloaded.state('body')).toBe('saved');
  });

  it('rebases after a reload the very text it resent, leaving what you typed since to its own save', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('body', 'A');
    void writer.flush();
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();
    const resend = held();

    second.answers.push(resend.answer);

    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await vi.waitFor(() => expect(second.sent).toHaveLength(1));
    reloaded.edit('body', 'B');
    resend.release(conflict(draft(5)));
    await vi.waitFor(() => expect(second.sent).toHaveLength(2));

    expect(second.sent.map((request) => request.body.body)).toEqual(['A', 'A']);

    await reloaded.flush();

    expect(second.sent.map((request) => request.body.body)).toEqual(['A', 'A', 'B']);
  });

  it('acts behind a refused save on the draft the queue began on, never on a read meanwhile', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const save = held();

    writer.observe(draft(2));
    answers.push(save.answer);
    writer.edit('event', 'APPROVE');

    const added = writer.write('addComment', pr, { body: 'Behind it' });

    // Another tab's change, read while the save is on its way; then the save is refused.
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    writer.observe(draft(7));
    save.release(() => {
      throw new ApiError('Invalid', 400, 'INVALID');
    });
    await added.catch(() => {});

    expect(sent.map((request) => [request.route, request.body.baseRevision])).toEqual([
      ['saveDraft', 2],
      ['addComment', 2],
    ]);
  });

  it('refuses a replacement queued behind a save that was refused, though you typed since', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const save = held();

    writer.observe(draft(1));
    answers.push(save.answer);
    writer.edit('body', 'One');
    void writer.flush();
    await vi.waitFor(() => expect(sent).toHaveLength(1));

    const applying = writer.write(
      'applyAi',
      { account: 'you', runId: 'r' },
      { prId: 'PR_1' },
      { replaces: ['body'] },
    );

    // Typed after choosing to apply: its own save is queued behind the apply.
    writer.edit('body', 'Two');
    save.release(() => {
      throw new ApiError('Switch back to do this.', 409, 'ACCOUNT_NOT_ACTIVE');
    });

    await expect(applying).rejects.toMatchObject({ code: 'DRAFT_EDIT_UNSAVED' });
    expect(sent.map((request) => request.route)).toEqual(['saveDraft']);
  });

  it('refuses to replace a summary or verdict of yours that was not saved, until you save or clear it', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const apply = () =>
      writer.write(
        'applyAi',
        { account: 'you', runId: 'r' },
        { prId: 'PR_1' },
        { replaces: ['body'] },
      );

    const refuse = async () => {
      throw new ApiError('Switch back to do this.', 409, 'ACCOUNT_NOT_ACTIVE');
    };

    writer.observe(draft(1));
    answers.push(refuse, refuse);
    writer.edit('event', 'APPROVE');
    writer.edit('body', 'Refused');
    await writer.flush();

    await expect(apply()).rejects.toMatchObject({ code: 'DRAFT_EDIT_UNSAVED' });
    expect(writer.value('body', draft(1))).toBe('Refused');
    expect(sent.map((request) => request.route)).toEqual(['saveDraft', 'saveDraft']);

    // Your text, once saved, no longer holds it up; a verdict it does not replace never did, and
    // stays yours, refused, after it.
    writer.edit('body', 'Refused, saved now');
    await writer.flush();
    await apply();

    expect(sent.map((request) => request.route)).toEqual([
      'saveDraft',
      'saveDraft',
      'saveDraft',
      'applyAi',
    ]);
    expect(writer.state('event')).toBe('error');
  });

  it('never sends an edit made before a discard elsewhere into the draft after it', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(3));
    writer.edit('body', 'Typed on the old draft');
    // Another tab discarded the draft: the next read is its next generation.
    writer.observe(draft(4, {}, 1));
    // Typing on, unaware of it, keeps the text the old draft's.
    writer.edit('body', 'Typed on the old draft, and more');
    await writer.flush();

    expect(sent).toEqual([]);
    expect(writer.state('body')).toBe('error');

    // Typed again after the refusal you saw: yours for the new draft.
    writer.edit('body', 'Typed on the new draft');
    await writer.flush();

    expect(sent.map((request) => [request.body.body, request.body.baseGeneration])).toEqual([
      ['Typed on the new draft', 1],
    ]);
  });

  it('never carries a queued save across a discard a read showed meanwhile', async () => {
    const { sent, answers, transport, committed } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const first = held();

    writer.observe(draft(3));
    answers.push(first.answer);
    writer.edit('body', 'One');
    void writer.flush();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    writer.edit('body', 'Two');

    const queued = writer.flush();

    // A read shows another tab's discard; then you type on.
    writer.observe(draft(6, {}, 1));
    writer.edit('body', 'Three');
    answers.push(conflict(draft(6, {}, 1)));
    first.release((request) => committed(request, draft(4, { body: 'One' })));
    await queued;
    await writer.flush();

    // The queued save acts on the draft its text began on, which the server refuses; nothing after
    // it is sent into the new draft.
    expect(sent.map((request) => [request.body.body, request.body.baseGeneration])).toEqual([
      ['One', 0],
      ['Two', 0],
    ]);
    expect(writer.state('body')).toBe('error');
  });

  it('never sends a queued save into the discard a read showed, though you typed on', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const first = held();

    writer.observe(draft(3));
    answers.push(first.answer);
    writer.edit('body', 'One');
    void writer.flush();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    writer.edit('body', 'Two');

    const queued = writer.flush();

    writer.observe(draft(6, {}, 1));
    writer.edit('body', 'Three');
    // Nothing ahead of it commits: it still acts on the draft the queue began on, which the
    // server refuses, and never on the one the read showed.
    answers.push(conflict(draft(6, {}, 1)));
    first.release(() => {
      throw new ApiError('Switch back to do this.', 409, 'ACCOUNT_NOT_ACTIVE');
    });
    await queued;
    await writer.flush();

    expect(sent.map((request) => [request.body.body, request.body.baseGeneration])).toEqual([
      ['One', 0],
      ['Two', 0],
    ]);
    expect(writer.state('body')).toBe('error');
  });

  it('sends after a reload the very autosave a reload interrupted, and keeps unsaved edits', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    writer.edit('body', 'Unsaved');

    // The page reloads: a new writer from the journal.
    const second = server();
    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await vi.waitFor(() => expect(second.sent).toHaveLength(1));

    expect(second.sent[0]).toEqual(first.sent[0]);
    expect(reloaded.value('body', draft(2))).toBe('Unsaved');

    await reloaded.flush();

    expect(second.sent.map((request) => request.body.body)).toEqual([undefined, 'Unsaved']);
  });

  it('saves again on the draft as it is an autosave a reload resent into a change elsewhere, before any action behind it', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    second.answers.push(conflict(draft(5)));

    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);
    const behind = reloaded.write('addComment', pr, { body: 'Behind it' });

    await expect(behind).rejects.toMatchObject({ code: 'DRAFT_CHANGED_LOCALLY' });
    await vi.waitFor(() => expect(reloaded.state('event')).toBe('saved'));

    expect(second.sent.map((request) => [request.route, request.body.baseRevision])).toEqual([
      ['saveDraft', 2],
      ['saveDraft', 5],
    ]);
  });

  it('never sends a comment write again after a reload: the draft read then shows if it was kept', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    void writer.write('addComment', pr, { body: 'Once' });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    await new DraftWriter('you', 'PR_1', second.transport, instant).flush();

    expect(second.sent).toEqual([]);
  });

  it('never sends once its deadline has passed, a wait past it included', async () => {
    const { sent, answers, transport } = server();
    const now = 1_000;
    // The tab sleeps past the deadline while waiting to send again.
    const writer = new DraftWriter('you', 'PR_1', transport, () => {
      clock(now + ATTEMPT_TTL_MS);

      return 0;
    });

    clock(now);
    writer.observe(draft(1));
    answers.push(async () => {
      throw new ApiError('Not reachable', 0);
    });

    await expect(writer.write('addComment', pr, { body: 'Late' })).rejects.toMatchObject({
      code: 'WRITE_UNCONFIRMED',
    });
    expect(sent).toHaveLength(1);
  });

  it('never sends again an autosave a reload restored whose deadline passed before its turn', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    clock(1_000);
    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    // Restored just before its deadline; its turn to be sent comes just after.
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(1_000 + ATTEMPT_TTL_MS - 1)
      .mockReturnValue(1_000 + ATTEMPT_TTL_MS);

    const second = server();
    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await reloaded.settled();

    expect(second.sent).toEqual([]);
    expect(reloaded.state('event')).toBe('error');
    // It may have been received before the reload: kept to be looked up, or stopped.
    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canStop: true }]);
  });

  it('never saves text begun more than a week ago, though its pause ends only now', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    clock(1_000);
    writer.observe(draft(1));
    writer.edit('body', 'Typed before the tab slept');
    clock(1_000 + ATTEMPT_TTL_MS);
    await writer.flush();

    expect(sent).toEqual([]);
    expect(writer.state('body')).toBe('error');
    expect(writer.value('body', draft(1))).toBe('Typed before the tab slept');
  });

  it('waits, for the queue to settle, for the rebase of an autosave a reload resent', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    second.answers.push(conflict(draft(5)));

    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);
    const refusal = await reloaded.settled(['event']);

    expect(refusal).toBeNull();
    expect(second.sent.map((request) => [request.body.event, request.body.baseRevision])).toEqual([
      ['APPROVE', 2],
      ['APPROVE', 5],
    ]);
    expect(reloaded.state('event')).toBe('saved');
  });

  it('keeps, unsent, an autosave past its deadline and an edit from more than a week ago', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    clock(1_000);
    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    writer.edit('body', 'Long ago');
    // Each keeps its own deadline: a later read does not renew it.
    clock(1_000 + ATTEMPT_TTL_MS - 1);
    writer.observe(draft(2));
    clock(1_000 + ATTEMPT_TTL_MS);

    const second = server();
    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await reloaded.flush();

    expect(second.sent).toEqual([]);
    expect(reloaded.state('event')).toBe('error');
    expect(reloaded.state('body')).toBe('error');
    expect(reloaded.value('body', draft(2))).toBe('Long ago');
  });

  it('says why a save was refused, and keeps the refused text unsent until you edit it, a reload included', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(1));
    first.answers.push(async () => {
      throw new ApiError('Switch back to do this.', 409, 'ACCOUNT_NOT_ACTIVE');
    });
    writer.edit('body', 'Refused');
    await writer.flush();

    expect(first.transport.refused).toHaveBeenCalledWith('Switch back to do this.');

    const second = server();
    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await reloaded.flush();

    expect(second.sent).toEqual([]);
    expect(reloaded.state('body')).toBe('error');
    expect(reloaded.value('body', draft(1))).toBe('Refused');

    reloaded.observe(draft(1));
    reloaded.edit('body', 'Refused, typed again');
    await reloaded.flush();

    expect(second.sent.map((request) => request.body.body)).toEqual(['Refused, typed again']);
  });
});

/** What a submit or discard carries: the summary and verdict as shown, with their versions. */
const carried = (writer: DraftWriter, shown = draft(1)): Carried => writer.carry(shown);

const review = { event: 'COMMENT' as const, body: 'Looks good.', expectedHeadOid: 'abc' };

/** A receipt as the route answers it, for this PR. */
const receipt = (type: 'review' | 'discard', status: string, stamp?: [number, number]) => ({
  kind: 'forge',
  prId: 'PR_1',
  type,
  status,
  ...(stamp ? { draft: { revision: stamp[0], generation: stamp[1] } } : {}),
});

/** Never resolves: a command or epoch the server does not answer. */
const silent = () => new Promise<never>(() => {});

describe('submit and discard', () => {
  it('queues a submit behind what was asked before it, carrying its text, and retires it once admitted', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    writer.edit('event', 'APPROVE');
    writer.edit('body', 'Sent with the review');

    const submitting = writer.submit(review, carried(writer), null);

    // Typed after Submit: parked, never saved into the draft it submits.
    writer.edit('body', 'Typed after');
    await submitting;
    await writer.flush();

    expect(sent.map((request) => request.route)).toEqual(['saveDraft', 'submit']);
    expect(sent[1]!.body).toMatchObject({
      operationId: expect.any(String),
      baseRevision: 2,
      baseGeneration: 0,
      expectedPendingReviewId: null,
    });
    expect(writer.value('body', draft(3, {}, 1))).toBe('Typed after');
    expect(writer.state('body')).toBe('error');
    expect(writer.failure('body')).toMatch(/after you submitted/);
  });

  it('releases a refused submit, saving the edits parked behind it on the draft they began on', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async () => {
      throw new ApiError('Head moved', 409, 'HEAD_MOVED');
    });

    const submitting = writer.submit(review, carried(writer), null);

    writer.edit('body', 'Still mine');

    await expect(submitting).rejects.toMatchObject({ code: 'HEAD_MOVED' });
    await vi.waitFor(() =>
      expect(sent.map((request) => request.body.body)).toEqual(['Looks good.', 'Still mine']),
    );
    expect(writer.commandViews()).toEqual([]);
  });

  it('never sends a submit again on its own: not known, it holds the draft until its receipt settles it', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async () => {
      throw new ApiError('Not reachable', 0);
    });

    await expect(writer.submit(review, carried(writer), null)).rejects.toMatchObject({
      code: 'COMMAND_UNKNOWN',
    });

    // Nothing else is done on the draft meanwhile, and no other command is sent.
    await expect(writer.write('addComment', pr, { body: 'Hi' })).rejects.toMatchObject({
      code: 'DRAFT_COMMAND_UNKNOWN',
    });
    await expect(writer.submit(review, carried(writer), null)).rejects.toMatchObject({
      code: 'DRAFT_COMMAND_UNKNOWN',
    });
    expect(writer.blocked()).not.toBeNull();
    expect(sent).toHaveLength(1);
    expect(writer.commandViews()).toMatchObject([{ kind: 'submit', phase: 'unknown' }]);

    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('review', 'queued'));
    await writer.reconcile();

    expect(writer.commandViews()).toEqual([]);
    expect(writer.blocked()).toBeNull();
    expect(sent).toHaveLength(1);
  });

  it('settles a command by a receipt only for its own PR and action', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    await writer.submit(review, carried(writer), null).catch(() => {});

    for (const other of [
      { ...receipt('review', 'queued'), prId: 'PR_2' },
      receipt('discard', 'succeeded', [3, 1]),
    ]) {
      vi.mocked(transport.receipt).mockResolvedValueOnce(other);
      await writer.reconcile();
    }

    expect(writer.commandViews()).toMatchObject([{ phase: 'unknown' }]);
  });

  it('sends a command again only when you choose, the very same, within its lifetime', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    clock(1_000);
    writer.observe(draft(1));
    commands.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    await writer.submit(review, carried(writer), null).catch(() => {});

    expect(writer.commandViews()[0]!.canSendAgain).toBe(true);

    await writer.sendAgain(writer.commandViews()[0]!.id);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(writer.commandViews()).toEqual([]);

    // Past its lifetime it is not offered, nor sent.
    commands.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    await writer.submit(review, carried(writer), null).catch(() => {});
    clock(1_000 + ATTEMPT_TTL_MS);

    const [late] = writer.commandViews();

    expect(late!.canSendAgain).toBe(false);
    await writer.sendAgain(late!.id);
    expect(sent).toHaveLength(3);
  });

  it('stops a command: released when never received, lost when that cannot be known, settled when it was', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    const unknown = async () => {
      commands.push(async () => {
        throw new ApiError('Not reachable', 0);
      });
      await writer.submit(review, carried(writer), null).catch(() => {});

      return writer.commandViews().at(-1)!.id;
    };

    writer.observe(draft(1));

    // Never received: as refused; the edits parked behind it are saved.
    const first = await unknown();

    writer.edit('body', 'Parked');
    await writer.stop(first);
    await vi.waitFor(() => expect(sent.at(-1)!.body.body).toBe('Parked'));
    expect(transport.abandon).toHaveBeenCalledWith(first, 'submit', 0);

    // History lost: it can never be received after, but whether it was before is not known.
    vi.mocked(transport.abandon).mockResolvedValueOnce({ outcome: 'unknown' });

    const second = await unknown();

    writer.edit('body', 'Kept to confirm');
    await writer.stop(second);

    expect(writer.blocked()).toBeNull();
    expect(writer.commandViews()).toMatchObject([{ id: second, phase: 'lost' }]);
    expect(writer.state('body')).toBe('error');

    writer.dismiss(second);
    expect(writer.commandViews()).toEqual([]);

    // Received already: settled as admitted.
    vi.mocked(transport.abandon).mockResolvedValueOnce({
      outcome: 'admitted',
      receipt: receipt('review', 'queued'),
    });
    await writer.stop(await unknown());
    expect(writer.commandViews()).toEqual([]);
  });

  it('takes a refusal of a command sent again as proving nothing: the first may have been received', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(
      async () => {
        throw new ApiError('Not reachable', 0);
      },
      async () => {
        throw new ApiError('Changed', 409, 'DRAFT_REVISION_CONFLICT');
      },
    );
    await writer.submit(review, carried(writer), null).catch(() => {});
    await writer.sendAgain(writer.commandViews()[0]!.id);

    expect(writer.commandViews()).toMatchObject([{ phase: 'unknown' }]);
    expect(writer.blocked()).not.toBeNull();
  });

  it('releases, unsent, a command whose epoch read outlived its bound, however late it answers', async () => {
    vi.useFakeTimers();

    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let answer: (epoch: number) => void = () => {};

    vi.mocked(transport.epoch).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );
    writer.observe(draft(1));

    const submitting = writer.submit(review, carried(writer), null);
    const refused = expect(submitting).rejects.toMatchObject({ code: 'NOT_SENT' });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await refused;
    answer(0);
    await vi.advanceTimersByTimeAsync(1);

    expect(sent).toEqual([]);
    expect(writer.commandViews()).toEqual([]);
  });

  it('leaves the queue not known when its answer outlives the bound, and settles by that answer if it comes', async () => {
    vi.useFakeTimers();

    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let admit: () => void = () => {};

    writer.observe(draft(1));
    commands.push(
      (request) =>
        new Promise((resolve) => {
          admit = () => resolve({ operation: { id: request.body.operationId } });
        }),
    );

    const submitting = writer.submit(review, carried(writer), null);
    const unknown = expect(submitting).rejects.toMatchObject({ code: 'COMMAND_UNKNOWN' });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;

    expect(writer.commandViews()).toMatchObject([{ phase: 'unknown' }]);

    admit();
    await vi.advanceTimersByTimeAsync(1);

    expect(writer.commandViews()).toEqual([]);
    expect(sent).toHaveLength(1);
  });

  it('never sends a command it could not record first', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    const setItem = Storage.prototype.setItem;

    writer.observe(draft(1));
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (value.includes('"phase":"sending"')) throw new Error('Quota exceeded');

      setItem.call(this, key, value);
    });

    await expect(writer.submit(review, carried(writer), null)).rejects.toMatchObject({
      code: 'NOT_RECORDED',
    });
    expect(sent).toEqual([]);
  });

  it('restores after a reload a command that may have been sent, never one that was not', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    first.commands.push(silent);
    void writer.submit(review, carried(writer), null).catch(() => {});
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    writer.edit('body', 'Parked');

    const second = server();
    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant, 2_000_000_000);

    // Looked up, never sent again; the gate holds, the edit stays parked.
    expect(reloaded.commandViews()).toMatchObject([{ kind: 'submit', phase: 'unknown' }]);
    expect(reloaded.blocked()).not.toBeNull();
    await reloaded.flush();
    expect(second.sent).toEqual([]);
    expect(second.transport.receipt).toHaveBeenCalled();
  });

  it('releases after a reload a command that was only queued', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    first.answers.push(silent);
    writer.edit('event', 'APPROVE');
    void writer.submit(review, carried(writer), null).catch(() => {});

    const reloaded = new DraftWriter('you', 'PR_1', server().transport, instant, 2_000_000_000);

    expect(reloaded.commandViews()).toEqual([]);
    expect(reloaded.blocked()).toBeNull();
  });

  it('keeps sending again an autosave queued before a command, which waits for it', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    answers.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    writer.edit('event', 'APPROVE');
    await writer.submit(review, carried(writer), null);

    expect(sent.map((request) => request.route)).toEqual(['saveDraft', 'saveDraft', 'submit']);
  });

  it('reports a submit admitted ahead of what waits on the queue', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let admit: () => void = () => {};

    writer.observe(draft(1));
    commands.push(
      (request) =>
        new Promise((resolve) => {
          admit = () => resolve({ operation: { id: request.body.operationId } });
        }),
    );

    const submitting = writer.submit(review, carried(writer), null);

    await vi.waitFor(() => expect(transport.sendCommand).toHaveBeenCalled());

    // A summary start checks the gate before it waits: an unsettled submit refuses it.
    await expect(writer.settled(['body'])).resolves.toMatch(/not confirmed yet/);

    admit();
    await submitting;
  });

  it('holds a discard open until its cleanup is final, then saves the parked edits on the draft it left', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1, { body: 'Old' }));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer, draft(1, { body: 'Old' })));

    // While it is cleaned up: comment writes refused, edits parked.
    await expect(writer.write('addComment', pr, { body: 'Hi' })).rejects.toMatchObject({
      code: 'DRAFT_DISCARDING',
    });
    writer.edit('body', 'For the next draft');
    await writer.flush();
    expect(sent.map((request) => request.route)).toEqual(['discard']);

    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'needs_attention'));
    await writer.reconcile();
    expect(writer.commandViews()).toMatchObject([{ phase: 'admitted', status: 'needs_attention' }]);

    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'succeeded', [5, 1]));
    await writer.reconcile();

    await vi.waitFor(() =>
      expect(sent.map((request) => [request.route, request.body.baseGeneration])).toEqual([
        ['discard', 0],
        ['saveDraft', 1],
      ]),
    );
    expect(writer.blocked()).toBeNull();
  });

  it.each([
    ['without the draft it left', receipt('discard', 'succeeded')],
    ['when the draft has moved past it', receipt('discard', 'cancelled', [5, 1])],
  ])('keeps the parked edits for you to confirm after a discard %s', async (_case, final) => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer));
    writer.edit('body', 'Parked');
    // Another tab cleared and began a draft since.
    writer.observe(draft(9, {}, 3));
    vi.mocked(transport.receipt).mockResolvedValueOnce(final);
    await writer.reconcile();
    await writer.flush();

    expect(sent.map((request) => request.route)).toEqual(['discard']);
    expect(writer.failure('body')).toMatch(/Kept from before the discard/);
  });

  it('refuses at once a write asked for while a submit waits, however that submit then ends', async () => {
    const { sent, answers, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    const save = held();

    writer.observe(draft(1));
    answers.push(save.answer);
    writer.edit('event', 'APPROVE');
    commands.push(async () => {
      throw new ApiError('Head moved', 409, 'HEAD_MOVED');
    });

    const submitting = writer.submit(review, carried(writer), null).catch(() => {});

    await expect(writer.write('addComment', pr, { body: 'While it waits' })).rejects.toMatchObject({
      code: 'DRAFT_COMMAND_UNKNOWN',
    });

    save.release((request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 2 },
    }));
    await submitting;
    await writer.settled();

    expect(sent.map((request) => request.route)).toEqual(['saveDraft', 'submit']);
  });

  it('reads the draft a local discard left from its receipt, and resumes on it', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    vi.mocked(transport.receipt).mockResolvedValue({
      ...receipt('discard', 'succeeded', [2, 1]),
      kind: 'local',
    });

    const discarding = writer.discard(carried(writer));

    writer.edit('body', 'Next draft');
    await discarding;
    await vi.waitFor(() =>
      expect(sent.map((request) => [request.route, request.body.baseGeneration])).toEqual([
        ['discard', 0],
        ['saveDraft', 1],
      ]),
    );
  });

  it('keeps the parked edits to confirm when a discard known received loses its receipt', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer));
    writer.edit('body', 'Parked');
    // A reset deleted its receipt, and moved the receipt-history epoch.
    vi.mocked(transport.receipt).mockResolvedValueOnce(null);
    vi.mocked(transport.epoch).mockResolvedValueOnce(1);
    await writer.reconcile();

    expect(writer.commandViews()).toMatchObject([{ phase: 'lost' }]);
    expect(writer.state('body')).toBe('error');
  });

  it('adopts an earlier version’s id as recovery-only: looked up or stopped, never sent again', () => {
    const { transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    const forget = vi.fn(() => true);

    writer.adopt([{ id: 'legacy', kind: 'submit', forget }]);

    expect(writer.commandViews()).toMatchObject([
      { id: 'legacy', legacy: true, canSendAgain: false, carried: null },
    ]);
    expect(writer.blocked()).not.toBeNull();
    expect(forget).toHaveBeenCalledOnce();
  });

  it('holds the gate for an earlier version’s id it could not journal, forgetting it there only once it can', () => {
    const { transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    const forget = vi.fn(() => true);
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    writer.adopt([{ id: 'legacy', kind: 'discard', forget }]);

    expect(writer.blocked()).not.toBeNull();
    expect(forget).not.toHaveBeenCalled();

    full.mockRestore();
    writer.observe(draft(1));

    expect(forget).toHaveBeenCalledOnce();
  });

  it('keeps an admission seen while its answer was awaited, its bound passing after', async () => {
    vi.useFakeTimers();

    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(silent);

    const discarding = writer.discard(carried(writer));

    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'running'));
    await writer.reconcile();
    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await discarding;

    expect(writer.commandViews()).toMatchObject([{ phase: 'admitted', canSendAgain: false }]);
  });

  it('offers to stop a legacy discard known received whose record a reset removed', async () => {
    const { transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'running'));
    writer.adopt([{ id: 'legacy', kind: 'discard', forget: () => true }]);
    await vi.waitFor(() => expect(writer.commandViews()).toMatchObject([{ phase: 'admitted' }]));
    writer.edit('body', 'Parked');

    // Its record is gone, and with no epoch nothing says why: it is offered "Stop it".
    vi.mocked(transport.receipt).mockResolvedValueOnce(null);
    await writer.reconcile();
    expect(writer.commandViews()).toMatchObject([{ phase: 'admitted', missing: true }]);
    expect(writer.blocked()).not.toBeNull();

    vi.mocked(transport.abandon).mockResolvedValueOnce({ outcome: 'unknown' });
    await writer.stop('legacy');

    expect(transport.abandon).toHaveBeenCalledWith('legacy', 'discard', null);
    expect(writer.commandViews()).toMatchObject([{ phase: 'lost' }]);
    expect(writer.blocked()).toBeNull();
    expect(writer.state('body')).toBe('error');
  });

  it('never hands text begun on an earlier draft to the draft a cancelled discard left', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    writer.edit('body', 'Begun on the earlier draft');
    // Another tab cleared it and began another before this text was saved.
    writer.observe(draft(3, {}, 1));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer, draft(3, {}, 1)));
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'cancelled', [5, 2]));
    await writer.reconcile();
    await writer.settled();

    expect(sent.map((request) => request.route)).toEqual(['discard']);
    expect(writer.failure('body')).toMatch(/Kept from before the discard/);
  });

  it('forgets a legacy id settled before it was journaled only once its outcome is', async () => {
    const { transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    // What the journal held as it was forgotten there.
    let journaled: string | null = null;
    const forget = vi.fn(() => {
      journaled = sessionStorage.getItem('review-desk-draft-writer:you:PR_1');

      return true;
    });
    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('review', 'queued'));
    writer.adopt([{ id: 'legacy', kind: 'submit', forget }]);
    await vi.waitFor(() => expect(writer.commandViews()).toEqual([]));

    expect(forget).not.toHaveBeenCalled();

    full.mockRestore();
    writer.observe(draft(1));

    expect(forget).toHaveBeenCalledOnce();
    expect(journaled).toContain('"settledLegacy":["legacy"]');
  });

  it('takes no epoch but a valid one as evidence of a reset', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer));
    vi.mocked(transport.receipt).mockResolvedValueOnce(null);
    vi.mocked(transport.epoch).mockResolvedValueOnce(undefined as never);
    await writer.reconcile();

    expect(writer.commandViews()).toMatchObject([{ phase: 'admitted' }]);
  });

  it('takes a miss of a discard known received as lost only when receipt history changed', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer));

    // The same epoch: a lookup that crossed its admission, nothing more.
    vi.mocked(transport.receipt).mockResolvedValueOnce(null);
    await writer.reconcile();
    expect(writer.commandViews()).toMatchObject([{ phase: 'admitted' }]);
    expect(writer.blocked()).not.toBeNull();

    // A reset since it was sent.
    vi.mocked(transport.receipt).mockResolvedValueOnce(null);
    vi.mocked(transport.epoch).mockResolvedValueOnce(1);
    await writer.reconcile();
    expect(writer.commandViews()).toMatchObject([{ phase: 'lost' }]);
  });

  it('ignores a miss from a lookup made before the discard was known received', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let miss: (answer: unknown) => void = () => {};

    writer.observe(draft(1));
    commands.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    await writer.discard(carried(writer)).catch(() => {});

    vi.mocked(transport.receipt).mockImplementationOnce(
      () => new Promise((resolve) => (miss = resolve)),
    );

    const looking = writer.reconcile();

    // Meanwhile its receipt shows it received; then the earlier lookup's miss arrives.
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'running'));
    vi.mocked(transport.epoch).mockResolvedValue(1);
    await writer.sendAgain(writer.commandViews()[0]!.id);
    miss(null);
    await looking;

    expect(writer.commandViews()).toMatchObject([{ phase: 'admitted' }]);
  });

  it('settles a command sent again only by evidence, a late refusal of its first send aside', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let refuseFirst: () => void = () => {};

    vi.useFakeTimers();
    writer.observe(draft(1));
    commands.push(
      () =>
        new Promise((_, reject) => {
          refuseFirst = () => reject(new ApiError('Switch back', 409, 'ACCOUNT_NOT_ACTIVE'));
        }),
    );

    const submitting = writer.submit(review, carried(writer), null).catch(() => {});

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await submitting;

    let admitResend: () => void = () => {};

    commands.push(
      (request) =>
        new Promise((resolve) => {
          admitResend = () => resolve({ operation: { id: request.body.operationId } });
        }),
    );

    const resending = writer.sendAgain(writer.commandViews()[0]!.id);

    refuseFirst();
    await vi.advanceTimersByTimeAsync(1);

    expect(writer.commandViews()).toMatchObject([{ phase: 'unknown' }]);

    admitResend();
    await resending;

    expect(writer.commandViews()).toEqual([]);
  });

  it('settles a command once: a stop answered after its receipt settled it changes nothing', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let answerStop: (answer: unknown) => void = () => {};

    writer.observe(draft(1));
    commands.push(async () => {
      throw new ApiError('Not reachable', 0);
    });
    await writer.submit(review, carried(writer), null).catch(() => {});
    vi.mocked(transport.abandon).mockImplementationOnce(
      () => new Promise((resolve) => (answerStop = resolve)),
    );

    const stopping = writer.stop(writer.commandViews()[0]!.id);

    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('review', 'queued'));
    await writer.reconcile();
    // Typed after the submit was settled: an edit for the next draft.
    writer.edit('body', 'Next draft');
    answerStop({ outcome: 'admitted', receipt: receipt('review', 'queued') });
    await stopping;

    expect(writer.state('body')).not.toBe('error');
  });

  it('retires what a discard carried once it succeeded, though the draft it left is not known', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    writer.edit('body', 'Discarded with the draft');
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer));
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'succeeded'));
    await writer.reconcile();

    expect(writer.state('body')).toBe('saved');
  });

  it('keeps every edit for you to confirm after a legacy discard: its request had no base to tie them to a draft', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    let final: (answer: unknown) => void = () => {};

    writer.observe(draft(1));
    // Typed before the earlier version's discard was adopted; not carried by it.
    writer.edit('body', 'Before it');
    vi.mocked(transport.receipt).mockImplementationOnce(
      () => new Promise((resolve) => (final = resolve)),
    );
    writer.adopt([{ id: 'legacy', kind: 'discard', forget: () => true }]);
    writer.edit('event', 'APPROVE');
    final(receipt('discard', 'succeeded', [5, 1]));
    await vi.waitFor(() => expect(writer.commandViews()).toEqual([]));
    await writer.settled();

    // Typed before it or behind it: nothing ties either to the draft it cleared.
    expect(sent).toEqual([]);
    expect(writer.failure('body')).toMatch(/Kept from before the discard/);
    expect(writer.failure('event')).toMatch(/Kept from before the discard/);
  });

  it('reports to its caller a discard its receipt saw finish while its own answer hung', async () => {
    vi.useFakeTimers();

    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(silent);

    const discarding = writer.discard(carried(writer));

    await vi.advanceTimersByTimeAsync(1);
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'succeeded', [3, 1]));
    await writer.reconcile();
    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);

    await expect(discarding).resolves.toBeNull();
    expect(writer.commandViews()).toEqual([]);
  });

  it('reports a receipt’s outcome when the answer arrived unreadable after it', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);
    let unreadable: () => void = () => {};

    writer.observe(draft(1));
    commands.push(
      () =>
        new Promise((_, reject) => {
          unreadable = () => reject(new ApiError('Unreadable', 200, 'UNREADABLE'));
        }),
    );

    const submitting = writer.submit(review, carried(writer), null);

    await vi.waitFor(() => expect(transport.sendCommand).toHaveBeenCalled());
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('review', 'queued'));
    await writer.reconcile();
    unreadable();

    await expect(submitting).resolves.toBeNull();
  });

  it('never adopts again, after a reload, a legacy id it settled, and forgets it there once it can', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant, 2_000_000_000);
    let deletable = false;
    const forget = vi.fn(() => deletable);

    vi.mocked(first.transport.receipt).mockResolvedValueOnce(receipt('review', 'queued'));
    writer.adopt([{ id: 'legacy', kind: 'submit', forget }]);
    await vi.waitFor(() => expect(writer.commandViews()).toEqual([]));
    writer.observe(draft(1));

    // Its deletion there failed: it is still offered, after a reload, but never adopted again.
    const reloaded = new DraftWriter('you', 'PR_1', server().transport, instant, 2_000_000_000);

    deletable = true;
    reloaded.adopt([{ id: 'legacy', kind: 'submit', forget }]);

    expect(reloaded.commandViews()).toEqual([]);
    expect(reloaded.blocked()).toBeNull();
    expect(forget).toHaveBeenLastCalledWith();
    expect(sessionStorage.getItem('review-desk-draft-writer:you:PR_1') ?? '').not.toContain(
      'legacy',
    );
  });

  it('forgets a legacy id restored from the journal once it settles, a first deletion having failed', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant, 2_000_000_000);

    // Journaled, but its deletion there failed.
    writer.adopt([{ id: 'legacy', kind: 'submit', forget: () => false }]);

    const second = server();
    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant, 2_000_000_000);
    const forget = vi.fn(() => true);

    vi.mocked(second.transport.receipt).mockResolvedValue(receipt('review', 'queued'));
    reloaded.adopt([{ id: 'legacy', kind: 'submit', forget }]);
    await vi.waitFor(async () => {
      await reloaded.reconcile();
      expect(reloaded.commandViews()).toEqual([]);
    });

    expect(forget).toHaveBeenCalled();
  });

  it('saves as it is an edit made on the draft a discard left, shown before its receipt was read', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    writer.observe(draft(1));
    commands.push(async (request) => ({ operation: { id: request.body.operationId } }));
    await writer.discard(carried(writer));
    // Its cleanup shows in the draft before its receipt does; you type on that draft.
    writer.observe(draft(3, {}, 1));
    writer.edit('body', 'On the new draft');
    vi.mocked(transport.receipt).mockResolvedValueOnce(receipt('discard', 'succeeded', [3, 1]));
    await writer.reconcile();
    await writer.settled();

    expect(sent.map((request) => [request.body.body, request.body.baseGeneration])).toEqual([
      [undefined, 0],
      ['On the new draft', 1],
    ]);
  });
});

/**
 * The draft these suites write: their own, so the journal of a writer an earlier test left polling
 * never lands on theirs.
 */
const PR = 'PR_9';

describe('comment and AI write recovery', () => {
  const NEVER = 2_000_000_000;
  const SEALED = /^ck1-7-0123456789abcdef-[0-9a-f-]{36}$/;
  const comment = { ...pr };
  const target = { path: 'a.ts', line: 3, side: 'RIGHT', startLine: null };
  /** A refusal before any claim: the id sealed by a server since restarted. */
  const gap = async () => {
    throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
  };
  const unreachable = async () => {
    throw new ApiError('Not reachable', 0);
  };
  const journal = () =>
    JSON.parse(sessionStorage.getItem(`review-desk-draft-writer:you:${PR}`) ?? '{}') as {
      writes?: { phase: string; intent: { body: Record<string, unknown> } }[];
    };
  /** A comment sent, its answer never coming, then the page reloaded onto `next`. */
  async function reloadedWithSent(next = server()) {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    void writer.write('addComment', comment, { ...target, body: 'Kept' });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const reloaded = new DraftWriter('you', PR, next.transport, instant, NEVER);

    return { first, next, reloaded, sent: first.sent[0]! };
  }

  it('seals every new write id with one checkpoint, read again only once told the server restarted', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    writer.edit('event', 'APPROVE');
    await writer.write('addComment', comment, { body: 'One' });

    expect(sent.map((request) => request.body.writeId)).toEqual([
      expect.stringMatching(SEALED),
      expect.stringMatching(SEALED),
    ]);
    expect(transport.checkpoint).toHaveBeenCalledTimes(1);

    writer.forgetCheckpoint();
    vi.mocked(transport.checkpoint).mockResolvedValueOnce({
      checkpoint: 9,
      seal: 'fedcba9876543210',
    });
    await writer.write('addComment', comment, { body: 'Two' });

    expect(sent[2]!.body.writeId).toMatch(/^ck1-9-fedcba9876543210-/);
    expect(transport.checkpoint).toHaveBeenCalledTimes(2);
  });

  it('waits as long as the checkpoint takes, for a write with no bound', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    // A real answer takes a moment: never taken as no answer.
    vi.mocked(transport.checkpoint).mockImplementation(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve({ checkpoint: 7, seal: '0123456789abcdef' }), 30),
        ),
    );
    await writer.write('addComment', comment, { body: 'One' });

    expect(transport.checkpoint).toHaveBeenCalledTimes(1);
    expect(sent.map((request) => request.body.writeId)).toEqual([expect.stringMatching(SEALED)]);
  });

  it('sends nothing unsealed: it waits for a checkpoint it cannot read yet', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    vi.mocked(transport.checkpoint)
      .mockRejectedValueOnce(new ApiError('Not reachable', 0))
      .mockResolvedValueOnce({ checkpoint: 7, seal: 'not hex' });
    await writer.write('addComment', comment, { body: 'One' });

    expect(transport.checkpoint).toHaveBeenCalledTimes(3);
    expect(sent.map((request) => request.body.writeId)).toEqual([expect.stringMatching(SEALED)]);
  });

  it('seals afresh a first send refused before its claim, and sends it as new', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(gap);
    vi.mocked(transport.checkpoint)
      .mockResolvedValueOnce({ checkpoint: 7, seal: '0123456789abcdef' })
      .mockResolvedValueOnce({ checkpoint: 9, seal: 'fedcba9876543210' });

    await expect(writer.write('addComment', comment, { body: 'Hi' })).resolves.toBeDefined();

    expect(sent.map((request) => [request.body.body, request.body.baseRevision])).toEqual([
      ['Hi', 0],
      ['Hi', 0],
    ]);
    expect(sent[1]!.body.writeId).toMatch(/^ck1-9-fedcba9876543210-/);
    expect(writer.writeViews()).toEqual([]);
  });

  it('keeps a write sent before to its own id: a gap then leaves it in the banner, never sent again', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(unreachable, gap);

    await expect(
      writer.write('addComment', comment, { ...target, body: 'Hi' }),
    ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });

    expect(sent).toHaveLength(2);
    expect(sent[1]!.body.writeId).toBe(sent[0]!.body.writeId);
    expect(writer.writeViews()).toMatchObject([
      {
        key: expect.any(String),
        phase: 'unknown',
        label: 'Your comment on a.ts:3',
        text: 'Hi',
        canSendAgain: false,
        canStop: true,
      },
    ]);
  });

  it('settles in the background one whose miss proved nothing, never moving what the queue acts on', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    const pending = async (request: WriteRequest) => ({
      pending: true,
      attempt: { id: request.body.writeId, state: 'pending' },
    });

    writer.observe(draft(4));
    answers.push(pending);
    vi.mocked(transport.lookup).mockResolvedValueOnce({
      arrived: false,
      fenced: false,
      provable: false,
    });

    await expect(writer.write('addComment', comment, { body: 'Late' })).rejects.toMatchObject({
      code: 'WRITE_UNCONFIRMED',
    });

    const writeId = sent[0]!.body.writeId;

    vi.mocked(transport.lookup).mockResolvedValueOnce({
      attempt: { id: writeId, state: 'committed', revision: 9, result: { body: {} } },
    });
    vi.mocked(transport.stale).mockClear();
    await writer.reconcile();

    expect(writer.writeViews()).toEqual([]);
    expect(transport.stale).toHaveBeenCalledTimes(1);

    // The next write acts on the draft as shown, not on the commit found in the background.
    await writer.write('addComment', comment, { body: 'Next' });

    expect(sent.at(-1)!.body.baseRevision).toBe(4);
  });

  it('journals a write from when it is asked for, and never sends one it cannot record as sent', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    const save = held();

    writer.observe(draft(0));
    answers.push(save.answer);
    writer.edit('event', 'APPROVE');

    const behind = writer.write('addComment', comment, { body: 'Behind' });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(journal().writes).toMatchObject([
      { phase: 'queued', intent: { body: { body: 'Behind' } } },
    ]);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Full');
    });
    save.release((request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 1 },
    }));

    await expect(behind).rejects.toMatchObject({ code: 'NOT_RECORDED' });
    expect(sent).toHaveLength(1);
    // Kept for you all the same, in this tab only.
    expect(writer.writeViews()).toMatchObject([
      { phase: 'not-saved', text: 'Behind', unrecorded: true },
    ]);
  });

  it('releases after a reload a write never sent, its text kept for you to copy', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    void writer.write('addComment', comment, { ...target, body: 'Never sent' });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();
    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    await reloaded.settled();

    // Only the autosave the reload interrupted is sent again.
    expect(second.sent.map((request) => request.route)).toEqual(['saveDraft']);
    expect(reloaded.writeViews()).toMatchObject([
      { phase: 'not-saved', text: 'Never sent', canSendAgain: false, canStop: false },
    ]);
    expect(reloaded.writeViews()[0]!.reason).toMatch(/not sent before the page reloaded/);
  });

  it.each([
    [
      'committed',
      (id: unknown) => ({
        attempt: { id, state: 'committed', revision: 3, result: { body: {} } },
      }),
      [],
    ],
    [
      'refused',
      (id: unknown) => ({
        attempt: {
          id,
          state: 'refused',
          result: { status: 409, body: { error: 'Line gone', code: 'LINE_GONE' } },
        },
      }),
      [{ phase: 'not-saved', reason: 'Line gone', text: 'Kept' }],
    ],
    [
      'never received',
      () => ({ arrived: false, fenced: true, provable: true }),
      [{ phase: 'not-saved', reason: expect.stringMatching(/did not reach/) }],
    ],
    [
      'not received yet',
      () => ({ arrived: false, fenced: false, provable: true }),
      [{ phase: 'unknown', canSendAgain: true, canStop: true }],
    ],
    [
      'beyond what the server can tell',
      () => ({ arrived: false, fenced: true, provable: false }),
      [{ phase: 'unknown', canSendAgain: false, canStop: true }],
    ],
  ])(
    'only looks up after a reload a write that may have been sent: %s',
    async (_case, answer, views) => {
      const next = server();

      vi.mocked(next.transport.lookup).mockImplementation(async (id) => answer(id));

      const { reloaded } = await reloadedWithSent(next);

      await reloaded.reconcile();

      expect(next.sent).toEqual([]);
      expect(reloaded.writeViews()).toMatchObject(views);
    },
  );

  it('sends one again only by your choice: the very same envelope, through the queue and its gates', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded, sent } = await reloadedWithSent(next);

    await reloaded.reconcile();

    const [view] = reloaded.writeViews();

    // A command not known closes the gate: nothing is sent past it.
    next.commands.push(unreachable);
    await expect(reloaded.submit(review, carried(reloaded), null)).rejects.toMatchObject({
      code: 'COMMAND_UNKNOWN',
    });
    await expect(reloaded.sendWriteAgain(view!.key)).rejects.toMatchObject({
      code: 'DRAFT_COMMAND_UNKNOWN',
    });

    vi.mocked(next.transport.receipt).mockResolvedValueOnce({
      ...receipt('review', 'queued'),
      prId: PR,
    });
    await reloaded.reconcile();
    await reloaded.sendWriteAgain(view!.key);

    expect(next.sent.filter((request) => request.route === 'addComment')).toEqual([sent]);
    expect(reloaded.writeViews()).toEqual([]);
  });

  it.each([
    ['not admitted', { outcome: 'not-admitted' }, [{ phase: 'not-saved', text: 'Kept' }]],
    ['unknown', { outcome: 'unknown' }, [{ phase: 'lost', canStop: false, text: 'Kept' }]],
    ['still pending', { outcome: 'pending' }, [{ phase: 'received', canStop: false }]],
  ])('stops one, as its stop answers: %s', async (_case, answer, views) => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: true,
      provable: false,
    });

    const { reloaded, sent } = await reloadedWithSent(next);

    await reloaded.reconcile();
    vi.mocked(next.transport.abandonWrite).mockResolvedValueOnce(answer);
    await reloaded.stopWrite(reloaded.writeViews()[0]!.key);

    expect(next.transport.abandonWrite).toHaveBeenCalledWith(sent.body.writeId);
    expect(reloaded.writeViews()).toMatchObject(views);
  });

  it('settles a stop that finds the write committed as committed', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: true,
      provable: false,
    });

    const { reloaded, sent } = await reloadedWithSent(next);

    await reloaded.reconcile();
    vi.mocked(next.transport.abandonWrite).mockResolvedValueOnce({
      outcome: 'committed',
      attempt: { id: sent.body.writeId, state: 'committed', revision: 3, result: { body: {} } },
    });
    vi.mocked(next.transport.stale).mockClear();
    await reloaded.stopWrite(reloaded.writeViews()[0]!.key);

    expect(reloaded.writeViews()).toEqual([]);
    expect(next.transport.stale).toHaveBeenCalled();
  });

  it('keeps looking up one you dismissed, showing it again once it moves', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();
    reloaded.dismissWrite(reloaded.writeViews()[0]!.key);

    expect(reloaded.writeViews()).toEqual([]);

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: true,
      provable: true,
    });
    await reloaded.reconcile();

    const [view] = reloaded.writeViews();

    expect(view).toMatchObject({ phase: 'not-saved' });

    // Settled: dismissing it forgets it.
    reloaded.dismissWrite(view!.key);
    await reloaded.reconcile();

    expect(reloaded.writeViews()).toEqual([]);
    expect(journal().writes ?? []).toEqual([]);
  });

  it('never makes twice a write that may have landed: the very same is refused while it is unresolved', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    const input = { ...target, body: 'Once' };

    writer.observe(draft(0));
    answers.push(unreachable, gap);
    await expect(writer.write('addComment', comment, input)).rejects.toMatchObject({
      code: 'WRITE_UNCONFIRMED',
    });

    // From the composer still open: the very same, its keys in another order too.
    await expect(
      writer.write('addComment', comment, { body: 'Once', ...target }),
    ).rejects.toMatchObject({ code: 'WRITE_UNRESOLVED' });
    expect(sent).toHaveLength(2);

    // Another write goes ahead.
    await writer.write('addComment', comment, { ...target, body: 'Other' });

    // Stopped, never received: the same may be asked for again.
    await writer.stopWrite(writer.writeViews()[0]!.key);
    await writer.write('addComment', comment, input);

    expect(sent.map((request) => request.body.body)).toEqual(['Once', 'Once', 'Other', 'Once']);
  });

  it.each([
    ['unknown', [{ phase: 'lost' }]],
    ['not-admitted', [{ phase: 'not-saved', reason: expect.stringMatching(/stopped it/) }]],
  ])(
    'keeps what a stop decided, its answer lost, when a lookup finds it: %s',
    async (decision, views) => {
      const next = server();

      vi.mocked(next.transport.lookup).mockImplementation(async (id) => ({
        attempt: {
          id,
          state: 'refused',
          result: {
            status: 409,
            body: { error: 'You stopped waiting for this.', code: 'WRITE_ABANDONED', decision },
          },
        },
      }));

      const { reloaded } = await reloadedWithSent(next);

      await reloaded.reconcile();

      expect(reloaded.writeViews()).toMatchObject(views);
    },
  );

  it('keeps a stop decided unknown when sending again finds it, its answer lost', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();
    next.answers.push(async (request) => {
      throw new ApiError('You stopped waiting for this.', 409, 'WRITE_ABANDONED', {
        decision: 'unknown',
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    });
    await reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'lost' }]);
  });

  it('never moves the queue back to an older commit that sending again replays', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();
    reloaded.observe(draft(9));
    // Its first was received long ago, at revision 3: the answer replays that.
    next.answers.push(async (request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 3 },
    }));

    // Sent again first, a write queued behind it.
    const again = reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);
    const behind = reloaded.write('addComment', comment, { body: 'Behind' });

    await again;
    await behind;
    await reloaded.write('addComment', comment, { body: 'After' });

    expect(next.sent.map((request) => [request.body.body, request.body.baseRevision])).toEqual([
      ['Kept', 2],
      ['Behind', 9],
      ['After', 10],
    ]);
  });

  it('proves nothing by a lookup it cannot read: looked up again, never offered to send again', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({ arrived: 'maybe' });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();

    expect(reloaded.writeViews()).toEqual([]);

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: false,
    });
    await reloaded.reconcile();

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canSendAgain: false }]);
  });

  it('keeps the very same write reserved while it is on its way, sent again included', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();

    const resend = held();

    next.answers.push(resend.answer);

    const again = reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);

    await vi.waitFor(() => expect(next.sent).toHaveLength(1));
    await expect(
      reloaded.write('addComment', comment, { ...target, body: 'Kept' }),
    ).rejects.toMatchObject({ code: 'WRITE_UNRESOLVED' });

    resend.release((request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 3 },
    }));
    await again;

    expect(next.sent).toHaveLength(1);
  });

  it('sends one again once, as you asked: an answer that says nothing leaves it to its lookups', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();
    next.answers.push(unreachable, unreachable);
    await reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);

    expect(next.sent).toHaveLength(1);
    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canSendAgain: false }]);

    // Its next lookup says whether it may be sent again.
    await reloaded.reconcile();

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canSendAgain: true }]);
  });

  it('never moves the queue past its base with a commit sending again found on another draft', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();
    reloaded.observe(draft(5));
    // Sent on revision 2, it answers with a commit past the draft the queue acts on.
    next.answers.push(async (request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 12 },
    }));

    const again = reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);
    const behind = reloaded.write('addComment', comment, { body: 'Behind' });

    await again;
    await behind;

    expect(next.sent.map((request) => [request.body.body, request.body.baseRevision])).toEqual([
      ['Kept', 2],
      ['Behind', 5],
    ]);
  });

  it('never offers to send again one a later lookup found received', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();

    expect(reloaded.writeViews()).toMatchObject([{ canSendAgain: true }]);

    vi.mocked(next.transport.lookup).mockImplementation(async (id) => ({
      attempt: { id, state: 'pending' },
    }));
    await reloaded.reconcile();

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'received', canSendAgain: false }]);
  });

  it('never sends again one whose lifetime ended while it waited in the queue', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();

    // A write ahead of it, answered only once the lifetime has ended.
    const ahead = held();

    next.answers.push(ahead.answer);

    const before = reloaded.write('addComment', comment, { body: 'Ahead' });

    await vi.waitFor(() => expect(next.sent).toHaveLength(1));

    const again = reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);

    clock(Date.now() + ATTEMPT_TTL_MS);
    ahead.release((request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 3 },
    }));
    await before;
    await again;

    expect(next.sent.map((request) => request.body.body)).toEqual(['Ahead']);
    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canSendAgain: false }]);
  });

  it('ignores a lookup made before it was sent again', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();

    // A lookup on its way, its miss answered only after the resend.
    let answer: (value: unknown) => void = () => {};

    vi.mocked(next.transport.lookup).mockImplementationOnce(
      () => new Promise((resolve) => (answer = resolve)),
    );

    const stale = reloaded.reconcile();

    next.answers.push(unreachable);
    await reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);
    answer({ arrived: false, fenced: false, provable: true });
    await stale;

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canSendAgain: false }]);
  });

  it('keeps one lookup at a time: a stale one ending never clears the one that replaced it', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded, sent } = await reloadedWithSent(next);

    await reloaded.reconcile();

    let older: (value: unknown) => void = () => {};
    let newer: (value: unknown) => void = () => {};

    vi.mocked(next.transport.lookup)
      .mockImplementationOnce(() => new Promise((resolve) => (older = resolve)))
      .mockImplementationOnce(() => new Promise((resolve) => (newer = resolve)));

    // A lookup on its way, then a resend, then a lookup made after it.
    const first = reloaded.reconcile();

    next.answers.push(unreachable);
    await reloaded.sendWriteAgain(reloaded.writeViews()[0]!.key);

    const second = reloaded.reconcile();

    older({ arrived: false, fenced: false, provable: true });
    await first;

    // The newer is still on its way: a lookup asked for now joins it.
    const calls = vi.mocked(next.transport.lookup).mock.calls.length;
    const third = reloaded.reconcile();

    expect(vi.mocked(next.transport.lookup).mock.calls).toHaveLength(calls);

    newer({ attempt: { id: sent.body.writeId, state: 'pending' } });
    await second;
    await third;

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'received', canSendAgain: false }]);
  });

  it('ignores a miss looked up before a stop found it received', async () => {
    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });

    const { reloaded } = await reloadedWithSent(next);

    await reloaded.reconcile();

    let older: (value: unknown) => void = () => {};

    vi.mocked(next.transport.lookup).mockImplementationOnce(
      () => new Promise((resolve) => (older = resolve)),
    );

    const first = reloaded.reconcile();

    vi.mocked(next.transport.abandonWrite).mockResolvedValueOnce({ outcome: 'pending' });
    await reloaded.stopWrite(reloaded.writeViews()[0]!.key);
    older({ arrived: false, fenced: false, provable: true });
    await first;

    // Still being looked up, received: never shown as not arrived, nor offered again.
    expect(reloaded.writeViews()).toMatchObject([
      { phase: 'received', canSendAgain: false, canStop: false },
    ]);
  });

  it('never holds up the draft for a write not confirmed', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(unreachable, gap);
    await expect(writer.write('addComment', comment, { body: 'Lost' })).rejects.toBeDefined();

    writer.edit('body', 'Still saved');
    await writer.write('addComment', comment, { body: 'Still sent' });

    expect(sent.slice(2).map((request) => request.body.body)).toEqual([
      'Still saved',
      'Still sent',
    ]);
    expect(writer.blocked()).toBeNull();
  });
});

describe('autosaves across a restart', () => {
  const NEVER = 2_000_000_000;
  const bare = '0d6f6c43-2f1a-4c39-9d5f-4f0e2a6f3b11';

  /** A journal as the earlier version left it: an autosave of `Old` on its way, under a bare id. */
  function earlierJournal() {
    const now = Date.now();
    const request = {
      route: 'saveDraft',
      params: { account: 'you', id: PR },
      body: { body: 'Old', writeId: bare, baseRevision: 1, baseGeneration: 0 },
    };

    sessionStorage.setItem(
      `review-desk-draft-writer:you:${PR}`,
      JSON.stringify({
        fields: {
          body: {
            value: 'Old',
            version: 2,
            settled: 1,
            savedAt: 0,
            failed: null,
            generation: 0,
            since: now,
          },
          event: {
            value: 'COMMENT',
            version: 0,
            settled: 0,
            savedAt: 0,
            failed: null,
            generation: null,
            since: null,
          },
        },
        inflight: [
          {
            writeId: bare,
            request,
            base: { revision: 1, generation: 0 },
            deadline: now + 60_000,
            fields: { body: 2 },
            meta: { body: { generation: 0, since: now } },
          },
        ],
      }),
    );
  }

  it('only looks up an autosave an earlier version sent under a bare id, settled once found', async () => {
    earlierJournal();

    const { sent, transport } = server();

    vi.mocked(transport.lookup).mockResolvedValue({
      attempt: { id: bare, state: 'committed', revision: 2, result: { body: {} } },
    });

    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    await writer.reconcile();
    await writer.settled();

    expect(sent).toEqual([]);
    expect(transport.lookup).toHaveBeenCalledWith(bare, { revision: 1, generation: 0 });
    expect(writer.state('body')).toBe('saved');
    expect(writer.writeViews()).toEqual([]);
  });

  it('keeps for you to confirm, never sent again, one of those not found; an edit saves afresh', async () => {
    earlierJournal();

    const { sent, transport } = server();

    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: false,
    });

    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    await writer.reconcile();
    await writer.settled();

    expect(sent).toEqual([]);
    expect(writer.state('body')).toBe('error');
    expect(writer.writeViews()).toMatchObject([
      { phase: 'unknown', text: 'Old', canSendAgain: false, canStop: true },
    ]);

    writer.edit('body', 'New');
    await writer.flush();

    expect(
      sent.map((request) => [request.body.body, String(request.body.writeId).slice(0, 4)]),
    ).toEqual([['New', 'ck1-']]);
  });

  it('keeps one of those from a save of its own across another reload, while it is looked up', async () => {
    earlierJournal();

    const writers = [server(), server()].map((next) => {
      vi.mocked(next.transport.lookup).mockImplementation(() => new Promise(() => {}));

      const writer = new DraftWriter('you', PR, next.transport, instant, NEVER);

      writer.observe(draft(1));

      return { writer, sent: next.sent };
    });

    for (const { writer } of writers) await writer.settled();

    expect(writers.map(({ sent }) => sent)).toEqual([[], []]);
    expect(writers[1]!.writer.state('body')).not.toBe('saved');
  });

  it('keeps for you to confirm, across reloads, an autosave a stop left lost', async () => {
    earlierJournal();

    const first = server();

    vi.mocked(first.transport.lookup).mockResolvedValue({
      attempt: {
        id: bare,
        state: 'refused',
        result: {
          status: 409,
          body: {
            error: 'You stopped waiting for this.',
            code: 'WRITE_ABANDONED',
            decision: 'unknown',
          },
        },
      },
    });

    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    await writer.reconcile();

    expect(writer.writeViews()).toMatchObject([{ phase: 'lost', text: 'Old' }]);
    expect(writer.state('body')).toBe('error');

    const second = server();
    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    reloaded.observe(draft(1));
    await reloaded.flush();
    await reloaded.settled();

    expect(second.sent).toEqual([]);
    expect(reloaded.state('body')).toBe('error');
  });

  it('journals an autosave under its new id before sending it, once resealed', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    const journaled: unknown[] = [];

    writer.observe(draft(0));
    answers.push(
      async () => {
        throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
      },
      async (request) => {
        const saved = JSON.parse(sessionStorage.getItem(`review-desk-draft-writer:you:${PR}`)!) as {
          inflight: { writeId: string }[];
        };

        journaled.push(...saved.inflight.map((write) => write.writeId));

        return { attempt: { id: request.body.writeId, state: 'committed', revision: 1 } };
      },
    );
    writer.edit('event', 'APPROVE');
    await writer.settled();

    expect(journaled).toEqual([sent[1]!.body.writeId]);
    expect(sent[1]!.body.writeId).not.toBe(sent[0]!.body.writeId);
  });

  it('keeps for you to confirm an autosave a restarted server no longer knows, never saved afresh', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(
      async () => {
        throw new ApiError('Not reachable', 0);
      },
      async () => {
        throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
      },
    );
    writer.edit('event', 'APPROVE');
    await writer.settled();

    expect(sent.map((request) => request.body.writeId)).toEqual([
      sent[0]!.body.writeId,
      sent[0]!.body.writeId,
    ]);
    expect(writer.state('event')).toBe('error');
    expect(writer.writeViews()).toMatchObject([
      { phase: 'unknown', label: 'Your summary or verdict', canStop: true, canSendAgain: false },
    ]);

    // Found saved after all: settled, and gone from the banner.
    vi.mocked(transport.lookup).mockResolvedValueOnce({
      attempt: { id: sent[0]!.body.writeId, state: 'committed', revision: 1, result: { body: {} } },
    });
    await writer.reconcile();

    expect(writer.state('event')).toBe('saved');
    expect(writer.writeViews()).toEqual([]);
  });

  it('hands an unconfirmed autosave to the banner in one journal write, so a reload never saves it afresh', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);
    const setItem = Storage.prototype.setItem;

    writer.observe(draft(0));
    first.answers.push(
      async () => {
        throw new ApiError('Not reachable', 0);
      },
      async () => {
        // From now, any journal that records the write for the banner cannot be written.
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
          this: Storage,
          key: string,
          value: string,
        ) {
          if (value.includes('"writes"')) throw new Error('Full');

          setItem.call(this, key, value);
        });

        throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
      },
    );
    writer.edit('event', 'APPROVE');
    await writer.settled();
    vi.restoreAllMocks();

    const second = server();
    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    await reloaded.settled();

    // Only ever the id it was first sent with.
    expect(new Set(second.sent.map((request) => request.body.writeId))).toEqual(
      new Set(second.sent.length > 0 ? [first.sent[0]!.body.writeId] : []),
    );
  });

  it('keeps for you to confirm an autosave a reload resent that a restarted server no longer knows', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    second.answers.push(async () => {
      throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
    });

    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    await vi.waitFor(() => expect(reloaded.state('event')).toBe('error'));

    expect(second.sent).toEqual([first.sent[0]]);
    expect(reloaded.writeViews()).toMatchObject([{ phase: 'unknown', canStop: true }]);
  });

  it('only looks up after a reload an autosave whose deadline passed, never sending it', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    clock(1_000);
    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));
    clock(1_000 + ATTEMPT_TTL_MS);

    const second = server();

    vi.mocked(second.transport.lookup).mockResolvedValue({
      attempt: {
        id: first.sent[0]!.body.writeId,
        state: 'committed',
        revision: 3,
        result: { body: {} },
      },
    });

    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    await reloaded.reconcile();
    await reloaded.settled();

    expect(second.sent).toEqual([]);
    expect(reloaded.state('event')).toBe('saved');
  });
});

describe('the summary start', () => {
  const NEVER = 2_000_000_000;
  const SEALED = /^ck1-7-0123456789abcdef-[0-9a-f-]{36}$/;
  const routes = (sent: WriteRequest[]) => sent.map((request) => request.route);
  const journal = () =>
    JSON.parse(sessionStorage.getItem(`review-desk-draft-writer:you:${PR}`) ?? '{}') as {
      starts?: { phase: string; preflight?: { phase: string } }[];
    };
  const unreachable = async () => {
    throw new ApiError('Not reachable', 0);
  };

  it('saves the text shown at the click first, then starts once on the draft that save left', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(3));
    writer.edit('body', 'Asked on this');

    const started = writer.startSummary({ force: true });

    // Typed after the click: never in what the start saves, and saved after it as usual.
    writer.edit('body', 'Typed after');

    await expect(started).resolves.toMatchObject({ id: 'run-1' });
    await writer.settled();

    expect(
      sent.map((request) => [request.route, request.body.body, request.body.baseRevision]),
    ).toEqual([
      ['saveDraft', 'Asked on this', 3],
      ['startAi', undefined, 4],
      ['saveDraft', 'Typed after', 4],
    ]);
    expect(sent[0]!.body.writeId).toMatch(SEALED);
    expect(sent[1]!.body).toMatchObject({
      task: 'draft_summary',
      force: true,
      attemptId: expect.stringMatching(SEALED),
      baseGeneration: 0,
    });
    expect(transport.started).toHaveBeenCalled();
    expect(writer.startViews()).toEqual([]);
  });

  it('starts on the draft as the queue left it, saving nothing, when what it captured is saved', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(5));
    writer.edit('event', 'APPROVE');
    await writer.settled();
    await writer.startSummary({});

    expect(sent.map((request) => [request.route, request.body.baseRevision])).toEqual([
      ['saveDraft', 5],
      ['startAi', 6],
    ]);
  });

  it('never starts on text refused, or not kept by a save it waited on, and keeps that text', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    answers.push(async (request) => {
      throw new ApiError('Locked', 409, 'DRAFT_LOCKED', {
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    });
    writer.edit('event', 'APPROVE');

    // Queued behind the save of the verdict, which is refused.
    await expect(writer.startSummary({})).rejects.toMatchObject({ message: 'Locked' });
    // Refused already at the click.
    await expect(writer.startSummary({})).rejects.toMatchObject({ message: 'Locked' });

    expect(routes(sent)).toEqual(['saveDraft']);
    expect(writer.state('event')).toBe('error');
  });

  it('never saves for a start text that grew more than a week old while it waited', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    clock(1_000);
    writer.observe(draft(1));
    writer.edit('body', 'From long ago');
    clock(1_000 + ATTEMPT_TTL_MS);

    await expect(writer.startSummary({})).rejects.toMatchObject({ code: 'DRAFT_EDIT_UNSAVED' });

    expect(sent).toEqual([]);
    expect(writer.failure('body')).toMatch(/more than a week ago/);
  });

  it('refuses the start on a change elsewhere, keeping the text for you to confirm, never rebased', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    writer.edit('body', 'Mine');
    await writer.settled();
    vi.useFakeTimers();
    writer.edit('body', 'Asked on');
    answers.push(conflict(draft(4)));

    await expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'DRAFT_REVISION_CONFLICT',
    });
    vi.useRealTimers();
    await writer.settled();

    expect(routes(sent)).toEqual(['saveDraft', 'saveDraft']);
    expect(writer.state('body')).toBe('error');
    expect(writer.failure('body')).toMatch(/changed since you asked for the summary/);
  });

  it('hands a preflight not known in time to the banner, and releases the start unsent', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    // The summary's own save waits for a pause: the click reserves it for the start's preflight.
    writer.edit('body', 'Asked on');
    answers.push(() => new Promise(() => {}));

    const started = writer.startSummary({});
    const refused = expect(started).rejects.toMatchObject({ code: 'NOT_SENT' });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await refused;

    expect(routes(sent)).toEqual(['saveDraft']);
    expect(writer.state('body')).toBe('error');
    expect(writer.writeViews()).toMatchObject([
      { phase: 'unknown', label: 'Your summary or verdict', text: 'Asked on' },
    ]);
    expect(writer.startViews()).toEqual([]);
    expect(journal().starts ?? []).toEqual([]);
  });

  it('leaves a start not answered in time not known, holding up only another start, and settles it by a late answer', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    let admit: () => void = () => {};

    writer.observe(draft(1));
    answers.push(
      (request) =>
        new Promise((resolve) => {
          admit = () =>
            resolve({
              id: 'run-1',
              attempt: { id: request.body.attemptId, state: 'committed', revision: 1 },
            });
        }),
    );

    const started = writer.startSummary({});
    const unknown = expect(started).rejects.toMatchObject({ code: 'SUMMARY_START_UNKNOWN' });

    expect(writer.summaryStarting()).toBe(true);
    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;

    expect(writer.summaryStarting()).toBe(false);
    expect(writer.startViews()).toMatchObject([
      { phase: 'unknown', canStop: true, canSendAgain: false },
    ]);

    // Nothing else waits on it: a comment and an edit go ahead, another start does not.
    vi.useRealTimers();
    await writer.write('addComment', pr, { body: 'Still sent' });
    writer.edit('event', 'APPROVE');
    await writer.settled();
    await expect(writer.startSummary({})).rejects.toMatchObject({ code: 'SUMMARY_START_UNKNOWN' });
    expect(writer.blocked()).toBeNull();

    admit();
    await vi.waitFor(() => expect(writer.startViews()).toEqual([]));

    expect(transport.started).toHaveBeenCalled();
    expect(routes(sent)).toEqual(['startAi', 'addComment', 'saveDraft']);
  });

  it('tells the caller of a start refused at once, with no notice besides', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    answers.push(async (request) => {
      throw new ApiError('Plan limit reached', 429, 'PLAN_LIMIT', {
        attempt: { id: request.body.attemptId, state: 'refused' },
      });
    });

    await expect(writer.startSummary({})).rejects.toMatchObject({ code: 'PLAN_LIMIT' });
    expect(writer.startViews()).toEqual([]);
    expect(writer.summaryStarting()).toBe(false);
  });

  it('keeps the queue while its claim is looked up, answering with the run the lookup finds', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    answers.push(async (request) => ({
      pending: true,
      attempt: { id: request.body.attemptId, state: 'pending' },
    }));
    vi.mocked(transport.lookup)
      .mockImplementationOnce(async (id) => ({ attempt: { id, state: 'pending' } }))
      .mockImplementationOnce(async (id) => ({
        attempt: { id, state: 'committed', revision: 1, result: { body: { id: 'run-2' } } },
      }));

    const started = writer.startSummary({});
    const behind = writer.write('addComment', pr, { body: 'Behind' });

    await expect(started).resolves.toEqual({ id: 'run-2' });
    await behind;

    // Sent only once the start was found admitted.
    const lastLookup = Math.max(...vi.mocked(transport.lookup).mock.invocationCallOrder);
    const commentSend = vi.mocked(transport.send).mock.invocationCallOrder[1]!;

    expect(routes(sent)).toEqual(['startAi', 'addComment']);
    expect(commentSend).toBeGreaterThan(lastLookup);
    expect(writer.startViews()).toEqual([]);
  });

  it('never waits on a save before the start past its bound, however long its backoff', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, () => 10 * COMMAND_BOUND_MS, NEVER);

    writer.observe(draft(1));
    writer.edit('body', 'Asked on');
    answers.push(unreachable);

    const refused = expect(writer.startSummary({})).rejects.toMatchObject({ code: 'NOT_SENT' });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await refused;

    expect(routes(sent)).toEqual(['saveDraft']);
    expect(writer.writeViews()).toMatchObject([{ phase: 'unknown', text: 'Asked on' }]);
  });

  it('lets the queue go on when a start sent again is not answered in time', async () => {
    const { writer, transport, answers, sent } = await unknownStart();

    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    vi.useFakeTimers();
    answers.push(() => new Promise(() => {}));

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);
    const behind = writer.write('addComment', pr, { body: 'Behind' });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await again;
    await behind;

    expect(routes(sent)).toEqual(['startAi', 'startAi', 'addComment']);
    expect(writer.startViews()).toMatchObject([{ phase: 'unknown', canSendAgain: false }]);
  });

  it('never sends again a start its first answer settled while the resend waited in the queue', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    let admit: () => void = () => {};

    writer.observe(draft(1));
    answers.push(
      (request) =>
        new Promise((resolve) => {
          admit = () =>
            resolve({
              id: 'run-1',
              attempt: { id: request.body.attemptId, state: 'committed', revision: 1 },
            });
        }),
    );

    const unknown = expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'SUMMARY_START_UNKNOWN',
    });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;
    vi.useRealTimers();
    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();

    // A write ahead in the queue holds the resend back while the first send's answer comes.
    const ahead = held();

    answers.push(ahead.answer);

    const blocking = writer.write('addComment', pr, { body: 'Ahead' });

    await vi.waitFor(() => expect(sent).toHaveLength(2));

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);

    admit();
    await vi.waitFor(() => expect(transport.started).toHaveBeenCalled());
    ahead.release((request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 2 },
    }));
    await blocking;
    await again;

    expect(routes(sent)).toEqual(['startAi', 'addComment']);
  });

  it('never reopens a start its first answer refused while its resend waited for an answer', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    let refuse: () => void = () => {};

    writer.observe(draft(1));
    answers.push(
      (request) =>
        new Promise((_resolve, reject) => {
          refuse = () =>
            reject(
              new ApiError('Plan limit reached', 429, 'PLAN_LIMIT', {
                attempt: { id: request.body.attemptId, state: 'refused' },
              }),
            );
        }),
    );

    const unknown = expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'SUMMARY_START_UNKNOWN',
    });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;
    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    answers.push(() => new Promise(() => {}));

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);

    await vi.advanceTimersByTimeAsync(1);
    // The first send's refusal, recorded under its id, comes while the resend waits.
    refuse();
    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await again;

    expect(writer.startViews()).toMatchObject([{ phase: 'not-started' }]);
    vi.useRealTimers();
    await expect(writer.startSummary({})).resolves.toMatchObject({ id: 'run-1' });
    expect(routes(sent)).toEqual(['startAi', 'startAi', 'startAi']);
  });

  it('keeps the queue while a start sent again is looked up, its one send answered without an outcome', async () => {
    const { writer, transport, answers, sent } = await unknownStart();

    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    answers.push(async (request) => ({
      pending: true,
      attempt: { id: request.body.attemptId, state: 'pending' },
    }));
    vi.mocked(transport.lookup).mockImplementationOnce(async (id) => ({
      attempt: { id, state: 'committed', revision: 1, result: { body: { id: 'run-1' } } },
    }));

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);
    const behind = writer.write('addComment', pr, { body: 'Behind' });

    await again;
    await behind;

    expect(routes(sent)).toEqual(['startAi', 'startAi', 'addComment']);
    expect(writer.startViews()).toEqual([]);
    expect(transport.started).toHaveBeenCalled();
  });

  it('stops reading the checkpoint once a start gave up at its bound', async () => {
    vi.useFakeTimers();

    const { sent, transport } = server();
    const writer = new DraftWriter('you', PR, transport, () => 1_000, NEVER);

    writer.observe(draft(1));
    vi.mocked(transport.checkpoint).mockRejectedValue(new ApiError('Not reachable', 0));

    const refused = expect(writer.startSummary({})).rejects.toMatchObject({ code: 'NOT_SENT' });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await refused;

    const reads = vi.mocked(transport.checkpoint).mock.calls.length;

    await vi.advanceTimersByTimeAsync(10 * COMMAND_BOUND_MS);

    expect(vi.mocked(transport.checkpoint).mock.calls).toHaveLength(reads);
    expect(sent).toEqual([]);
  });

  it('lets the queue go on at once when a start sent again is settled by its first answer', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    let admit: () => void = () => {};

    writer.observe(draft(1));
    answers.push(
      (request) =>
        new Promise((resolve) => {
          admit = () =>
            resolve({
              id: 'run-1',
              attempt: { id: request.body.attemptId, state: 'committed', revision: 1 },
            });
        }),
    );

    const unknown = expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'SUMMARY_START_UNKNOWN',
    });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;
    vi.useRealTimers();
    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    // The resend's own answer never comes.
    answers.push(() => new Promise(() => {}));

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);
    const behind = writer.write('addComment', pr, { body: 'Behind' });

    await vi.waitFor(() => expect(sent).toHaveLength(2));
    admit();
    await again;
    await behind;

    expect(routes(sent)).toEqual(['startAi', 'startAi', 'addComment']);
    expect(writer.startViews()).toEqual([]);
  });

  it('reads nothing more of a resent start settled while its lookup slept', async () => {
    vi.useFakeTimers();

    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, () => 1_000, NEVER);
    let admit: () => void = () => {};

    writer.observe(draft(1));
    answers.push(
      (request) =>
        new Promise((resolve) => {
          admit = () =>
            resolve({
              id: 'run-1',
              attempt: { id: request.body.attemptId, state: 'committed', revision: 1 },
            });
        }),
    );

    const unknown = expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'SUMMARY_START_UNKNOWN',
    });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;
    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    // The resend is answered without its outcome: its claim is looked up after a backoff.
    answers.push(async (request) => ({
      pending: true,
      attempt: { id: request.body.attemptId, state: 'pending' },
    }));

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);

    await vi.advanceTimersByTimeAsync(1);
    expect(sent).toHaveLength(2);

    const reads = vi.mocked(transport.lookup).mock.calls.length;

    // Settled by the first send's late answer while the lookup sleeps.
    admit();
    await again;
    await vi.advanceTimersByTimeAsync(5_000);

    expect(vi.mocked(transport.lookup).mock.calls).toHaveLength(reads);
    expect(writer.startViews()).toEqual([]);
  });

  it('is held back by a submit not known, as any write is', async () => {
    const { sent, commands, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    commands.push(unreachable);
    await expect(writer.submit(review, carried(writer), null)).rejects.toMatchObject({
      code: 'COMMAND_UNKNOWN',
    });
    await expect(writer.startSummary({})).rejects.toMatchObject({ code: 'DRAFT_COMMAND_UNKNOWN' });

    expect(routes(sent)).toEqual(['submit']);
  });

  /** A start sent, its answer never coming, the bound passed: not known. */
  async function unknownStart() {
    vi.useFakeTimers();

    const next = server();
    const writer = new DraftWriter('you', PR, next.transport, instant, NEVER);

    writer.observe(draft(1));
    next.answers.push(() => new Promise(() => {}));

    const unknown = expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'SUMMARY_START_UNKNOWN',
    });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;
    vi.useRealTimers();

    return { ...next, writer, attemptId: String(next.sent[0]!.body.attemptId) };
  }

  it.each([
    [
      'started',
      (id: string) => ({ attempt: { id, state: 'committed', revision: 1, result: { body: {} } } }),
      [],
    ],
    [
      'never received',
      () => ({ arrived: false, fenced: true, provable: true }),
      [{ phase: 'not-started' }],
    ],
    [
      'not received yet',
      () => ({ arrived: false, fenced: false, provable: true }),
      [{ phase: 'unknown', canSendAgain: true }],
    ],
    [
      'beyond what the server can tell',
      () => ({ arrived: false, fenced: false, provable: false }),
      [{ phase: 'unknown', canSendAgain: false }],
    ],
  ])('looks a start not known up as a start: %s', async (_case, answer, views) => {
    const { writer, transport, attemptId } = await unknownStart();

    vi.mocked(transport.lookup).mockImplementation(async (id) => answer(id));
    await writer.reconcile();

    expect(transport.lookup).toHaveBeenCalledWith(
      attemptId,
      { revision: 1, generation: 0 },
      'start',
    );
    expect(writer.startViews()).toMatchObject(views);
  });

  it('sends a start again only by your choice, the very same, once; a bare refusal after says nothing', async () => {
    const { writer, transport, sent, answers, attemptId } = await unknownStart();

    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    answers.push(async () => {
      throw new ApiError('Not active', 409, 'ACCOUNT_NOT_ACTIVE');
    });
    // Its claim is looked up within the bound, finding nothing more.
    vi.useFakeTimers();

    const again = writer.sendStartAgain(writer.startViews()[0]!.key);

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await again;

    expect(sent.map((request) => request.body.attemptId)).toEqual([attemptId, attemptId]);
    expect(writer.startViews()).toMatchObject([{ phase: 'unknown', canSendAgain: false }]);
  });

  it.each([
    ['not admitted', { outcome: 'not-admitted' }, [{ phase: 'not-started', canStop: false }]],
    ['unknown', { outcome: 'unknown' }, [{ phase: 'lost', canStop: false }]],
  ])(
    'stops a start, as its stop answers: %s, touching none of your edits',
    async (_case, answer, views) => {
      const { writer, transport, sent, attemptId } = await unknownStart();

      vi.mocked(transport.abandonWrite).mockResolvedValueOnce(answer);
      await writer.stopStart(writer.startViews()[0]!.key);

      expect(transport.abandonWrite).toHaveBeenCalledWith(attemptId, 'start');
      expect(writer.startViews()).toMatchObject(views);

      writer.edit('body', 'Saved as ever');
      await writer.settled();

      expect(writer.state('body')).toBe('saved');
      expect(sent.at(-1)!.body.body).toBe('Saved as ever');

      writer.dismissStart(writer.startViews()[0]!.key);

      expect(writer.startViews()).toEqual([]);
    },
  );

  it('keeps a start sent again not known when its first send is refused late, before its claim', async () => {
    vi.useFakeTimers();

    const { writer, transport, answers } = await (async () => {
      const next = server();
      const writer = new DraftWriter('you', PR, next.transport, instant, NEVER);

      writer.observe(draft(1));

      return { ...next, writer };
    })();
    let refuse: () => void = () => {};

    answers.push(
      () =>
        new Promise((_resolve, reject) => {
          refuse = () => reject(new ApiError('Not active', 409, 'ACCOUNT_NOT_ACTIVE'));
        }),
    );

    const unknown = expect(writer.startSummary({})).rejects.toMatchObject({
      code: 'SUMMARY_START_UNKNOWN',
    });

    await vi.advanceTimersByTimeAsync(COMMAND_BOUND_MS + 1);
    await unknown;
    vi.useRealTimers();
    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();
    answers.push(() => new Promise(() => {}));
    void writer.sendStartAgain(writer.startViews()[0]!.key);
    await vi.waitFor(() => expect(writer.summaryStarting()).toBe(true));

    // The first send's bare refusal, late: the resend may be the one received.
    refuse();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(writer.startViews()).toEqual([]);
    expect(writer.summaryStarting()).toBe(true);
  });

  it('refuses to start on text a reload kept unconfirmed, saying why', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(0));
    first.answers.push(unreachable, async () => {
      throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
    });
    writer.edit('event', 'APPROVE');
    await writer.settled();

    const second = server();

    vi.mocked(second.transport.lookup).mockImplementation(() => new Promise(() => {}));

    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    await expect(reloaded.startSummary({})).rejects.toMatchObject({
      message: expect.stringMatching(/could not be confirmed as saved/),
    });
    expect(second.sent).toEqual([]);
  });

  it('seals a start afresh when its first send is refused before its claim', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    answers.push(async () => {
      throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
    });
    vi.mocked(transport.checkpoint)
      .mockResolvedValueOnce({ checkpoint: 7, seal: '0123456789abcdef' })
      .mockResolvedValueOnce({ checkpoint: 9, seal: 'fedcba9876543210' });

    await expect(writer.startSummary({})).resolves.toMatchObject({ id: 'run-1' });

    expect(sent.map((request) => String(request.body.attemptId).slice(0, 6))).toEqual([
      'ck1-7-',
      'ck1-9-',
    ]);
  });

  it('never sends a resealed start once its bound passed while it was recorded', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    const setItem = Storage.prototype.setItem;
    const now = Date.now();

    writer.observe(draft(1));
    answers.push(async () => {
      throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
    });
    vi.mocked(transport.checkpoint)
      .mockResolvedValueOnce({ checkpoint: 7, seal: '0123456789abcdef' })
      .mockResolvedValueOnce({ checkpoint: 9, seal: 'fedcba9876543210' });
    // Recording the new id takes the rest of the bound.
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
      this: Storage,
      key: string,
      value: string,
    ) {
      if (value.includes('fedcba9876543210')) clock(now + COMMAND_BOUND_MS + 1);

      setItem.call(this, key, value);
    });

    await expect(writer.startSummary({})).rejects.toMatchObject({ code: 'NOT_SENT' });
    expect(sent).toHaveLength(1);
  });

  it('after a reload, only looks up a preflight that may have been sent, holding its text, and releases its start', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(1));
    writer.edit('body', 'Asked on');
    first.answers.push(() => new Promise(() => {}));
    void writer.startSummary({});
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    expect(journal().starts).toMatchObject([{ phase: 'queued', preflight: { phase: 'sending' } }]);

    const second = server();

    vi.mocked(second.transport.lookup).mockImplementation(() => new Promise(() => {}));

    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    reloaded.observe(draft(1));
    await reloaded.flush();
    await reloaded.settled();

    expect(second.sent).toEqual([]);
    expect(second.transport.lookup).toHaveBeenCalledWith(first.sent[0]!.body.writeId, {
      revision: 1,
      generation: 0,
    });
    expect(reloaded.startViews()).toEqual([]);
    expect(reloaded.summaryStarting()).toBe(false);
  });

  it('after a reload, only looks up a start that may have been sent', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(1));
    first.answers.push(() => new Promise(() => {}));
    void writer.startSummary({});
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    vi.mocked(second.transport.lookup).mockResolvedValue({
      attempt: {
        id: first.sent[0]!.body.attemptId,
        state: 'committed',
        revision: 1,
        result: { body: {} },
      },
    });

    const reloaded = new DraftWriter('you', PR, second.transport, instant, NEVER);

    await reloaded.reconcile();

    expect(second.sent).toEqual([]);
    expect(second.transport.started).toHaveBeenCalled();
    expect(reloaded.startViews()).toEqual([]);
  });

  it('gives back only the reservation it still owns, so a newer save is never made twice', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    const ahead = held();

    writer.observe(draft(1));
    // The newer save is not confirmed: a second save of it would be sent under a fresh id.
    answers.push(ahead.answer, unreachable, async () => {
      throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
    });

    const comment = writer.write('addComment', pr, { body: 'Ahead' });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    writer.edit('body', 'Asked on');

    const started = writer.startSummary({});

    // Typed after the click, saved behind the start.
    writer.edit('body', 'Newer');
    void writer.flush();
    // The write ahead of it meets a change elsewhere: the start is refused at the front.
    ahead.release(conflict(draft(6)));
    await expect(comment).rejects.toBeDefined();
    await expect(started).rejects.toMatchObject({ code: 'DRAFT_CHANGED_LOCALLY' });
    await writer.settled();

    const newer = sent.filter((request) => request.body.body === 'Newer');

    // Its own send and its same-id resend, never another id.
    expect(newer).toHaveLength(2);
    expect(new Set(newer.map((request) => request.body.writeId)).size).toBe(1);
    expect(sent.some((request) => request.route === 'startAi')).toBe(false);
  });

  it('lets a later action go ahead once a held save of its text is found saved', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(unreachable, async () => {
      throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
    });
    writer.edit('event', 'APPROVE');
    await writer.settled();

    expect(writer.state('event')).toBe('error');

    vi.mocked(transport.lookup).mockResolvedValueOnce({
      attempt: { id: sent[0]!.body.writeId, state: 'committed', revision: 1, result: { body: {} } },
    });
    await writer.reconcile();
    await expect(writer.startSummary({})).resolves.toMatchObject({ id: 'run-1' });
  });
});

describe('kept refusals and recovery views', () => {
  const NEVER = 2_000_000_000;
  const where = {
    path: 'a.ts',
    line: 3,
    side: 'RIGHT' as const,
    startLine: null,
    view: { mode: 'full' },
  };
  const target = { path: 'a.ts', line: 3, side: 'RIGHT', startLine: null };
  const journal = () =>
    JSON.parse(sessionStorage.getItem(`review-desk-draft-writer:you:${PR}`) ?? '{}') as {
      writes?: { key: string; phase: string; texts?: string[]; replacement?: { key: string } }[];
    };
  const locked =
    (message = 'Line gone') =>
    async (request: WriteRequest) => {
      throw new ApiError(message, 409, 'LINE_GONE', {
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    };
  const unreachable = async () => {
    throw new ApiError('Not reachable', 0);
  };
  const gap = async () => {
    throw new ApiError('Sealed elsewhere', 409, 'WRITE_HISTORY_GAP');
  };

  it('keeps a refused comment with its text, journaled before its caller hears of it', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);
    let journaled: unknown;

    writer.observe(draft(0));
    answers.push(locked());

    const refusal = await writer
      .write<never>('addComment', pr, { ...target, body: 'Mine' }, { where })
      .catch((error: WriteRefused) => {
        journaled = journal().writes;

        return error;
      });

    expect(refusal).toMatchObject({ code: 'LINE_GONE', details: { kept: expect.any(String) } });
    expect(journaled).toMatchObject([{ phase: 'not-saved', texts: ['Mine'] }]);
    expect(writer.writeViews()).toMatchObject([
      {
        key: (refusal as WriteRefused).details.kept,
        phase: 'not-saved',
        texts: ['Mine'],
        canAddAsNew: true,
        where,
        reason: 'Line gone',
      },
    ]);
  });

  it('keeps an edit refused at the click, and nothing of a refused delete', async () => {
    const { commands, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(1));
    commands.push(unreachable);
    await expect(writer.submit(review, carried(writer), null)).rejects.toMatchObject({
      code: 'COMMAND_UNKNOWN',
    });
    await expect(
      writer.write('editComment', { ...pr, cid: 'c1' }, { body: 'Edited' }),
    ).rejects.toMatchObject({
      code: 'DRAFT_COMMAND_UNKNOWN',
    });
    await expect(writer.write('deleteComment', { ...pr, cid: 'c2' }, {})).rejects.toBeDefined();

    expect(writer.writeViews()).toMatchObject([
      { phase: 'not-saved', route: 'editComment', commentId: 'c1', texts: ['Edited'] },
    ]);
  });

  it('points the very same comment, asked for again, to its first entry, shown again', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(unreachable, gap);
    await expect(writer.write('addComment', pr, { ...target, body: 'Once' })).rejects.toBeDefined();

    const [first] = writer.writeViews();

    writer.dismissWrite(first!.key);

    expect(writer.writeViews()).toEqual([]);
    await expect(writer.write('addComment', pr, { ...target, body: 'Once' })).rejects.toMatchObject(
      {
        code: 'WRITE_UNRESOLVED',
        details: { kept: first!.key },
      },
    );
    expect(writer.writeViews().map((view) => view.key)).toEqual([first!.key]);
  });

  it('points a repeat to the very same comment on its way, gate closed or not, keeping no second entry', async () => {
    const { answers, commands, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(unreachable, gap);
    await expect(writer.write('addComment', pr, { ...target, body: 'Once' })).rejects.toBeDefined();

    const [first] = writer.writeViews();

    commands.push(unreachable);
    await expect(writer.submit(review, carried(writer), null)).rejects.toBeDefined();
    await expect(writer.write('addComment', pr, { ...target, body: 'Once' })).rejects.toMatchObject(
      {
        code: 'WRITE_UNRESOLVED',
        details: { kept: first!.key },
      },
    );

    expect(writer.writeViews().map((view) => view.key)).toEqual([first!.key]);
  });

  it('hides a kept refusal only while a composer shows its very text', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', PR, transport, instant, NEVER);

    writer.observe(draft(0));
    answers.push(locked());

    const key = await writer
      .write<never>('addComment', pr, { ...target, body: 'Mine' })
      .catch((error: WriteRefused) => String(error.details.kept));
    const release = writer.showing(key, 'Mine');

    expect(writer.writeViews()).toEqual([]);

    const other = writer.showing(key, 'Mine, edited');

    expect(writer.writeViews()).toHaveLength(1);
    other();
    release();
    expect(writer.writeViews()).toHaveLength(1);
  });

  /** A refused comment kept, and the writer that kept it. */
  async function kept(answers?: ((request: WriteRequest) => Promise<unknown>)[]) {
    const next = server();
    const writer = new DraftWriter('you', PR, next.transport, instant, NEVER);

    writer.observe(draft(0));
    next.answers.push(locked(), ...(answers ?? []));

    const key = await writer
      .write<never>('addComment', pr, { ...target, body: 'Mine' }, { where })
      .catch((error: WriteRefused) => String(error.details.kept));

    return { ...next, writer, key };
  }

  it('settles a kept comment with the new comment added from it', async () => {
    const { writer, key } = await kept();

    await writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key });

    expect(writer.writeViews()).toEqual([]);
  });

  it('folds a refused new comment back into the kept one, offered again with both texts', async () => {
    const { writer, key } = await kept([locked('Still gone')]);

    await expect(
      writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key }),
    ).rejects.toMatchObject({ details: { kept: key } });

    expect(writer.writeViews()).toMatchObject([
      { key, texts: ['Mine', 'Mine, again'], canAddAsNew: true },
    ]);
  });

  it('offers no other new comment while one may still land, dismissed or not', async () => {
    const { writer, key } = await kept([unreachable, gap]);

    await expect(
      writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key }),
    ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });

    const replacement = writer.writeViews().find((view) => view.key !== key)!;

    expect(writer.writeViews().find((view) => view.key === key)).toMatchObject({
      canAddAsNew: false,
      texts: ['Mine'],
    });

    writer.dismissWrite(replacement.key);

    expect(writer.writeViews()).toMatchObject([{ key, canAddAsNew: false }]);
  });

  it('links a kept comment to the very same comment on its way, settled with it', async () => {
    const { writer, key, answers, transport, sent } = await kept([unreachable, gap]);

    // The same comment, its outcome not known.
    await expect(writer.write('addComment', pr, { ...target, body: 'Same' })).rejects.toBeDefined();
    await expect(
      writer.write('addComment', pr, { ...target, body: 'Same' }, { recovers: key }),
    ).rejects.toMatchObject({ code: 'WRITE_UNRESOLVED' });

    const same = writer.writeViews().find((view) => view.key !== key)!;

    expect(writer.writeViews().find((view) => view.key === key)).toMatchObject({
      canAddAsNew: false,
    });

    vi.mocked(transport.lookup).mockResolvedValueOnce({
      attempt: {
        id: sent.at(-1)!.body.writeId,
        state: 'committed',
        revision: 1,
        result: { body: {} },
      },
    });
    await writer.reconcile();

    expect(writer.writeViews().map((view) => view.key)).not.toContain(same.key);
    expect(writer.writeViews().map((view) => view.key)).not.toContain(key);
    expect(answers).toEqual([]);
  });

  it('never sends as an ordinary comment one meant to add again a kept one no longer to be', async () => {
    const { writer, key, sent } = await kept();

    writer.dismissWrite(key);
    await expect(
      writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key }),
    ).rejects.toMatchObject({ code: 'RECOVERY_UNAVAILABLE' });
    expect(sent).toHaveLength(1);
  });

  it('keeps in the kept one a new comment of it refused at the click', async () => {
    const { writer, key, commands } = await kept();

    commands.push(unreachable);
    await expect(writer.submit(review, carried(writer), null)).rejects.toBeDefined();
    await expect(
      writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key }),
    ).rejects.toMatchObject({ code: 'DRAFT_COMMAND_UNKNOWN', details: { kept: key } });

    expect(writer.writeViews()).toMatchObject([
      { key, texts: ['Mine', 'Mine, again'], canAddAsNew: true },
    ]);
  });

  it('releases every kept one waiting on the very same comment once that one is refused', async () => {
    const first = await kept([locked('Gone too')]);
    const { writer, answers, transport, sent } = first;
    const second = await writer
      .write<never>('addComment', pr, { ...target, body: 'Theirs' })
      .catch((error: WriteRefused) => String(error.details.kept));
    const ahead = held();

    answers.push(ahead.answer);
    void writer.write('addComment', pr, { body: 'Ahead' });
    await vi.waitFor(() => expect(sent).toHaveLength(3));

    // Both ask for the same new comment, which waits in the queue behind the one ahead.
    const shared = { ...target, body: 'Shared' };
    const added = writer
      .write('addComment', pr, shared, { recovers: first.key })
      .catch((error) => error);

    await expect(
      writer.write('addComment', pr, shared, { recovers: second }),
    ).rejects.toMatchObject({
      code: 'WRITE_UNRESOLVED',
    });

    answers.push(locked('Shared refused'));
    ahead.release((request) => ({
      attempt: { id: request.body.writeId, state: 'committed', revision: 1 },
    }));
    await added;

    expect(
      writer
        .writeViews()
        .filter((view) => view.canAddAsNew)
        .map((view) => view.key)
        .sort(),
    ).toEqual([first.key, second].sort());
    expect(transport.send).toHaveBeenCalledTimes(4);
  });

  it('settles a kept comment with a new comment of it that sending again saved', async () => {
    const { writer, key, transport } = await kept([unreachable, gap]);

    await expect(
      writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key }),
    ).rejects.toMatchObject({ code: 'WRITE_UNCONFIRMED' });
    vi.mocked(transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: false,
      provable: true,
    });
    await writer.reconcile();

    const replacement = writer.writeViews().find((view) => view.key !== key)!;

    await writer.sendWriteAgain(replacement.key);

    expect(writer.writeViews()).toEqual([]);
  });

  it('offers to add again a comment whose refusal was found after a reload', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    void writer.write('addComment', pr, { ...target, body: 'Kept' }, { where });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const next = server();

    vi.mocked(next.transport.lookup).mockImplementation(async (id) => ({
      attempt: { id, state: 'refused', result: { status: 409, body: { error: 'Line gone' } } },
    }));

    const reloaded = new DraftWriter('you', PR, next.transport, instant, NEVER);

    await reloaded.reconcile();

    expect(reloaded.writeViews()).toMatchObject([
      { phase: 'not-saved', texts: ['Kept'], canAddAsNew: true, where },
    ]);
  });

  it('releases, after a reload, a new comment never sent, offering the kept one again', async () => {
    const { writer, key, answers, sent } = await kept();
    const ahead = held();

    answers.push(ahead.answer);
    void writer.write('addComment', pr, { body: 'Ahead' });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    void writer.write('addComment', pr, { ...target, body: 'Mine, again' }, { recovers: key });

    const reloaded = new DraftWriter('you', PR, server().transport, instant, NEVER);

    expect(reloaded.writeViews().find((view) => view.key === key)).toMatchObject({
      canAddAsNew: true,
      texts: ['Mine', 'Mine, again'],
    });
  });

  it('shows a write a stop found received, then one whose claim was gone since, never resendable', async () => {
    const first = server();
    const writer = new DraftWriter('you', PR, first.transport, instant, NEVER);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    void writer.write('addComment', pr, { ...target, body: 'Kept' });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const next = server();

    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: true,
      provable: false,
    });

    const reloaded = new DraftWriter('you', PR, next.transport, instant, NEVER);

    await reloaded.reconcile();
    vi.mocked(next.transport.abandonWrite).mockResolvedValueOnce({ outcome: 'pending' });
    await reloaded.stopWrite(reloaded.writeViews()[0]!.key);

    expect(reloaded.writeViews()).toMatchObject([{ phase: 'received', canStop: false }]);

    // Its claim gone since, even as a miss that would prove an unreceived one never arrived: it
    // was received, and whether it was saved can no longer be told.
    vi.mocked(next.transport.lookup).mockResolvedValue({
      arrived: false,
      fenced: true,
      provable: true,
    });
    await reloaded.reconcile();

    expect(reloaded.writeViews()).toMatchObject([
      { phase: 'unknown', received: true, canStop: true, canSendAgain: false, inspect: 'comment' },
    ]);
  });

  it('dismisses every settled entry at once, leaving what is still to be settled', async () => {
    const { writer, answers } = await kept([unreachable, gap]);

    await expect(
      writer.write('addComment', pr, { ...target, body: 'Not known' }),
    ).rejects.toBeDefined();

    expect(writer.writeViews().map((view) => view.phase)).toEqual(['not-saved', 'unknown']);

    writer.dismissSettled();

    expect(writer.writeViews().map((view) => view.phase)).toEqual(['unknown']);
    expect(answers).toEqual([]);
  });

  it('lists entries oldest first, whatever order they were kept in', () => {
    const entry = (key: string, body: string, createdAt: number) => ({
      key,
      phase: 'not-saved',
      intent: { route: 'addComment', params: pr, body: { ...target, body } },
      texts: [body],
      createdAt,
    });

    sessionStorage.setItem(
      `review-desk-draft-writer:you:${PR}`,
      JSON.stringify({
        fields: {
          body: {
            value: '',
            version: 0,
            settled: 0,
            savedAt: 0,
            failed: null,
            generation: null,
            since: null,
          },
          event: {
            value: 'COMMENT',
            version: 0,
            settled: 0,
            savedAt: 0,
            failed: null,
            generation: null,
            since: null,
          },
        },
        inflight: [],
        writes: [entry('b', 'Newer', 2_000), entry('a', 'Older', 1_000)],
      }),
    );

    const writer = new DraftWriter('you', PR, server().transport, instant, NEVER);

    expect(writer.writeViews().map((view) => view.texts[0])).toEqual(['Older', 'Newer']);
  });
});

describe('decoding a write', () => {
  const expected = { writeId: 'w', base: { revision: 4, generation: 0 } };
  const failing = (error: ApiError) => Promise.reject(error);

  it('settles only on an outcome that names the write, on its base', async () => {
    const committed = (id: string, revision: unknown) =>
      decode(Promise.resolve({ attempt: { id, state: 'committed', revision } }), true, expected);

    expect(await committed('w', 5)).toMatchObject({ kind: 'committed', revision: 5 });
    expect(await committed('other', 5)).toMatchObject({ kind: 'unknown' });
    expect(await committed('w', 3)).toMatchObject({ kind: 'unknown' });
    expect(await committed('w', 'five')).toMatchObject({ kind: 'unknown' });
    expect(await decode(Promise.resolve({ id: 'x' }), true, expected)).toMatchObject({
      kind: 'unknown',
    });
    expect(await decode(Promise.resolve({ pending: true }), true, expected)).toMatchObject({
      kind: 'unknown',
    });
  });

  it('takes a refusal before any claim as definite only for a client error to a first send', async () => {
    expect(
      await decode(failing(new ApiError('Bad', 400, 'INVALID')), true, expected),
    ).toMatchObject({
      kind: 'refused',
    });
    // The same refusal after an earlier send that may have arrived proves nothing.
    expect(
      await decode(failing(new ApiError('Bad', 400, 'INVALID')), false, expected),
    ).toMatchObject({ kind: 'unknown' });
    expect(await decode(failing(new ApiError('Broken', 500)), true, expected)).toMatchObject({
      kind: 'unknown',
    });
    expect(
      await decode(
        failing(
          new ApiError('Locked', 409, 'REVIEW_QUEUED', { attempt: { id: 'w', state: 'refused' } }),
        ),
        false,
        expected,
      ),
    ).toMatchObject({ kind: 'refused' });
    expect(
      await decode(
        failing(
          new ApiError('Locked', 409, 'REVIEW_QUEUED', { attempt: { id: 'x', state: 'refused' } }),
        ),
        false,
        expected,
      ),
    ).toMatchObject({ kind: 'unknown' });
    // A first client error carrying an attempt not this write's, or not one at all, is no outcome.
    for (const attempt of [{ id: 'x', state: 'refused' }, 'refused', { id: 'w', state: 'lost' }])
      expect(
        await decode(
          failing(new ApiError('Locked', 409, 'DRAFT_LOCKED', { attempt })),
          true,
          expected,
        ),
      ).toMatchObject({ kind: 'unknown' });
  });

  it('reads a lookup only in its declared shapes', () => {
    // A miss proves something only when the server says so.
    expect(fromLookup({ arrived: false, fenced: true, provable: true }, expected)).toBe('never');
    expect(fromLookup({ arrived: false, fenced: false, provable: true }, expected)).toBe('resend');
    expect(fromLookup({ arrived: false, fenced: true, provable: false }, expected)).toBe('unknown');
    expect(fromLookup({ arrived: false, fenced: false }, expected)).toBe('unknown');
    expect(fromLookup({ arrived: false, fenced: true, provable: 'yes' }, expected)).toBe('unknown');
    // Nothing it can read: proof of nothing.
    expect(fromLookup('oops', expected)).toBe('unreadable');
    expect(fromLookup({ arrived: false }, expected)).toBe('unreadable');
    expect(fromLookup({ fenced: true }, expected)).toBe('unreadable');
    expect(fromLookup({ attempt: { id: 'w', state: 'lost' } }, expected)).toBe('unreadable');
    expect(fromLookup({ attempt: { id: 'x', state: 'refused' } }, expected)).toBe('unreadable');
    // A settled attempt without what it recorded is not read as settled.
    expect(fromLookup({ attempt: { id: 'w', state: 'refused' } }, expected)).toBe('unreadable');
    expect(fromLookup({ attempt: { id: 'w', state: 'committed', revision: 5 } }, expected)).toBe(
      'unreadable',
    );
    expect(
      fromLookup(
        {
          attempt: {
            id: 'w',
            state: 'refused',
            result: { status: 409, body: { code: 'DRAFT_LOCKED' } },
          },
        },
        expected,
      ),
    ).toMatchObject({ kind: 'refused', error: { code: 'DRAFT_LOCKED' } });
  });
});

describe('the newer draft', () => {
  it("keeps the draft's own part by its revision and the forge's by its observation", () => {
    const review = { id: 'R', commentCount: 2 };
    const older = draft(5, { body: 'Newer text', githubPendingReview: null }, 0, 1);
    const later = draft(4, { body: 'Older text', githubPendingReview: review }, 0, 3);
    const merged = newerDraft(older, later);

    expect(merged.body).toBe('Newer text');
    expect(merged.githubPendingReview).toEqual(review);
    expect(merged.versions).toEqual({ revision: 5, generation: 0, observation: 3 });
  });
});
