import type React from 'react';
import type { ReactNode } from 'react';
import { DropdownMenu } from 'radix-ui';
import {
  AlertTriangle,
  ChevronDown,
  CircleCheck,
  CircleDashed,
  CircleHelp,
  CircleMinus,
  LoaderCircle,
  RefreshCw,
  Sparkles,
  X,
} from 'lucide-react';
import {
  aiTaskLabels,
  type AiProvider,
  type AiRun,
  type AiTask,
  type AuthorFeedbackResult,
  type BriefResult,
  type SinceReviewResult,
} from '../../../shared/ai';
import { useShortcuts } from '../../lib/shortcuts';
import { relativePhrase } from '../../lib/time';
import { Button } from '../../ui/Button';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/Kbd';
import { useAi, useAiOverview } from './useAi';

const providerLabel: Record<AiProvider, string> = { codex: 'Codex', claude: 'Claude' };

const verdictMeta = {
  addressed: { icon: CircleCheck, tone: 'ok', label: 'Addressed' },
  partially: { icon: CircleMinus, tone: 'pending', label: 'Partly' },
  not_addressed: { icon: AlertTriangle, tone: 'fail', label: 'Not addressed' },
  unclear: { icon: CircleHelp, tone: 'neutral', label: 'Unclear' },
} as const;

/** Run button with a provider menu; Codex is the default unless settings say otherwise. */
export function RunButton({
  label,
  shortcut,
  running,
  onRun,
}: {
  label: string;
  shortcut?: string;
  running: boolean;
  onRun: (provider?: AiProvider) => void;
}) {
  const overview = useAiOverview();
  const providers = overview.data?.providers ?? [];
  const fallback = overview.data?.settings.defaultProvider ?? 'codex';

  return (
    <span className="inline-flex">
      <Button
        size="sm"
        className="rounded-r-none border-ai/40 text-ai"
        icon={
          running ? <LoaderCircle size={12} className="animate-spin" /> : <Sparkles size={12} />
        }
        disabled={running}
        onClick={() => onRun()}
        shortcut={shortcut}
      >
        {label}
      </Button>
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            aria-label="Choose the AI agent"
            disabled={running}
            className="inline-flex h-7 items-center rounded-r-sm border border-l-0 border-ai/40 px-1 text-ai hover:bg-hover disabled:opacity-50"
          >
            <ChevronDown size={12} />
          </button>
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            className="z-50 min-w-[200px] rounded-md border border-line bg-elevated p-1 text-sm shadow-popover"
          >
            {providers.map((provider) => (
              <DropdownMenu.Item
                key={provider.id}
                disabled={!provider.available}
                onSelect={() => onRun(provider.id)}
                className="flex h-8 cursor-default items-center gap-2 rounded-sm px-2 outline-none data-[disabled]:opacity-50 data-[highlighted]:bg-selected"
              >
                <span className="flex-1">
                  Run with {provider.label}
                  {provider.id === fallback && <span className="text-fg-subtle"> · default</span>}
                </span>
                <span className="text-2xs text-fg-subtle">
                  {provider.available ? (provider.version ?? '') : 'not installed'}
                </span>
              </DropdownMenu.Item>
            ))}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </span>
  );
}

/** Shell for one AI result: who produced it, for which commit, and its state. */
export function AiCard({
  run,
  title,
  onCancel,
  onRerun,
  children,
}: {
  run: AiRun;
  title: string;
  onCancel: () => void;
  onRerun: () => void;
  children?: ReactNode;
}) {
  const busy = run.status === 'queued' || run.status === 'running';

  return (
    <div className="rounded-md border border-dashed border-ai/50 bg-ai/[0.03] px-3 py-2.5">
      <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <Sparkles size={12} className="shrink-0 text-ai" aria-hidden="true" />
        <span className="shrink-0 font-medium text-ai">{title}</span>
        <span className="order-1 w-full text-fg-subtle">
          {providerLabel[run.provider]} · {run.headOid.slice(0, 7)}
          {run.finishedAt && ` · ${relativePhrase(run.finishedAt)}`}
        </span>
        {run.stale && (
          <span
            className="rounded-xs bg-pending/15 px-1 text-2xs font-medium text-pending"
            title="New commits arrived after this was written"
          >
            Out of date
          </span>
        )}
        <span className="ml-auto flex items-center gap-1">
          {busy ? (
            <Button
              size="sm"
              variant="ghost"
              icon={<X size={12} />}
              onClick={onCancel}
              shortcut="$mod+."
            >
              Stop
            </Button>
          ) : (
            <Button size="sm" variant="ghost" icon={<RefreshCw size={12} />} onClick={onRerun}>
              {run.stale ? 'Regenerate' : 'Run again'}
            </Button>
          )}
        </span>
      </div>
      {busy ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted" aria-live="polite">
          <LoaderCircle size={13} className="animate-spin text-ai" aria-hidden="true" />
          {run.progress ?? 'Working…'}
        </p>
      ) : run.status === 'failed' ? (
        <p className="text-sm text-fail" role="alert">
          {run.error ?? 'The agent failed.'}
        </p>
      ) : run.status === 'cancelled' || run.status === 'interrupted' ? (
        <p className="flex items-center gap-2 text-sm text-fg-muted">
          <CircleDashed size={13} aria-hidden="true" />
          {run.status === 'cancelled' ? 'Stopped.' : 'Interrupted by a restart.'}
        </p>
      ) : (
        children
      )}
      <p className="mt-2 text-2xs text-fg-subtle">
        AI-generated; check it against the code before relying on it.
      </p>
    </div>
  );
}

export function BriefView({
  result,
  onOpenFile,
}: {
  result: BriefResult;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p>{result.summary}</p>
      <p className="flex flex-wrap items-center gap-1.5 text-xs">
        <span
          className="tone rounded-xs px-1.5 py-0.5 font-medium"
          style={
            {
              '--tone': `var(--${result.risk === 'high' ? 'fail' : result.risk === 'medium' ? 'pending' : 'ok'})`,
            } as React.CSSProperties
          }
        >
          {result.risk} risk
        </span>
        {result.riskReasons.map((reason) => (
          <span key={reason} className="text-fg-muted">
            · {reason}
          </span>
        ))}
      </p>
      {result.focusFiles.length > 0 && (
        <div>
          <h4 className="mb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
            Look closely at
          </h4>
          <ul className="space-y-0.5">
            {result.focusFiles.map((file) => (
              <li key={file.path} className="text-xs">
                <button
                  type="button"
                  disabled={!onOpenFile}
                  onClick={() => onOpenFile?.(file.path)}
                  className="font-mono text-accent hover:underline disabled:text-fg disabled:no-underline"
                >
                  {file.path}
                </button>
                <span className="text-fg-muted"> — {file.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {result.questions.length > 0 && (
        <div>
          <h4 className="mb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
            Questions for the author
          </h4>
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {result.questions.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function SinceReviewView({
  result,
  threadLabel,
  onOpenThread,
}: {
  result: SinceReviewResult;
  threadLabel: (id: string) => string;
  onOpenThread?: (id: string) => void;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p>{result.summary}</p>
      {result.threads.length > 0 && (
        <ul className="space-y-1">
          {result.threads.map((thread) => {
            const meta = verdictMeta[thread.verdict];
            const Icon = meta.icon;

            return (
              <li key={thread.threadId} className="flex items-start gap-2 text-xs">
                <Icon
                  size={13}
                  className="mt-px shrink-0"
                  style={{ color: `var(--${meta.tone})` }}
                  aria-hidden="true"
                />
                <span>
                  <button
                    type="button"
                    disabled={!onOpenThread}
                    onClick={() => onOpenThread?.(thread.threadId)}
                    className="font-mono text-accent hover:underline disabled:text-fg disabled:no-underline"
                  >
                    {threadLabel(thread.threadId)}
                  </button>{' '}
                  <span className="font-medium">{meta.label}.</span>{' '}
                  <span className="text-fg-muted">{thread.explanation}</span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {result.newConcerns.length > 0 && (
        <div>
          <h4 className="mb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
            New concerns
          </h4>
          <ul className="list-disc space-y-0.5 pl-4 text-xs">
            {result.newConcerns.map((concern) => (
              <li key={concern}>{concern}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function FeedbackView({
  result,
  threadLabel,
}: {
  result: AuthorFeedbackResult;
  threadLabel: (id: string) => string;
}) {
  return (
    <div className="space-y-2 text-sm">
      <p>{result.summary}</p>
      <ul className="space-y-1">
        {result.actionItems.map((item, index) => (
          <li key={index} className="flex items-start gap-2 text-xs">
            <CircleDashed size={12} className="mt-px shrink-0 text-ai" aria-hidden="true" />
            <span>
              {item.text}
              {item.threadId && (
                <span className="font-mono text-fg-subtle"> ({threadLabel(item.threadId)})</span>
              )}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The assist section for a PR: a brief for everyone, "since your review" when you reviewed an
 * earlier version, and a feedback summary on your own PRs.
 */
export function AssistPanel({
  prId,
  account,
  tasks,
  threadLabel,
  onOpenFile,
  onOpenThread,
  compact = false,
  bindShortcuts = true,
}: {
  prId: string;
  account: string;
  tasks: AiTask[];
  threadLabel: (id: string) => string;
  onOpenFile?: (path: string) => void;
  onOpenThread?: (id: string) => void;
  compact?: boolean;
  /** The workspace binds its own AI shortcuts. */
  bindShortcuts?: boolean;
}) {
  const ai = useAi(prId, account);

  useShortcuts(
    [
      {
        keys: 'b',
        label: 'Run the AI brief',
        group: 'Pull request',
        run: () => {
          const brief = ai.latest('brief');

          if (!brief || (brief.status !== 'queued' && brief.status !== 'running')) {
            ai.start.mutate({ task: 'brief', force: Boolean(brief) });
          }
        },
      },
    ],
    bindShortcuts && tasks.includes('brief'),
  );

  return (
    <div className={cn('space-y-3', compact && 'text-xs')}>
      {tasks.map((task) => {
        const run = ai.latest(task);
        const running = Boolean(run && (run.status === 'queued' || run.status === 'running'));
        const launch = (provider?: AiProvider, force?: boolean) =>
          ai.start.mutate({ task, provider, force });

        if (!run) {
          return (
            <div
              key={task}
              className="flex items-center justify-between gap-3 rounded-md border border-dashed border-line px-3 py-2"
            >
              <span className="text-xs text-fg-muted">{aiTaskLabels[task]}</span>
              <RunButton
                label="Run"
                shortcut={task === 'brief' ? 'b' : undefined}
                running={ai.start.isPending}
                onRun={(provider) => launch(provider)}
              />
            </div>
          );
        }

        return (
          <AiCard
            key={task}
            run={run}
            title={aiTaskLabels[task]}
            onCancel={() => ai.cancel.mutate(run.id)}
            onRerun={() => launch(run.provider, true)}
          >
            {task === 'brief' && run.result && (
              <BriefView result={run.result as BriefResult} onOpenFile={onOpenFile} />
            )}
            {task === 'since_review' && run.result && (
              <SinceReviewView
                result={run.result as SinceReviewResult}
                threadLabel={threadLabel}
                onOpenThread={onOpenThread}
              />
            )}
            {task === 'author_feedback' && run.result && (
              <FeedbackView result={run.result as AuthorFeedbackResult} threadLabel={threadLabel} />
            )}
            {running && null}
          </AiCard>
        );
      })}
      {ai.start.error && (
        <p className="text-xs text-fail" role="alert">
          {ai.start.error.message}
        </p>
      )}
      <p className="flex items-center gap-1 text-2xs text-fg-subtle">
        Runs on your machine through the agent CLI; the PR content is sent to that agent’s service.{' '}
        <Kbd keys="b" /> runs the brief.
      </p>
    </div>
  );
}
