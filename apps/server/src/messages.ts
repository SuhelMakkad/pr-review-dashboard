import { forForge, forgeTerms, type ForgeTerms } from '@review-desk/shared/accounts';

/** A reason that starts a sentence. */
const sentence = (text: string) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** An entry worded with parameters: their names, each a text, and the wording. */
interface Parameterised<Name extends string> {
  params: readonly Name[];
  text: (forge: ForgeTerms, params: Record<Name, string>) => string;
}

/** An entry with the parameters `params`, so a stored message is checked before it is worded. */
const given = <const Name extends string>(
  params: readonly Name[],
  text: (forge: ForgeTerms, params: Record<Name, string>) => string,
): Parameterised<Name> => ({ params, text });

/**
 * Every user-facing server message that names the forge or its terms, written once for any forge:
 * `f.name` (GitHub, GitLab), `f.short` (PR, MR), `f.long` (pull request, merge request) and
 * `f.cli` (gh, glab). An entry's parameters are named (`given`), each a text inserted as given;
 * one given as a message is worded for the same account first.
 *
 * Activity rows store these IDs, so an ID is never removed or given another meaning: reword its
 * text, or add an ID.
 */
const catalog = {
  // Pull requests.
  'pull.untracked': (f: ForgeTerms) => `This ${f.short} is no longer tracked.`,
  'pull.untracked-for-account': (f: ForgeTerms) =>
    `This ${f.short} is no longer tracked for this account.`,
  'pull.not-found': (f: ForgeTerms) => `${f.short} not found.`,
  'pull.unavailable': (f: ForgeTerms) => `This ${f.short} is no longer available.`,
  'pull.thread-elsewhere': (f: ForgeTerms) => `That thread is not on this ${f.short}.`,

  // Review writes.
  'review.rate-limited': (f: ForgeTerms) =>
    `Too many ${f.name} writes in a minute. Try again shortly.`,
  'review.cli-changed': given(
    ['login'],
    (f, p) => `The ${f.name} CLI is now logged in as ${p.login}. Nothing was posted.`,
  ),
  'review.not-commentable': (f: ForgeTerms) =>
    `${f.name} only accepts comments on lines that are part of this ${f.short}’s diff. Comment on the whole file instead, or pick a changed line.`,
  'review.suggestion-outdated': (f: ForgeTerms) =>
    `This suggestion was made for an older version of the ${f.short}. Run it again.`,
  'review.changed-while-commenting': (f: ForgeTerms) =>
    `The ${f.short} changed while you were commenting. Reload the diff, then comment again.`,
  'review.already-sent': (f: ForgeTerms) =>
    `This comment is already on ${f.name} as part of your pending review.`,
  'review.check-failed': given(
    ['reason'],
    (f, p) => `Could not check the ${f.short} before submitting: ${p.reason}`,
  ),
  'review.pending-exists': (f: ForgeTerms) =>
    `You have a pending review on ${f.name}. Add this comment to your review instead.`,
  'review.not-author': (f: ForgeTerms) =>
    `You can only request reviewers on your own ${f.short}s here.`,

  // AI reviews.
  'ai.not-reviewed': (f: ForgeTerms) => `You have not reviewed this ${f.short} yet.`,
  'ai.outdated': given(
    ['reason'],
    (f, p) =>
      `This review is out of date. ${p.reason} Regenerate it before preparing a ${f.name} review.`,
  ),
  'ai.new-commits': (f: ForgeTerms) =>
    `New commits arrived. Regenerate this review before preparing a ${f.name} review.`,
  'ai.pending-review': (f: ForgeTerms) =>
    `Finish or discard the pending ${f.name} review before replacing this prepared review.`,
  'ai.changed-while-stopped': (f: ForgeTerms) =>
    `The ${f.short} or its review discussion changed while this run was stopped. Generate a new review.`,
  'ai.unverified-coverage': (f: ForgeTerms) =>
    `Generate a new review to verify that it covers the current ${f.short}.`,
  'ai.changed-since': (f: ForgeTerms) =>
    `The ${f.short} or its review discussion changed after this was generated.`,
  'ai.stale-summary': given(
    ['reason'],
    (_f, p) => `${p.reason} Generate a new summary before using it.`,
  ),
  'ai.automatic-failed': (f: ForgeTerms) =>
    `Automatic AI review failed. Open the ${f.short} to run it again.`,
  'ai.truncated': (f: ForgeTerms) =>
    `_The rest of this review was cut to fit on ${f.name}. It is complete in Review Desk._`,

  // The outbox, as Activity shows it.
  'outbox.checking-interrupted': (f: ForgeTerms) => `Checking an interrupted ${f.name} request.`,
  'outbox.confirm-reopen': (f: ForgeTerms) =>
    `Check ${f.name} and confirm this action did not post before reopening it.`,
  'outbox.confirm-stop': (f: ForgeTerms) =>
    `Check ${f.name} before stopping: this action may already have posted.`,
  'outbox.confirm-restore': (f: ForgeTerms) =>
    `Confirm removing the pending ${f.name} review before restoring its draft.`,
  'outbox.checking-before-retry': (f: ForgeTerms) => `Checking ${f.name} before retrying.`,
  'outbox.stopped-approved': (f: ForgeTerms) =>
    `Stopped. The ${f.short} was approved; check whether its summary was posted.`,
  'outbox.stopped-unconfirmed': (f: ForgeTerms) =>
    `Stopped. Check ${f.name}: this review may already be posted.`,
  'outbox.cancelled-approved': (f: ForgeTerms) =>
    `Cancelled. The ${f.short} was approved; its summary was not posted.`,
  'outbox.checking-account': (f: ForgeTerms) => `Checking the ${f.name} account and ${f.long}.`,
  'outbox.cli-account-changed': (f: ForgeTerms) =>
    `The ${f.name} CLI account changed. Sign in to the original account before retrying.`,
  'outbox.account-changed-before-sending': (f: ForgeTerms) =>
    `The ${f.name} account changed before sending. Sign in to the original account before retrying.`,
  'outbox.sign-in-to-check': (f: ForgeTerms) =>
    `Sign in to the original ${f.name} account before checking this action.`,
  'outbox.pending-review-changed': (f: ForgeTerms) =>
    `A different pending review appeared on ${f.name}. Return to your draft and check its contents before submitting.`,
  'outbox.pending-review-outdated': (f: ForgeTerms) =>
    `The pending ${f.name} review belongs to an older commit. Restore its draft and review the new commits.`,
  'outbox.checkpoint-conflict': (f: ForgeTerms) =>
    `The saved execution no longer matches this request. Open ${f.name} before recovering.`,
  'outbox.previous-unconfirmed': (f: ForgeTerms) =>
    `The previous request may have reached ${f.name}. Check its result first.`,
  'outbox.already-submitted': (f: ForgeTerms) =>
    `This review was submitted on ${f.name}. Its saved content is preserved in Activity.`,
  'outbox.untracked': (f: ForgeTerms) => `Not posted: this ${f.short} is no longer tracked.`,
  'outbox.not-posted': given(['reason'], (_f, p) => `Not posted: ${p.reason}`),
  'outbox.viewed-file-gone': given(
    ['path'],
    (f, p) => `Not marked viewed: ${p.path} is no longer part of this ${f.short}.`,
  ),
  'outbox.viewed-file-changed': given(
    ['path'],
    (_f, p) =>
      `Not marked viewed: ${p.path} changed after you viewed it. Look at the new diff first.`,
  ),
  'outbox.approving': (f: ForgeTerms) => `Approving the ${f.short} with the AI review.`,
  'outbox.posting-review': (f: ForgeTerms) =>
    `Posting the AI review to the ${f.short} conversation.`,
  'outbox.submitting': (f: ForgeTerms) => `Submitting your pending review to ${f.name}.`,
  'outbox.sending': (f: ForgeTerms) => `Sending to ${f.name}.`,
  'outbox.added-to-pending': (f: ForgeTerms) => `Added to your pending review on ${f.name}.`,
  'outbox.confirmed': (f: ForgeTerms) => `Confirmed by ${f.name}.`,
  'outbox.connection-ended': (f: ForgeTerms) =>
    `The connection ended after sending. Checking ${f.name} before retrying.`,
  'outbox.pending-review-kept': (f: ForgeTerms) =>
    `${f.name} still has your pending review. You can retry submission.`,
  'outbox.step-confirmed': (f: ForgeTerms) => `${f.name} confirmed the interrupted step. Resuming.`,
  'outbox.unconfirmed': (f: ForgeTerms) =>
    `Unconfirmed. Open ${f.name} to verify before taking another action.`,
  'outbox.may-have-reached': (f: ForgeTerms) =>
    `This request may have reached ${f.name}. Your saved content is available below; it will not be sent again automatically.`,
  'outbox.result-unconfirmed': (f: ForgeTerms) => `Could not confirm the ${f.name} result.`,

  // Why an automatic post stops: a reason, then what you are asked to do.
  'stop.untracked': (f: ForgeTerms) => `this ${f.short} is no longer tracked.`,
  'stop.retargeted': (f: ForgeTerms) => `the ${f.short} now targets another branch.`,
  'stop.other-diff': (f: ForgeTerms) => `the ${f.short} shows another diff than the one reviewed.`,
  'stop.approval-withdrawn': (f: ForgeTerms) =>
    `your approval of the reviewed commit is no longer on the ${f.short}.`,
  'stop.discussion-changed': (f: ForgeTerms) =>
    `the ${f.short} or its discussion changed after this review. Run it again to review it.`,
  'stop.draft': (f: ForgeTerms) => `the ${f.short} was turned into a draft.`,
  'stop.own': (f: ForgeTerms) => `you cannot approve your own ${f.short}.`,
  'stop.nothing-more': given(
    ['reason'],
    (f, p) => `${sentence(p.reason)} Nothing more is sent; check the ${f.short}.`,
  ),
  'stop.nothing-more-approving': given(
    ['reason'],
    (f, p) =>
      `${sentence(p.reason)} Nothing more is sent; check the ${f.short}, then approve it yourself if it still applies.`,
  ),
  'stop.summary-held': given(
    ['reason'],
    (f, p) =>
      `${sentence(p.reason)} The ${f.short} was approved, but its summary was not posted; check the ${f.short}.`,
  ),
  'stop.approval-unknown': (f: ForgeTerms) =>
    `Review Desk could not record which approval this post gave, so its summary was not posted. Check the ${f.short}.`,
  'stop.approval-gone': (f: ForgeTerms) =>
    `Your approval of the reviewed commit is no longer on the ${f.short}, so its summary was not posted. Check the ${f.short}.`,
  'stop.summary-unchecked': (f: ForgeTerms) =>
    `This summary was queued before Review Desk could check it after approving. The ${f.short} was approved, but its summary was not posted; check the ${f.short}.`,
  'stop.legacy-approval': (f: ForgeTerms) =>
    `This automatic approval was queued before Review Desk checked what a review read. Nothing more is sent; check the ${f.short}, then approve it yourself if it still applies.`,
  'stop.legacy-gitlab-approval': (f: ForgeTerms) =>
    `This automatic approval was queued by an earlier version of Review Desk, which could not check its summary on GitLab. Nothing more is sent; check the ${f.short}, then approve it yourself if it still applies.`,

  // The sync and your queue.
  'sync.rate-limited': (f: ForgeTerms) =>
    `${f.name} is rate limited. Saved data is still available.`,
  'sync.cooling-down': (f: ForgeTerms) =>
    `${f.name} rate limit reached. Refresh will resume automatically after the cooldown.`,
  'sync.account-changed': (f: ForgeTerms) => `${f.name} account changed. Refresh before switching.`,
  'sync.no-change-detection': given(
    ['reason'],
    (f, p) => `Change detection unavailable; refetching every ${f.short}. ${p.reason}`,
  ),
  'queue.kept-changing': (f: ForgeTerms) =>
    `This ${f.short} kept changing in your queue while it was refreshed. Try again.`,
  'queue.removed-while-adding': (f: ForgeTerms) =>
    `This ${f.short} was removed from your queue while it was being added. Add it again.`,
  'queue.not-added': (f: ForgeTerms) => `Only ${f.short}s you added yourself can be removed.`,
  'queue.added-again': (f: ForgeTerms) =>
    `This ${f.short} was added again since, so nothing was removed.`,
} satisfies Record<
  string,
  | ((forge: ForgeTerms) => string)
  | { params: readonly string[]; text: (forge: ForgeTerms, params: never) => string }
>;

type Catalog = typeof catalog;

export type MessageId = keyof Catalog;

/** Every message the catalog has. */
export const messageIds = Object.keys(catalog) as MessageId[];

/** What an entry is worded with: nothing, or its named parameters. */
type ParamsOf<K extends MessageId> = Catalog[K] extends { params: readonly (infer Name)[] }
  ? Name extends string
    ? Record<Name, string>
    : never
  : undefined;

/** An entry's parameters as given: each a text as is, or a message worded first. */
type Given<P> = { [Name in keyof P]: string | Message };

/** A catalog message and its parameters, as stored in an Activity row. */
export type Message = {
  [K in MessageId]: ParamsOf<K> extends undefined
    ? { id: K }
    : { id: K; params: Given<ParamsOf<K>> };
}[MessageId];

/**
 * What a user is told: a catalog message, or a string that names no forge (or names one whatever
 * the account's is). A string is shown as it is, except in rows stored before the catalog
 * (`renderStored`).
 */
export type Wording = string | Message;

/** What `say` takes: each ID with its own parameters, so an ID of several kinds cannot drop them. */
type Said = {
  [K in MessageId]: ParamsOf<K> extends undefined ? [id: K] : [id: K, params: Given<ParamsOf<K>>];
}[MessageId];

/** The message `id`, with its parameters. */
export function say(...[id, params]: Said): Message {
  return (params === undefined ? { id } : { id, params }) as Message;
}

/** What a message no longer in the catalog says: one from a later version, or a damaged row. */
export const UNKNOWN_MESSAGE = 'Review Desk could not show this message.';

const isMessage = (value: unknown): value is Message =>
  typeof value === 'object' && value !== null && typeof (value as Message).id === 'string';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Words `wording` for `account`'s forge (GitHub's without an account): a catalog message from its
 * entry, a string as it is. A message the catalog does not have, or one without each parameter
 * its entry names as a text or a message, says `UNKNOWN_MESSAGE` instead: a damaged stored field
 * never stops the rest of a page.
 */
export function render(wording: Wording, account: string | null | undefined): string {
  if (typeof wording === 'string') return wording;
  if (!isMessage(wording) || !Object.hasOwn(catalog, wording.id)) return UNKNOWN_MESSAGE;

  const entry = catalog[wording.id] as ((forge: ForgeTerms) => string) | Parameterised<string>;
  const terms = forgeTerms(account);

  if (typeof entry === 'function') return entry(terms);

  const given = (wording as { params?: unknown }).params;

  if (!isRecord(given)) return UNKNOWN_MESSAGE;

  const params: Record<string, string> = {};

  for (const name of entry.params) {
    const value = given[name];

    if (typeof value === 'string') params[name] = value;
    else if (isMessage(value)) params[name] = render(value, account);
    else return UNKNOWN_MESSAGE;
  }

  return entry.text(terms, params);
}

/**
 * Words a stored Activity field for its row's account. A row written before the catalog holds
 * text written for GitHub, as do the rows' other strings: those are worded as `forForge` does, as
 * Activity always has. Each field is worded on its own, so a row can hold both kinds.
 */
export function renderStored(wording: Wording, account: string): string {
  return typeof wording === 'string' ? forForge(wording, account) : render(wording, account);
}

/** `message` with each text parameter, nested ones included, passed through `redacted`. */
function redactedMessage(message: Message, redacted: (text: string) => string): Message {
  const given = (message as { params?: unknown }).params;

  if (!isRecord(given)) return message;

  const params = Object.fromEntries(
    Object.entries(given).map(([name, value]) => [
      name,
      typeof value === 'string'
        ? redacted(value)
        : isMessage(value)
          ? redactedMessage(value, redacted)
          : value,
    ]),
  );

  return { ...message, params } as Message;
}

/**
 * What an error says, as a wording to store: a refusal's own message (see `ReviewError`), its
 * text parameters redacted as any error text is, otherwise the error's redacted message.
 */
export function wordingOf(error: unknown, redacted: (error: unknown) => string): Wording {
  const own = (error as { wording?: unknown } | null)?.wording;

  return isMessage(own) ? redactedMessage(own, redacted) : redacted(error);
}
