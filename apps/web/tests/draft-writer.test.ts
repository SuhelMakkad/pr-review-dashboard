// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '@review-desk/shared/review';
import {
  ATTEMPT_TTL_MS,
  decode,
  DraftWriter,
  fromLookup,
  WriteRefused,
  type Transport,
  type WriteRequest,
} from '@/features/review/draft-writer';
import { newerDraft } from '@/features/review/use-draft-writer';
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
  };

  return { sent, answers, transport, committed };
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

  it('autosaves nothing a command carries while it runs, and retires it once accepted', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    let accept: (value: string) => void = () => {};

    writer.observe(draft(1));
    writer.edit('body', 'Submitted before its pause');

    const submitting = writer.command(
      ['body', 'event'],
      () => new Promise<string>((resolve) => (accept = resolve)),
    );

    await writer.flush();
    expect(sent).toEqual([]);

    accept('queued');
    await expect(submitting).resolves.toBe('queued');
    await writer.flush();

    // Accepted: never saved into the draft it submitted, nor shown again over the next one.
    expect(sent).toEqual([]);
    expect(writer.state('body')).toBe('saved');
    expect(writer.value('body', draft(3, { body: '' }, 1))).toBe('');
  });

  it('saves what a refused command carried, as before it ran', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(1));
    writer.edit('body', 'Still mine');

    await expect(
      writer.command(['body', 'event'], async () => {
        throw new Error('Head moved');
      }),
    ).rejects.toThrow('Head moved');
    await vi.waitFor(() =>
      expect(sent.map((request) => request.body.body)).toEqual(['Still mine']),
    );
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
    // Nothing ahead of it commits: it would act on the draft the read showed.
    first.release(() => {
      throw new ApiError('Switch back to do this.', 409, 'ACCOUNT_NOT_ACTIVE');
    });
    await queued;
    await writer.flush();

    expect(sent.map((request) => request.body.body)).toEqual(['One']);
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
  });

  it('reads a lookup only in its declared shapes', () => {
    expect(fromLookup({ arrived: false, fenced: true }, expected)).toBe('never');
    expect(fromLookup({ arrived: false, fenced: false }, expected)).toBe('resend');
    expect(fromLookup({ arrived: false }, expected)).toBe('resend');
    expect(fromLookup({ fenced: true }, expected)).toBe('resend');
    expect(fromLookup({ attempt: { id: 'w', state: 'lost' } }, expected)).toBe('resend');
    expect(fromLookup({ attempt: { id: 'x', state: 'refused' } }, expected)).toBe('resend');
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
