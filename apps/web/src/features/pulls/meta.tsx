import type { CSSProperties } from 'react';
import {
  AtSign,
  Ban,
  Check,
  CheckCheck,
  AlarmClock,
  CircleDashed,
  CircleDot,
  Clock3,
  GitCommitHorizontal,
  Inbox,
  Layers3,
  LoaderCircle,
  MessageSquare,
  RotateCcw,
  X,
  type LucideIcon,
} from 'lucide-react';
import type {
  AttentionKind,
  AttentionReason,
  CiState,
  PullRequestItem,
  Queue,
  ReviewState,
} from '@review-desk/shared/types';
import { cn } from '../../ui/cn';

export const tone = (variable: string): CSSProperties =>
  ({ '--tone': `var(--${variable})` }) as CSSProperties;

export const reasonMeta: Record<
  AttentionKind | 'mention',
  { label: string; short: string; tone: string; icon: LucideIcon; hint: string }
> = {
  first_review: {
    label: 'First review',
    short: 'New',
    tone: 'first',
    icon: CircleDot,
    hint: 'Your review was requested and you have not reviewed yet.',
  },
  changed: {
    label: 'Changed since review',
    short: 'Changed',
    tone: 'changed',
    icon: GitCommitHorizontal,
    hint: 'The branch head differs from the commit you last reviewed (including rebases and force pushes).',
  },
  requested_again: {
    label: 'Re-requested',
    short: 'Re-requested',
    tone: 'rerequest',
    icon: RotateCcw,
    hint: 'Your review was requested again after your last review.',
  },
  reply: {
    label: 'New reply',
    short: 'Reply',
    tone: 'reply',
    icon: MessageSquare,
    hint: 'Someone replied in a review thread you joined.',
  },
  dismissed: {
    label: 'Review dismissed',
    short: 'Dismissed',
    tone: 'dismissed',
    icon: Ban,
    hint: 'Your latest review was dismissed.',
  },
  mention: {
    label: 'Mentioned',
    short: 'Mention',
    tone: 'mention',
    icon: AtSign,
    hint: 'You were mentioned in the conversation.',
  },
};

/** One chip per reason kind; replies are counted. */
export function ReasonChips({
  reasons,
  compact = false,
}: {
  reasons: AttentionReason[];
  compact?: boolean;
}) {
  const kinds = [...new Set(reasons.map((reason) => reason.kind))];

  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-1">
      {kinds.map((kind) => {
        const meta = reasonMeta[kind];
        const Icon = meta.icon;
        const count = reasons.filter((reason) => reason.kind === kind).length;
        const text = compact ? meta.short : meta.label;

        return (
          <span
            key={kind}
            title={meta.hint}
            style={tone(meta.tone)}
            className="tone inline-flex h-5 items-center gap-1 rounded-xs px-1.5 text-2xs font-medium whitespace-nowrap"
          >
            <Icon size={11} strokeWidth={2.25} aria-hidden="true" />
            {kind === 'reply' && count > 1
              ? `${count} ${compact ? 'replies' : 'new replies'}`
              : text}
          </span>
        );
      })}
    </span>
  );
}

export const ciMeta: Record<CiState, { label: string; tone: string; icon: LucideIcon }> = {
  success: { label: 'Checks passing', tone: 'ok', icon: Check },
  failure: { label: 'Checks failing', tone: 'fail', icon: X },
  pending: { label: 'Checks running', tone: 'pending', icon: LoaderCircle },
  none: { label: 'No checks', tone: 'neutral', icon: CircleDashed },
};

export function CiIndicator({
  state,
  withLabel = false,
  className,
}: {
  state: CiState;
  withLabel?: boolean;
  className?: string;
}) {
  const meta = ciMeta[state];
  const Icon = meta.icon;

  return (
    <span
      className={cn('inline-flex items-center gap-1 text-xs', className)}
      style={{ color: `var(--${meta.tone})` }}
      title={meta.label}
    >
      <Icon size={13} strokeWidth={2.5} aria-hidden="true" />
      {withLabel ? <span>{meta.label}</span> : <span className="sr-only">{meta.label}</span>}
    </span>
  );
}

export const reviewMeta: Record<ReviewState, { label: string; you: string; tone: string }> = {
  APPROVED: { label: 'Approved', you: 'You approved', tone: 'ok' },
  CHANGES_REQUESTED: {
    label: 'Changes requested',
    you: 'You requested changes',
    tone: 'rerequest',
  },
  COMMENTED: { label: 'Commented', you: 'You commented', tone: 'neutral' },
  DISMISSED: { label: 'Dismissed', you: 'Your review was dismissed', tone: 'dismissed' },
};

export function reviewSummary(item: Pick<PullRequestItem, 'latestReview'>): string {
  return item.latestReview ? reviewMeta[item.latestReview.state].you : 'Not reviewed yet';
}

export type QueueSlug = 'attention' | 'waiting' | 'caught-up' | 'snoozed' | 'all';

export const queueMeta: Record<
  QueueSlug,
  { queue: Queue; label: string; icon: LucideIcon; keys: string; empty: string; emptyHint: string }
> = {
  attention: {
    queue: 'attention',
    label: 'Needs attention',
    icon: Inbox,
    keys: 'g i',
    empty: 'Inbox zero',
    emptyHint: 'Nothing needs you right now. New requests, pushes and replies land here.',
  },
  waiting: {
    queue: 'waiting',
    label: 'Waiting on author',
    icon: Clock3,
    keys: 'g w',
    empty: 'Nothing waiting',
    emptyHint: 'PRs where you requested changes appear here until the author responds.',
  },
  'caught-up': {
    queue: 'caught_up',
    label: 'Caught up',
    icon: CheckCheck,
    keys: 'g c',
    empty: 'Nothing here yet',
    emptyHint: 'Reviewed and quiet PRs, plus anything you marked done.',
  },
  snoozed: {
    queue: 'snoozed',
    label: 'Snoozed',
    icon: AlarmClock,
    keys: 'g z',
    empty: 'No snoozed PRs',
    emptyHint: 'Snooze a PR with S. New activity wakes it early.',
  },
  all: {
    queue: 'all',
    label: 'All tracked',
    icon: Layers3,
    keys: 'g a',
    empty: 'No tracked PRs',
    emptyHint: 'PRs requesting your review, assigned to you, or reviewed by you appear here.',
  },
};

export const queueSlugs = Object.keys(queueMeta) as QueueSlug[];

export function inQueue(item: PullRequestItem, slug: QueueSlug): boolean {
  if (slug === 'all') return true;
  if (slug === 'caught-up') return item.queue === 'caught_up' && !item.isDraft;

  return item.queue === queueMeta[slug].queue;
}

export const isFollowUp = (item: PullRequestItem) =>
  item.reasons.some((reason) => reason.kind !== 'first_review');
