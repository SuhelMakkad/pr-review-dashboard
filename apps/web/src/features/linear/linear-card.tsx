import type React from 'react';
import { Link } from '@tanstack/react-router';
import { ArrowUpRight } from 'lucide-react';
import type { LinearIssue } from '@review-desk/shared/tickets';
import { LinearMark } from '@/ui/brand-icons';
import { Reveal } from '@/ui/motion';
import { useTickets } from '@/features/linear/use-linear';

const stateTone: Record<string, string> = {
  started: 'pending',
  unstarted: 'neutral',
  backlog: 'neutral',
  triage: 'first',
  completed: 'ok',
  canceled: 'fail',
};

function IssueRow({ issue }: { issue: LinearIssue }) {
  return (
    <a
      href={issue.url}
      target="_blank"
      rel="noreferrer"
      className="group flex items-start gap-3 rounded-sm px-2 py-1.5 hover:bg-hover"
    >
      <LinearMark size={14} className="mt-0.5 shrink-0 text-fg-muted" />
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2 text-sm">
          <span className="font-mono text-xs text-fg-muted">{issue.identifier}</span>
          <span className="truncate font-medium text-fg">{issue.title}</span>
          <ArrowUpRight
            size={12}
            className="shrink-0 text-fg-subtle opacity-0 transition-opacity group-hover:opacity-100"
            aria-hidden="true"
          />
        </span>
        <span className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-muted">
          <span
            className="tone rounded-xs px-1.5 font-medium"
            style={
              {
                '--tone': `var(--${stateTone[issue.state.type] ?? 'neutral'})`,
              } as React.CSSProperties
            }
          >
            {issue.state.name}
          </span>
          {issue.priority > 0 && <span>{issue.priorityLabel} priority</span>}
          {issue.assignee && <span>· {issue.assignee}</span>}
          {issue.project && <span>· {issue.project}</span>}
          {issue.dueDate && <span>· due {issue.dueDate}</span>}
        </span>
      </span>
    </a>
  );
}

/** The Linear issues this PR references, or a nudge to connect Linear when it is not set up. */
export function LinearCard({ prId }: { prId: string }) {
  const tickets = useTickets(prId);
  const data = tickets.data;

  return (
    // Appears once tickets load, easing the content below down instead of pushing it.
    <Reveal show={Boolean(data && data.identifiers.length > 0)} className="px-6 pb-4">
      {data && (
        <section aria-label="Linear" className="rounded-md border border-line">
          {data.issues.length > 0 ? (
            <div className="p-1">
              {data.issues.map((issue) => (
                <IssueRow key={issue.identifier} issue={issue} />
              ))}
            </div>
          ) : (
            <p className="flex items-center gap-2 px-3 py-2 text-xs text-fg-muted">
              <LinearMark size={13} />
              <span className="font-mono">{data.identifiers.join(', ')}</span>
              {data.error ? (
                <span className="text-fail">· {data.error}</span>
              ) : (
                <span>
                  ·{' '}
                  <Link
                    to="/settings/$section"
                    params={{ section: 'linear' }}
                    className="text-accent hover:underline"
                  >
                    Connect Linear
                  </Link>{' '}
                  to see status and owner.
                </span>
              )}
            </p>
          )}
        </section>
      )}
    </Reveal>
  );
}
