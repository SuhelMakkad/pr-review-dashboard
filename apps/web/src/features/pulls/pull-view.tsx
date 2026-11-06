import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import {
  AlarmClock,
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  Copy,
  FileCode2,
  FileDiff,
  GitBranch,
  GitCommitHorizontal,
  MessageSquare,
} from 'lucide-react';
import type {
  PullRequestDetail,
  PullRequestItem,
  PullRequestSnapshot,
  ReviewThread,
} from '@review-desk/shared/types';
import { api } from '../../lib/api';
import { usePullDetail, useTriage } from '../../lib/queries';
import { useShortcuts } from '../../lib/shortcuts';
import { dateTime, relativePhrase, shortDateTime } from '../../lib/time';
import { Avatar } from '../../ui/avatar';
import { Button } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/kbd';
import { MarkdownView } from '../../ui/markdown';
import { AssistPanel } from '../ai/assist-panel';
import { FullReview } from '../ai/full-review';
import { LinearCard } from '../linear/linear-card';
import { useInboxNavigation } from '../inbox/inbox-context';
import { usePullActions } from './actions';
import { CiIndicator, ciMeta, reasonMeta, reviewMeta, tone } from './meta';
import { Notes } from './notes';
import { SnoozeMenu } from './snooze-menu';

const shortSha = (oid: string | null | undefined) => oid?.slice(0, 7) ?? 'unknown';

function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-t border-line px-6 py-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">{title}</h3>
        {aside}
      </div>
      {children}
    </section>
  );
}

function whyLines(
  item: PullRequestItem,
  pr: PullRequestSnapshot,
): { kind: keyof typeof reasonMeta; text: string; at: string }[] {
  const seen = new Set<string>();
  const lines: { kind: keyof typeof reasonMeta; text: string; at: string }[] = [];
  const replies = item.reasons.filter((reason) => reason.kind === 'reply');

  for (const reason of item.reasons) {
    if (seen.has(reason.kind)) continue;

    seen.add(reason.kind);

    const text =
      reason.kind === 'first_review'
        ? item.requestedVia.some((via) => via !== 'Direct request')
          ? `Review requested via ${item.requestedVia.filter((via) => via !== 'Direct request').join(', ')}`
          : 'Your review was requested'
        : reason.kind === 'changed'
          ? `New commits since your review · ${shortSha(item.latestReview?.commitOid)} → ${shortSha(pr.headOid)}`
          : reason.kind === 'requested_again'
            ? 'Review requested again after your last review'
            : reason.kind === 'reply'
              ? `${replies.length} new ${replies.length === 1 ? 'reply' : 'replies'} in threads you joined`
              : reason.kind === 'mention'
                ? 'You were mentioned in the conversation'
                : 'Your latest review was dismissed';

    lines.push({
      kind: reason.kind,
      text,
      at: reason.kind === 'reply' ? replies.at(-1)!.at : reason.at,
    });
  }

  return lines;
}

function Thread({
  thread,
  account,
  unread,
}: {
  thread: ReviewThread;
  account: string;
  unread: Set<string>;
}) {
  return (
    <article className="overflow-hidden rounded-md border border-line">
      <header className="flex items-center gap-2 border-b border-line bg-sunken px-3 py-1.5 text-xs">
        <FileCode2 size={12} className="text-fg-subtle" aria-hidden="true" />
        <code className="min-w-0 flex-1 truncate text-fg-muted">
          {thread.path}
          {thread.line ? `:${thread.line}` : ''}
        </code>
        {thread.isOutdated && <span className="text-2xs text-fg-subtle">Outdated</span>}
        <span
          className="tone rounded-xs px-1.5 text-2xs font-medium"
          style={tone(thread.isResolved ? 'ok' : 'neutral')}
        >
          {thread.isResolved ? 'Resolved' : 'Open'}
        </span>
      </header>
      <div className="divide-y divide-line">
        {thread.comments.map((comment) => {
          const isUnread = unread.has(`${comment.id}:${comment.updatedAt}`);
          const mine = comment.author.login.toLowerCase() === account.toLowerCase();

          return (
            <div key={comment.id} className={cn('px-3 py-2.5', isUnread && 'bg-reply/8')}>
              <div className="mb-1 flex items-center gap-2 text-xs">
                <Avatar login={comment.author.login} size={16} />
                <span className="font-medium">{comment.author.login}</span>
                {mine && <span className="text-fg-subtle">you</span>}
                {isUnread && (
                  <span
                    className="tone rounded-xs px-1 text-2xs font-semibold"
                    style={tone('reply')}
                  >
                    New
                  </span>
                )}
                <a
                  href={comment.url}
                  target="_blank"
                  rel="noreferrer"
                  className="ml-auto text-fg-subtle hover:text-fg"
                  title={dateTime(comment.createdAt)}
                >
                  {relativePhrase(comment.createdAt)}
                </a>
              </div>
              <MarkdownView>{comment.body}</MarkdownView>
            </div>
          );
        })}
      </div>
    </article>
  );
}

export function PullView({
  item,
  variant,
  lead,
}: {
  item: PullRequestItem;
  variant: 'pane' | 'page';
  /** Shown under the header (e.g. the author blocker checklist). */
  lead?: ReactNode;
}) {
  const query = usePullDetail(item.id);
  const detail = query.data;

  if (!detail) {
    return (
      <div className="p-6 text-sm text-fg-muted" aria-busy={!query.error}>
        {query.error ? query.error.message : 'Loading pull request…'}
      </div>
    );
  }

  return <PullDetailView key={item.id} item={item} detail={detail} variant={variant} lead={lead} />;
}

function PullDetailView({
  item,
  detail,
  variant,
  lead,
}: {
  item: PullRequestItem;
  detail: PullRequestDetail;
  variant: 'pane' | 'page';
  lead?: ReactNode;
}) {
  const pr = detail.snapshot;
  const account = detail.account;
  const authored = pr.author.login.toLowerCase() === account.toLowerCase();
  const actions = usePullActions();
  const triage = useTriage();
  const inbox = useInboxNavigation();
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const [showAllFiles, setShowAllFiles] = useState(false);
  const noteRef = useRef<HTMLTextAreaElement>(null);
  const unread = new Set(item.unreadReplyKeys);
  const mine = pr.threads.filter((thread) =>
    thread.comments.some((comment) => comment.author.login.toLowerCase() === account.toLowerCase()),
  );
  const latest = item.latestReview;
  const why = whyLines(item, pr);
  const conversation = pr.conversation.slice(-10);

  // Opening a PR refreshes it when the cached copy is more than two minutes old.
  useEffect(() => {
    if (Date.now() - Date.parse(pr.fetchedAt) > 120_000) {
      void api(`/api/pulls/${encodeURIComponent(item.id)}/refresh`, { method: 'POST' }).catch(
        () => undefined,
      );
    }
  }, [item.id]);
  const files = showAllFiles ? pr.files : pr.files.slice(0, 12);

  const leaveQueue = (action: () => void) => {
    if (variant === 'pane' && item.queue !== 'snoozed') inbox?.advance();

    action();
  };

  useShortcuts([
    {
      keys: 'o',
      label: 'Open on GitHub',
      group: 'Pull request',
      run: () => actions.openOnGitHub(item),
    },
    {
      keys: 'e',
      label: 'Done until new activity',
      group: 'Pull request',
      run: () => leaveQueue(() => actions.done(item)),
    },
    { keys: 's', label: 'Snooze', group: 'Pull request', run: () => setSnoozeOpen(true) },
    {
      keys: 'Shift+s',
      label: 'Wake from snooze',
      group: 'Pull request',
      run: () => item.snoozedUntil && actions.wake(item),
    },
    {
      keys: 'm',
      label: 'Mark replies seen',
      group: 'Pull request',
      run: () => actions.markSeen(item),
    },
    {
      keys: 'y',
      label: 'Copy GitHub link',
      group: 'Pull request',
      run: () => void actions.copyLink(item),
    },
    {
      keys: 'n',
      label: 'Write a private note',
      group: 'Pull request',
      run: () => noteRef.current?.focus(),
    },
  ]);

  return (
    <article
      className="scroll-thin h-full overflow-y-auto"
      aria-label={`${pr.title}, pull request details`}
    >
      <div className={cn(variant === 'page' && 'mx-auto max-w-4xl')}>
        <header className="px-6 pt-5 pb-4">
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-accent"
          >
            {pr.repository}
            <span className="text-fg-subtle">#{pr.number}</span>
            <ArrowUpRight size={12} aria-hidden="true" />
          </a>
          <h2
            className={cn(
              'mt-1 font-semibold text-balance text-fg',
              variant === 'page' ? 'text-xl' : 'text-lg',
            )}
          >
            {pr.title}
            {pr.isDraft && (
              <span className="ml-2 rounded-xs border border-line-strong px-1.5 align-middle text-2xs font-medium text-fg-muted">
                Draft
              </span>
            )}
          </h2>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-fg-muted">
            <span className="inline-flex items-center gap-1.5">
              <Avatar login={pr.author.login} size={18} />
              <span className="font-medium text-fg">{pr.author.login}</span>
              opened {relativePhrase(pr.createdAt)}
            </span>
            <span className="inline-flex min-w-0 items-center gap-1">
              <GitBranch size={12} aria-hidden="true" />
              <code className="max-w-[220px] truncate" title={pr.headRefName}>
                {pr.headRefName}
              </code>
              <ChevronRight size={11} aria-hidden="true" />
              <code>{pr.baseRefName}</code>
            </span>
            <span className="tabular-nums">
              <span className="text-add">+{pr.additions.toLocaleString()}</span>{' '}
              <span className="text-del">−{pr.deletions.toLocaleString()}</span> · {pr.changedFiles}{' '}
              files
            </span>
          </div>
        </header>

        {lead}

        <LinearCard prId={item.id} />

        {why.length > 0 && (
          <div className="mx-6 mb-4 space-y-1.5 rounded-md border border-line bg-sunken px-3 py-2.5">
            {why.map((line) => {
              const Icon = reasonMeta[line.kind].icon;

              return (
                <p key={line.kind} className="flex items-center gap-2 text-sm">
                  <Icon
                    size={14}
                    style={{ color: `var(--${reasonMeta[line.kind].tone})` }}
                    aria-hidden="true"
                  />
                  <span className="flex-1">{line.text}</span>
                  <time className="text-xs text-fg-subtle" title={dateTime(line.at)}>
                    {relativePhrase(line.at)}
                  </time>
                </p>
              );
            })}
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 px-6 pb-4">
          <Link
            to="/pr/$owner/$repo/$number/files"
            params={{
              owner: pr.repository.split('/')[0],
              repo: pr.repository.split('/')[1],
              number: String(pr.number),
            }}
            search={{}}
            className="inline-flex h-7 items-center gap-1.5 rounded-sm bg-accent px-2.5 text-xs font-medium text-accent-fg hover:bg-accent-hover"
          >
            <FileDiff size={13} aria-hidden="true" />
            Review changes
            {variant === 'pane' && (
              <Kbd
                keys="Enter"
                className="opacity-80 [&_kbd]:border-accent-fg/30 [&_kbd]:bg-transparent [&_kbd]:text-accent-fg"
              />
            )}
          </Link>
          <a
            href={pr.url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line-strong px-2.5 text-xs font-medium hover:bg-hover"
          >
            GitHub
            <ArrowUpRight size={13} aria-hidden="true" />
            <Kbd keys="o" />
          </a>
          {!authored && (
            <>
              <SnoozeMenu
                item={item}
                open={snoozeOpen}
                onOpenChange={setSnoozeOpen}
                onSnooze={(until) => leaveQueue(() => actions.snooze(item, until))}
                onWake={() => actions.wake(item)}
              />
              <Button
                size="sm"
                icon={<CheckCheck size={13} />}
                shortcut="e"
                onClick={() => leaveQueue(() => actions.done(item))}
              >
                {item.doneAt ? 'Undo done' : 'Done'}
              </Button>
              {item.unreadReplyKeys.length > 0 && (
                <Button
                  size="sm"
                  icon={<MessageSquare size={13} />}
                  shortcut="m"
                  onClick={() => actions.markSeen(item)}
                >
                  Mark seen
                </Button>
              )}
            </>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={13} />}
            onClick={() => void actions.copyLink(item)}
            aria-label="Copy GitHub link"
          />
        </div>

        {(item.snoozedUntil || item.doneAt) && (
          <p className="mx-6 mb-4 flex items-center gap-2 rounded-sm bg-sunken px-3 py-2 text-xs text-fg-muted">
            {item.snoozedUntil ? (
              <AlarmClock size={13} aria-hidden="true" />
            ) : (
              <CheckCheck size={13} aria-hidden="true" />
            )}
            {item.snoozedUntil
              ? `Snoozed until ${shortDateTime(item.snoozedUntil)}. New activity wakes it early.`
              : `Marked done ${relativePhrase(item.doneAt!)}. It returns when there is new activity.`}
          </p>
        )}

        <Section title="Full review">
          <FullReview
            prId={item.id}
            account={account}
            repository={pr.repository}
            number={pr.number}
            headOid={pr.headOid}
            ci={pr.ci}
          />
        </Section>

        <Section title="✦ Assist">
          <AssistPanel
            prId={item.id}
            account={account}
            tasks={[
              'brief',
              ...(latest?.commitOid && latest.commitOid !== pr.headOid
                ? (['since_review'] as const)
                : []),
              ...(item.sources.includes('authored') ? (['author_feedback'] as const) : []),
            ]}
            threadLabel={(threadId) => {
              const thread = pr.threads.find((candidate) => candidate.id === threadId);

              return thread
                ? `${thread.path.split('/').pop()}${thread.line ? `:${thread.line}` : ''}`
                : threadId;
            }}
          />
        </Section>

        {!authored && (
          <Section
            title="Your review"
            aside={
              latest && (
                <time className="text-xs text-fg-subtle" title={dateTime(latest.submittedAt)}>
                  {relativePhrase(latest.submittedAt)}
                </time>
              )
            }
          >
            {latest ? (
              <div className="space-y-2">
                <p className="flex items-center gap-2 text-sm">
                  <span
                    className="tone rounded-xs px-1.5 py-0.5 text-xs font-medium"
                    style={tone(reviewMeta[latest.state].tone)}
                  >
                    {reviewMeta[latest.state].label}
                  </span>
                  <span className="text-fg-subtle">on</span>
                  <code className="text-xs text-fg-muted">{shortSha(latest.commitOid)}</code>
                </p>
                {latest.body && (
                  <MarkdownView className="text-fg-muted">{latest.body}</MarkdownView>
                )}
                {latest.commitOid && latest.commitOid !== pr.headOid && (
                  <p className="flex items-center gap-2 text-xs text-changed">
                    <GitCommitHorizontal size={13} aria-hidden="true" />
                    The branch moved to {shortSha(pr.headOid)} since this review (including rebases
                    and force pushes).
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-fg-muted">You have not reviewed this PR yet.</p>
            )}
          </Section>
        )}

        <Section
          title={`Your conversations${mine.length ? ` · ${mine.length}` : ''}`}
          aside={
            item.unreadReplyKeys.length > 0 && (
              <span className="text-xs text-reply">
                {item.unreadReplyKeys.length} new · press <kbd className="font-sans">M</kbd> to mark
                seen
              </span>
            )
          }
        >
          {mine.length ? (
            <div className="space-y-3">
              {mine.map((thread) => (
                <Thread key={thread.id} thread={thread} account={account} unread={unread} />
              ))}
            </div>
          ) : (
            <p className="text-sm text-fg-muted">
              Inline threads you start or join appear here, including resolved ones.
            </p>
          )}
        </Section>

        {conversation.length > 0 && (
          <Section title={`Conversation · ${pr.conversation.length}`}>
            <ol className="space-y-3">
              {conversation.map((comment) => {
                const isUnread = unread.has(`mention:${comment.id}:${comment.updatedAt}`);

                return (
                  <li
                    key={comment.id}
                    className={cn(
                      'rounded-md border border-line px-3 py-2.5',
                      isUnread && 'border-mention/40 bg-mention/5',
                    )}
                  >
                    <div className="mb-1 flex items-center gap-2 text-xs">
                      <Avatar login={comment.author.login} size={16} />
                      <span className="font-medium">{comment.author.login}</span>
                      {isUnread && (
                        <span
                          className="tone rounded-xs px-1 text-2xs font-semibold"
                          style={tone('mention')}
                        >
                          Mentions you
                        </span>
                      )}
                      <a
                        href={comment.url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-auto text-fg-subtle hover:text-fg"
                        title={dateTime(comment.createdAt)}
                      >
                        {relativePhrase(comment.createdAt)}
                      </a>
                    </div>
                    <MarkdownView>{comment.body}</MarkdownView>
                  </li>
                );
              })}
            </ol>
          </Section>
        )}

        <Section title="Description">
          {pr.body.trim() ? (
            <MarkdownView>{pr.body}</MarkdownView>
          ) : (
            <p className="text-sm text-fg-muted">No description provided.</p>
          )}
        </Section>

        <Section title="Checks" aside={<CiIndicator state={pr.ci} withLabel />}>
          <p className="mb-2 text-xs text-fg-muted">
            {pr.mergeable === 'CONFLICTING'
              ? 'This branch has merge conflicts.'
              : pr.mergeable === 'MERGEABLE'
                ? 'No merge conflicts.'
                : 'GitHub is still calculating mergeability.'}
          </p>
          {pr.checks.length ? (
            <ul className="space-y-1">
              {pr.checks.map((check, index) => (
                <li key={`${check.name}-${index}`} className="flex items-center gap-2 text-sm">
                  <CiIndicator state={check.state} />
                  {check.url ? (
                    <a
                      href={check.url}
                      target="_blank"
                      rel="noreferrer"
                      className="hover:text-accent hover:underline"
                    >
                      {check.name}
                    </a>
                  ) : (
                    <span>{check.name}</span>
                  )}
                  <span className="ml-auto text-xs text-fg-subtle">
                    {ciMeta[check.state].label.replace('Checks ', '')}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">No checks reported for this commit.</p>
          )}
        </Section>

        <Section
          title={`Files · ${pr.changedFiles}`}
          aside={
            <a
              href={`${pr.url}/files`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-fg-muted hover:text-accent"
            >
              View diff on GitHub <ArrowUpRight size={12} aria-hidden="true" />
            </a>
          }
        >
          <ul className="space-y-0.5">
            {files.map((file) => (
              <li key={file.path} className="flex items-center gap-2 text-xs">
                <FileCode2 size={12} className="shrink-0 text-fg-subtle" aria-hidden="true" />
                <code className="min-w-0 flex-1 truncate text-fg-muted" title={file.path}>
                  {file.path}
                </code>
                <span className="shrink-0 tabular-nums">
                  <span className="text-add">+{file.additions}</span>{' '}
                  <span className="text-del">−{file.deletions}</span>
                </span>
              </li>
            ))}
          </ul>
          {pr.files.length > 12 && (
            <button
              type="button"
              className="mt-2 text-xs text-accent hover:underline"
              onClick={() => setShowAllFiles(!showAllFiles)}
            >
              {showAllFiles ? 'Show fewer' : `Show all ${pr.files.length} files`}
            </button>
          )}
        </Section>

        <section className="border-t border-line px-6 py-5">
          <Notes
            ref={noteRef}
            account={account}
            id={item.id}
            saved={detail.triage.note}
            onSave={(note) => triage.mutateAsync({ id: item.id, account, update: { note } })}
          />
        </section>

        {pr.reviews.length > 1 && (
          <Section title={`Review history · ${pr.reviews.length}`}>
            <ol className="space-y-2">
              {[...pr.reviews].reverse().map((review) => (
                <li key={review.id} className="flex items-center gap-2 text-xs">
                  <span
                    className="tone rounded-xs px-1.5 font-medium"
                    style={tone(reviewMeta[review.state].tone)}
                  >
                    {reviewMeta[review.state].label}
                  </span>
                  <code className="text-fg-subtle">{shortSha(review.commitOid)}</code>
                  <a
                    href={review.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-fg-muted hover:text-accent"
                  >
                    {dateTime(review.submittedAt)}
                  </a>
                </li>
              ))}
            </ol>
          </Section>
        )}

        <footer className="border-t border-line px-6 py-4 text-2xs text-fg-subtle">
          <p>
            Tracked because{' '}
            {pr.sources
              .map((source) =>
                source === 'reviewed'
                  ? 'you reviewed it'
                  : source === 'assigned'
                    ? 'you are assigned'
                    : 'your review was requested',
              )
              .join(', ')}
            . Fetched {relativePhrase(pr.fetchedAt)} ({dateTime(pr.fetchedAt)}).
          </p>
        </footer>
      </div>
    </article>
  );
}
