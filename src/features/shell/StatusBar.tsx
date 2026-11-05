import { useEffect, useState } from 'react';
import { Popover } from 'radix-ui';
import { CircleAlert, RefreshCw } from 'lucide-react';
import { useLive } from '../../lib/live';
import { useStatus, useSyncNow } from '../../lib/queries';
import { dateTime, relativePhrase } from '../../lib/time';
import { cn } from '../../ui/cn';
import { Kbd } from '../../ui/Kbd';

function useTick(ms: number) {
  const [, setTick] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), ms);

    return () => clearInterval(timer);
  }, [ms]);
}

export interface Hint {
  keys: string;
  label: string;
}

export function StatusBar({ hints }: { hints: Hint[] }) {
  const live = useLive();
  const status = useStatus();
  const sync = useSyncNow();
  const state = status.data;
  const coolingDown = Boolean(state?.retryAt && Date.parse(state.retryAt) > Date.now());
  const problems = [...(state?.error ? [state.error] : []), ...(state?.warnings ?? [])];

  useTick(15_000);

  const connection = live.connected
    ? { label: 'Live', tone: 'var(--ok)' }
    : live.disconnectedAt && Date.now() - live.disconnectedAt > 10_000
      ? { label: 'Polling', tone: 'var(--pending)' }
      : { label: 'Connecting', tone: 'var(--pending)' };

  return (
    <footer
      className="col-span-2 flex h-7 items-center gap-3 border-t border-line bg-sunken px-3 text-2xs text-fg-muted"
      aria-label="Status"
    >
      <span
        className="inline-flex items-center gap-1.5"
        title={
          live.connected
            ? 'Receiving live updates'
            : 'Waiting for the live connection; refreshing periodically'
        }
      >
        <span
          className="size-1.5 rounded-full"
          style={{ background: connection.tone }}
          aria-hidden="true"
        />
        {connection.label}
      </span>

      {live.demo && (
        <span
          className="rounded-xs bg-ai/15 px-1.5 font-medium text-ai"
          title="Demo mode uses a fictional scenario; nothing reaches GitHub."
        >
          Demo data
        </span>
      )}

      <span
        data-volatile
        title={state?.lastSuccessfulSync ? dateTime(state.lastSuccessfulSync) : undefined}
      >
        {state?.syncing
          ? 'Syncing with GitHub…'
          : state?.lastSuccessfulSync
            ? `Synced ${relativePhrase(state.lastSuccessfulSync)}`
            : 'Waiting for first sync'}
      </span>

      <button
        type="button"
        className="inline-flex items-center gap-1 rounded-xs px-1 hover:bg-hover hover:text-fg disabled:opacity-50"
        onClick={() => sync.mutate()}
        disabled={state?.syncing || sync.isPending || coolingDown}
        aria-label="Sync now"
        title={
          coolingDown && state?.retryAt
            ? `Rate limited until ${dateTime(state.retryAt)}`
            : 'Sync now'
        }
      >
        <RefreshCw size={11} className={cn(state?.syncing && 'animate-spin')} aria-hidden="true" />
        Sync
      </button>

      {problems.length > 0 && (
        <Popover.Root>
          <Popover.Trigger className="inline-flex items-center gap-1 rounded-xs px-1 font-medium text-pending hover:bg-hover">
            <CircleAlert size={11} aria-hidden="true" />
            {state?.error
              ? 'Showing saved data'
              : `${problems.length} sync ${problems.length === 1 ? 'warning' : 'warnings'}`}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              side="top"
              align="start"
              sideOffset={8}
              className="z-50 w-[420px] rounded-md border border-line bg-elevated p-3 text-xs text-fg shadow-popover"
            >
              <p className="mb-2 font-semibold">
                {state?.error ? 'GitHub could not be reached' : 'Some data could not be refreshed'}
              </p>
              <ul className="max-h-60 space-y-1.5 overflow-auto text-fg-muted">
                {problems.map((problem, index) => (
                  <li key={index} className="break-words">
                    {problem}
                  </li>
                ))}
              </ul>
              {state?.retryAt && (
                <p className="mt-2 text-fg-subtle">Retrying after {dateTime(state.retryAt)}.</p>
              )}
              {state?.error && (
                <p className="mt-2 text-fg-subtle">
                  Check <code>gh auth status</code>; cached PRs stay visible meanwhile.
                </p>
              )}
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}

      <span className="ml-auto truncate">{state?.account?.login}</span>

      <span className="hidden items-center gap-3 lg:inline-flex">
        {hints.map((hint) => (
          <span key={hint.keys} className="inline-flex items-center gap-1">
            <Kbd keys={hint.keys} />
            {hint.label}
          </span>
        ))}
        <span className="inline-flex items-center gap-1">
          <Kbd keys="[Shift]+?" />
          Shortcuts
        </span>
      </span>
    </footer>
  );
}
