import { CircleAlert, LoaderCircle, RefreshCw, Sparkles, type LucideIcon } from 'lucide-react';
import type { AiReviewStatus } from '@review-desk/shared/ai';
import { restartCopy } from '@/features/ai/restart';
import { tone } from '@/features/pulls/meta';
import { Reveal } from '@/ui/motion';

interface BadgeMeta {
  label: string;
  hint: string;
  tone: string;
  icon: LucideIcon;
  spin?: boolean;
}

function badgeFor(review: AiReviewStatus): BadgeMeta | null {
  const started =
    review.trigger === 'auto' ? 'Started automatically when your review was requested. ' : '';

  if (review.restartAt && review.status !== 'queued' && review.status !== 'running')
    return {
      label: 'AI review restarting',
      hint: restartCopy(review.restartAt),
      tone: 'ai',
      icon: RefreshCw,
    };

  switch (review.status) {
    case 'queued':
    case 'running':
      return {
        label: 'AI reviewing',
        hint: `${started}A full review is in progress.`,
        tone: 'ai',
        icon: LoaderCircle,
        spin: true,
      };
    case 'done':
      return review.stale
        ? {
            label: 'AI review out of date',
            hint: 'The PR changed after the full review. Open it to run a new one.',
            tone: 'fg-subtle',
            icon: Sparkles,
          }
        : {
            label: 'AI review ready',
            hint: `${started}Look over the findings before preparing a GitHub review.`,
            tone: 'ai',
            icon: Sparkles,
          };
    case 'failed':
      return {
        label: 'AI review failed',
        hint: 'Open the PR to run the full review again.',
        tone: 'fail',
        icon: CircleAlert,
      };
    // Stopped, interrupted or paused, or never run: nothing to show on the row.
    case 'cancelled':
    case 'interrupted':
    case 'paused':
    case null:
      return null;
  }
}

/** The state of a PR's latest full review, for list rows. Nothing when there is none to show. */
export function AiReviewBadge({
  review,
  className,
}: {
  review: AiReviewStatus | undefined;
  className?: string;
}) {
  const meta = review ? badgeFor(review) : null;
  const Icon = meta?.icon;

  return (
    <Reveal show={Boolean(meta)} preset="pop" as="span" className={className}>
      {meta && Icon && (
        <span
          title={meta.hint}
          style={tone(meta.tone)}
          className="tone inline-flex h-5 items-center gap-1 rounded-xs px-1.5 text-2xs font-medium whitespace-nowrap"
        >
          <Icon
            size={11}
            strokeWidth={2.25}
            aria-hidden="true"
            className={meta.spin ? 'motion-safe:animate-spin' : undefined}
          />
          {meta.label}
        </span>
      )}
    </Reveal>
  );
}
