import type React from 'react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Check, X } from 'lucide-react';
import type { DraftCommentsResult } from '../../../shared/ai';
import { Button } from '../../ui/button';
import { MarkdownView } from '../../ui/markdown';
import { AiCard, RunButton } from './assist-panel';
import { useAi } from './use-ai';

const severityTone = {
  blocking: 'fail',
  suggestion: 'ai',
  nit: 'neutral',
  question: 'first',
} as const;

/** AI-proposed review comments. Each one is accepted (into your draft) or dismissed individually. */
export function Suggestions({
  prId,
  account,
  onOpenLine,
}: {
  prId: string;
  account: string;
  onOpenLine: (path: string, line: number | null) => void;
}) {
  const ai = useAi(prId, account);
  const run = ai.latest('draft_comments');
  const [handled, setHandled] = useState<Set<string>>(new Set());
  const result = run?.status === 'done' ? (run.result as DraftCommentsResult | null) : null;

  if (!run) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-dashed border-line px-3 py-2">
        <span className="text-xs text-fg-muted">Suggested review comments</span>
        <RunButton
          label="Suggest"
          shortcut="Shift+b"
          running={ai.isStarting('draft_comments')}
          onRun={(provider) => ai.start.mutate({ task: 'draft_comments', provider })}
        />
      </div>
    );
  }

  const open = (result?.comments ?? [])
    .map((comment, index) => ({ comment, index }))
    .filter(({ index }) => !handled.has(`${run.id}:${index}`));

  return (
    <AiCard
      run={run}
      title="Suggested comments"
      starting={ai.isStarting('draft_comments')}
      onCancel={() => ai.cancel.mutate(run.id)}
      onPause={() => ai.pause(run.id)}
      onResume={() => ai.resume(run.id)}
      onRerun={() =>
        ai.start.mutate({ task: 'draft_comments', provider: run.provider, force: true })
      }
    >
      {result && (
        <div className="space-y-2">
          <p className="text-sm">{result.overall}</p>
          {open.length === 0 && <p className="text-xs text-fg-subtle">No suggestions left.</p>}
          {open.map(({ comment, index }) => (
            <div key={index} className="rounded-sm border border-line bg-panel px-2.5 py-2">
              <div className="mb-1 flex items-center gap-2 text-xs">
                <span
                  className="tone rounded-xs px-1 text-2xs font-medium"
                  style={
                    { '--tone': `var(--${severityTone[comment.severity]})` } as React.CSSProperties
                  }
                >
                  {comment.severity}
                </span>
                <button
                  type="button"
                  onClick={() => onOpenLine(comment.path, comment.line)}
                  className="min-w-0 truncate font-mono text-accent hover:underline"
                >
                  {comment.path.split('/').pop()}
                  {comment.line ? `:${comment.line}` : ' (whole file)'}
                </button>
              </div>
              <MarkdownView className="text-xs">{comment.body}</MarkdownView>
              <div className="mt-1.5 flex items-center gap-1">
                <Button
                  size="sm"
                  icon={<Check size={12} />}
                  disabled={ai.accept.isPending}
                  onClick={() =>
                    ai.accept.mutate(
                      { runId: run.id, index },
                      {
                        onSuccess: () => {
                          setHandled(new Set([...handled, `${run.id}:${index}`]));
                          toast('Added to your review', {
                            description: 'Edit it before submitting if you like.',
                          });
                        },
                        onError: (error) => toast.error(error.message),
                      },
                    )
                  }
                >
                  Add to review
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<X size={12} />}
                  onClick={() => setHandled(new Set([...handled, `${run.id}:${index}`]))}
                >
                  Dismiss
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </AiCard>
  );
}
