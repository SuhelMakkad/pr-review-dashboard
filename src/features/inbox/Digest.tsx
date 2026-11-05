import type { AttentionKind, PullRequestItem } from '../../../shared/types';
import { reasonMeta } from '../pulls/meta';
import type { InboxSearch } from './filters';

const DAY = 24 * 60 * 60_000;
const order: AttentionKind[] = ['first_review', 'changed', 'requested_again', 'reply', 'dismissed'];
const phrases: Record<AttentionKind, (count: number) => string> = {
  first_review: (count) => `${count} new ${count === 1 ? 'request' : 'requests'}`,
  changed: (count) => `${count} pushed`,
  requested_again: (count) => `${count} re-requested`,
  reply: (count) => `${count} ${count === 1 ? 'reply' : 'replies'}`,
  dismissed: (count) => `${count} dismissed`,
};

/** One line summarising what arrived in the last 24 hours; each part filters the queue. */
export function Digest({
  items,
  onFilter,
  now = Date.now(),
}: {
  items: PullRequestItem[];
  onFilter: (next: Partial<InboxSearch>) => void;
  now?: number;
}) {
  const recent = items.flatMap((item) =>
    item.reasons.filter((reason) => now - Date.parse(reason.at) < DAY),
  );
  const counts = order
    .map((kind) => ({ kind, count: recent.filter((reason) => reason.kind === kind).length }))
    .filter((entry) => entry.count > 0);

  if (counts.length === 0) return null;

  return (
    <p className="flex items-center gap-1.5 border-b border-line px-4 py-1.5 text-xs text-fg-muted">
      <span className="text-fg-subtle">Last 24 hours:</span>
      {counts.map((entry, index) => (
        <span key={entry.kind} className="inline-flex items-center gap-1.5">
          {index > 0 && <span className="text-fg-subtle">·</span>}
          <button
            type="button"
            className="rounded-xs hover:text-fg hover:underline"
            style={{ color: `var(--${reasonMeta[entry.kind].tone})` }}
            onClick={() => onFilter({ reason: entry.kind })}
          >
            {phrases[entry.kind](entry.count)}
          </button>
        </span>
      ))}
    </p>
  );
}
