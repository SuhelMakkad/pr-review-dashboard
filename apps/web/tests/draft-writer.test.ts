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

      const at = next(request);

      return {
        ...(request.route === 'saveDraft' ? draft(at, request.body as Partial<ReviewDraft>) : {}),
        attempt: { id: request.body.writeId, state: 'committed', revision: at },
      };
    }),
    lookup: vi.fn(async () => ({ arrived: false as const, fenced: false })),
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
    await writer.flush();

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
      .write('prepareAi', { account: 'you', runId: 'r' }, { prId: 'PR_1', indices: [0] })
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
    vi.mocked(transport.lookup).mockResolvedValueOnce({ arrived: false, fenced: true });

    await expect(writer.write('addComment', pr, { body: 'B' })).rejects.toMatchObject({
      code: 'NOT_RECEIVED',
    });
  });

  it('stops sending a write at its deadline, and keeps what it carried as unconfirmed', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    clock(1_000);
    writer.observe(draft(1));
    answers.push(async () => {
      clock(1_000 + ATTEMPT_TTL_MS);

      throw new ApiError('Not reachable', 0);
    });

    await expect(writer.write('addComment', pr, { body: 'Late' })).rejects.toMatchObject({
      code: 'NOT_CONFIRMED',
    });
    expect(sent).toHaveLength(1);
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
      code: 'NOT_CONFIRMED',
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
    // A reset deleted its receipt.
    vi.mocked(transport.receipt).mockResolvedValueOnce(null);
    await writer.reconcile();

    expect(writer.commandViews()).toMatchObject([{ phase: 'lost' }]);
    expect(writer.state('body')).toBe('error');
  });

  it('adopts an earlier version’s id as recovery-only: looked up or stopped, never sent again', () => {
    const { transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    expect(writer.adopt([{ id: 'legacy', kind: 'submit' }])).toBe(true);
    expect(writer.commandViews()).toMatchObject([
      { id: 'legacy', legacy: true, canSendAgain: false, carried: null },
    ]);
    expect(writer.blocked()).not.toBeNull();
  });

  it('keeps an earlier version’s id where it was when it could not be journaled', () => {
    const { transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant, 2_000_000_000);

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    expect(writer.adopt([{ id: 'legacy', kind: 'discard' }])).toBe(false);
    expect(writer.commandViews()).toEqual([]);
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
    expect(fromLookup({ arrived: false, fenced: true }, expected)).toBe('never');
    expect(fromLookup({ arrived: false, fenced: false }, expected)).toBe('resend');
    expect(fromLookup({ arrived: false }, expected)).toBe('resend');
    expect(fromLookup({ fenced: true }, expected)).toBe('resend');
    expect(fromLookup({ attempt: { id: 'w', state: 'lost' } }, expected)).toBe('resend');
    expect(fromLookup({ attempt: { id: 'x', state: 'refused' } }, expected)).toBe('resend');
    // A settled attempt without what it recorded is not read as settled.
    expect(fromLookup({ attempt: { id: 'w', state: 'refused' } }, expected)).toBe('resend');
    expect(fromLookup({ attempt: { id: 'w', state: 'committed', revision: 5 } }, expected)).toBe(
      'resend',
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
