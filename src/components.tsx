import { Check, Circle, CircleAlert, Clock3, MessageSquare, RotateCcw } from 'lucide-react';
import type { AttentionReason, CiState } from '../shared/types';

export function CiBadge({ state, iconOnly = false }: { state: CiState; iconOnly?: boolean }) {
  const labels: Record<CiState, string> = {
    success: 'Passing',
    failure: 'Failing',
    pending: 'Running',
    none: 'No checks',
  };
  const Icon =
    state === 'success'
      ? Check
      : state === 'failure'
        ? CircleAlert
        : state === 'pending'
          ? Clock3
          : Circle;

  return (
    <span
      className={`ci-badge ci-${state}`}
      title={labels[state]}
      aria-label={`CI: ${labels[state]}`}
    >
      <Icon size={14} />
      {!iconOnly && <span>{labels[state]}</span>}
    </span>
  );
}

export function ReasonBadges({ reasons }: { reasons: AttentionReason[] }) {
  const unique = reasons.filter(
    (reason, index) => reasons.findIndex((other) => other.kind === reason.kind) === index,
  );

  return (
    <div className="reason-badges">
      {unique.map((reason) => {
        const Icon =
          reason.kind === 'reply'
            ? MessageSquare
            : reason.kind === 'first_review'
              ? Circle
              : RotateCcw;
        const replies = reasons.filter((item) => item.kind === 'reply').length;

        return (
          <span
            key={reason.kind}
            className={`reason reason-${reason.kind}`}
            title={
              reason.kind === 'changed'
                ? 'The branch head SHA differs from your latest submitted review.'
                : reason.label
            }
          >
            <Icon size={11} />
            {reason.kind === 'reply' && replies > 1 ? `${replies} new replies` : reason.label}
          </span>
        );
      })}
    </div>
  );
}
