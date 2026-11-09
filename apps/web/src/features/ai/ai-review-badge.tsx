import { CircleAlert, LoaderCircle, Sparkles, type LucideIcon } from 'lucide-react';
import type { AiReviewStatus } from '@review-desk/shared/ai';
import { tone } from '@/features/pulls/meta';
import { cn } from '@/ui/cn';

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
    default:
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

  if (!meta) return null;

  const Icon = meta.icon;

  return (
    <span
      title={meta.hint}
      style={tone(meta.tone)}
      className={cn(
        'tone inline-flex h-5 items-center gap-1 rounded-xs px-1.5 text-2xs font-medium whitespace-nowrap',
        className,
      )}
    >
      <Icon
        size={11}
        strokeWidth={2.25}
        aria-hidden="true"
        className={meta.spin ? 'motion-safe:animate-spin' : undefined}
      />
      {meta.label}
    </span>
  );
}
