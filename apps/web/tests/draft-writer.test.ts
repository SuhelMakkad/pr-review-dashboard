// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReviewDraft } from '@review-desk/shared/review';
import {
  decode,
  DraftWriter,
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
  const committed = (request: WriteRequest, body: unknown = {}) => {
    revision += 1;

    return {
      ...(body as object),
      attempt: { id: request.body.writeId, state: 'committed', revision },
    };
  };
  const transport: Transport = {
    send: vi.fn(async (request: WriteRequest) => {
      sent.push(request);

      const answer = answers.shift();

      return answer
        ? answer(request)
        : committed(
            request,
            request.route === 'saveDraft'
              ? draft(revision + 1, request.body as Partial<ReviewDraft>)
              : {},
          );
    }),
    lookup: vi.fn(async () => ({ arrived: false as const, fenced: false })),
    committed: vi.fn(),
    stale: vi.fn(),
    refused: vi.fn(),
  };

  return { sent, answers, transport, committed, at: () => revision };
}

const instant = () => 0;

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.useRealTimers());

describe('the draft writer', () => {
  it('sends every draft write in the order it was made, a write behind a save waiting for it', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(0));
    writer.edit('event', 'APPROVE');

    const added = writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'Hi' });

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

    const first = writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'One' });
    const second = writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'Two' });

    // A read meanwhile (another tab's change) never moves a queued write's base.
    writer.observe(draft(9));
    await Promise.all([first, second]);

    expect(sent.map((request) => request.body.baseRevision)).toEqual([5, 1]);
  });

  it('acknowledges a field only by a save of its version: an edit during its save is sent next', async () => {
    const { sent, answers, transport, committed } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    let release = () => {};

    writer.observe(draft(0));
    answers.push(
      (request) =>
        new Promise((resolve) => {
          release = () => resolve(committed(request, draft(1)));
        }),
    );
    writer.edit('body', 'A');

    const saving = writer.flush();

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    writer.edit('body', 'B');
    writer.edit('body', 'A');
    release();
    await saving;
    await writer.flush();

    // Back to A, which the first save also sent: still sent, as a newer version.
    expect(sent.map((request) => request.body.body)).toEqual(['A', 'A']);
    expect(writer.state('body')).toBe('saved');
  });

  it('rebases a save on a change elsewhere, and keeps it unsent after a discard elsewhere', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);
    const conflict = (fresh: ReviewDraft) => async (request: WriteRequest) => {
      throw new ApiError('Changed', 409, 'DRAFT_REVISION_CONFLICT', {
        draft: fresh,
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    };

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
    answers.push(async (request) => {
      throw new ApiError('Changed', 409, 'DRAFT_REVISION_CONFLICT', {
        draft: draft(3),
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    });

    const first = writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'One' });
    const second = writer.write(
      'editComment',
      { account: 'you', id: 'PR_1', cid: 'c' },
      { body: 'Two' },
    );

    await expect(first).rejects.toBeInstanceOf(WriteRefused);
    await expect(second).rejects.toMatchObject({ code: 'DRAFT_CHANGED_LOCALLY' });
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

    await writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'Once' });

    expect(sent).toHaveLength(3);
    expect(new Set(sent.map((request) => request.body.writeId)).size).toBe(1);
    expect(new Set(sent.map((request) => request.body.baseRevision))).toEqual(new Set([1]));
  });

  it('looks a pending write up until it settles, and takes one that never arrived and never can as refused', async () => {
    const { answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(0));
    answers.push(async () => ({ pending: true }));
    vi.mocked(transport.lookup).mockResolvedValueOnce({
      attempt: {
        id: 'x',
        state: 'committed',
        revision: 1,
        result: { revision: 1, body: { id: 'c1' } },
      },
    });

    await expect(
      writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'A' }),
    ).resolves.toEqual({ id: 'c1' });

    answers.push(async () => ({ pending: true }));
    vi.mocked(transport.lookup).mockResolvedValueOnce({ arrived: false, fenced: true });

    await expect(
      writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'B' }),
    ).rejects.toMatchObject({ code: 'NOT_RECEIVED' });
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

  it('saves again on the draft as it is an autosave a reload resent into a change elsewhere', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    writer.edit('event', 'APPROVE');
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    second.answers.push(async (request) => {
      throw new ApiError('Changed', 409, 'DRAFT_REVISION_CONFLICT', {
        draft: draft(5),
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    });

    const reloaded = new DraftWriter('you', 'PR_1', second.transport, instant);

    await vi.waitFor(() => expect(second.sent).toHaveLength(2));
    await reloaded.flush();

    expect(second.sent.map((request) => [request.body.event, request.body.baseRevision])).toEqual([
      ['APPROVE', 2],
      ['APPROVE', 5],
    ]);
    await vi.waitFor(() => expect(reloaded.state('event')).toBe('saved'));
  });

  it('stops the actions behind a save that met a discard elsewhere', async () => {
    const { sent, answers, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(2));
    answers.push(async (request) => {
      throw new ApiError('Changed', 409, 'DRAFT_REVISION_CONFLICT', {
        draft: draft(4, {}, 1),
        attempt: { id: request.body.writeId, state: 'refused' },
      });
    });
    writer.edit('body', 'Mine');

    await expect(
      writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'Behind it' }),
    ).rejects.toMatchObject({ code: 'DRAFT_CHANGED_LOCALLY' });
    expect(sent).toHaveLength(1);
  });

  it('restores no journal older than a week', async () => {
    const writer = new DraftWriter('you', 'PR_1', server().transport, instant);
    const now = Date.now();

    writer.edit('body', 'Long ago');
    vi.spyOn(Date, 'now').mockReturnValue(now + 8 * 24 * 60 * 60 * 1000);

    const reloaded = new DraftWriter('you', 'PR_1', server().transport, instant);

    expect(reloaded.value('body', draft(1, { body: 'Saved' }))).toBe('Saved');
    vi.restoreAllMocks();
    // Its pending save is sent now rather than in a later test.
    await writer.flush();
  });

  it('never sends a comment write again after a reload: the draft read then shows if it was kept', async () => {
    const first = server();
    const writer = new DraftWriter('you', 'PR_1', first.transport, instant);

    writer.observe(draft(2));
    first.answers.push(() => new Promise(() => {}));
    void writer.write('addComment', { account: 'you', id: 'PR_1' }, { body: 'Once' });
    await vi.waitFor(() => expect(first.sent).toHaveLength(1));

    const second = server();

    await new DraftWriter('you', 'PR_1', second.transport, instant).flush();

    expect(second.sent).toEqual([]);
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

    reloaded.edit('body', 'Refused, typed again');
    await reloaded.flush();

    expect(second.sent.map((request) => request.body.body)).toEqual(['Refused, typed again']);
  });

  it('never sends an edit made before a discard elsewhere into the draft after it', async () => {
    const { sent, transport } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, () => 0);

    writer.observe(draft(3));
    writer.edit('body', 'Typed on the old draft');
    // Another tab discarded the draft: the next read is its next generation.
    writer.observe(draft(4, {}, 1));
    await writer.flush();

    expect(sent).toEqual([]);
    expect(writer.state('body')).toBe('error');

    writer.edit('body', 'Typed on the new draft');
    await writer.flush();

    expect(sent.map((request) => [request.body.body, request.body.baseGeneration])).toEqual([
      ['Typed on the new draft', 1],
    ]);
  });

  it('retires a refused edit that an applied summary replaced', async () => {
    const { answers, transport, committed } = server();
    const writer = new DraftWriter('you', 'PR_1', transport, instant);

    writer.observe(draft(1));
    answers.push(async () => {
      throw new ApiError('Locked', 409, 'DRAFT_LOCKED');
    });
    writer.edit('body', 'Refused');
    await writer.flush();
    answers.push(async (request) => committed(request, draft(2, { body: 'Generated' })));
    await writer.write('applyAi', { account: 'you', runId: 'r' }, { prId: 'PR_1' });

    expect(writer.state('body')).toBe('saved');
    expect(writer.value('body', draft(2, { body: 'Generated' }))).toBe('Generated');
  });
});

describe('decoding a write', () => {
  it('settles only on a decoded outcome', async () => {
    expect(await decode(Promise.resolve({ id: 'x' }), true)).toMatchObject({ kind: 'unknown' });
    expect(await decode(Promise.reject(new ApiError('Bad', 400, 'INVALID')), true)).toMatchObject({
      kind: 'refused',
    });
    // The same refusal after an earlier send that may have arrived proves nothing.
    expect(await decode(Promise.reject(new ApiError('Bad', 400, 'INVALID')), false)).toMatchObject({
      kind: 'unknown',
    });
    expect(
      await decode(
        Promise.reject(
          new ApiError('Locked', 409, 'REVIEW_QUEUED', { attempt: { id: 'x', state: 'refused' } }),
        ),
        false,
      ),
    ).toMatchObject({ kind: 'refused' });
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
