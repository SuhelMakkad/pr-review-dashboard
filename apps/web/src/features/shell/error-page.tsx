import { useEffect, useState, type ReactNode } from 'react';
import { Link, useRouterState, type ErrorComponentProps } from '@tanstack/react-router';
import { Check, ChevronRight, CircleAlert, Copy, Inbox, RefreshCw, RotateCcw } from 'lucide-react';
import { tone } from '@/features/pulls/meta';
import { Button, buttonClass } from '@/ui/button';
import { cn } from '@/ui/cn';
import { EmptyState } from '@/ui/empty-state';
import { Enter, MotionProvider, Reveal, StaggerItem } from '@/ui/motion';

/** How long "Copied" stays next to the copy button, in milliseconds. */
const copiedMs = 2000;

/**
 * What browsers say when a lazily loaded chunk fails. TanStack already reloads once for these, so
 * one that reaches this page needs a fresh reload rather than another render.
 */
const chunkFailures = [
  'Failed to fetch dynamically imported module',
  'error loading dynamically imported module',
  'Importing a module script failed',
];

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isChunkLoadError(error: Error) {
  return chunkFailures.some((prefix) => error.message.startsWith(prefix));
}

/** The error's name and message, then its stack without repeating them. */
function describeError(error: Error) {
  const header = `${error.name}: ${error.message}`;
  const frames = error.stack?.replace(header, '').trim();

  return frames ? `${header}\n${frames}` : header;
}

/**
 * Shown in place of a page, or a pane within one, that crashed while rendering. The sidebar and
 * status bar stay, so the rest of the app is one click away; leaving clears the error. A retry
 * that crashes again remounts this page (React rebuilds a boundary's fallback for each error), so
 * the panel enters anew and shows the retry ran.
 */
export function RouteError({ error, reset }: ErrorComponentProps) {
  const failure = asError(error);

  if (isChunkLoadError(failure)) {
    return (
      <ErrorLayout>
        <ErrorPanel
          error={failure}
          title="Couldn't load this page"
          hint="Part of Review Desk failed to load, usually because it was rebuilt or restarted while this window was open. Reloading picks up the latest version."
          actions={
            <>
              <ReloadButton label="Reload" />
              <InboxLink />
            </>
          }
        />
      </ErrorLayout>
    );
  }

  return (
    <ErrorLayout>
      <ErrorPanel
        error={failure}
        title="Something went wrong on this page"
        hint="Review Desk hit an unexpected error while showing it. Try again, or head back to your inbox."
        actions={
          <>
            <Button
              variant="primary"
              icon={<RotateCcw size={14} aria-hidden="true" />}
              onClick={reset}
            >
              Try again
            </Button>
            <InboxLink />
          </>
        }
      />
    </ErrorLayout>
  );
}

/**
 * Shown when the app frame itself crashed. It fills the window and brings its own motion features,
 * since the frame that provided them is gone.
 */
export function AppError({ error, reset }: ErrorComponentProps) {
  return (
    <MotionProvider>
      <ErrorLayout className="bg-panel p-4">
        <ErrorPanel
          error={asError(error)}
          title="Review Desk ran into a problem"
          hint="Something broke while drawing the app. Reloading usually fixes it."
          actions={
            <>
              <ReloadButton label="Reload Review Desk" />
              <Button icon={<RotateCcw size={14} aria-hidden="true" />} onClick={reset}>
                Try again
              </Button>
            </>
          }
        />
      </ErrorLayout>
    </MotionProvider>
  );
}

/** Centres the panel and scrolls on its own, since the page body never scrolls. */
function ErrorLayout({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cn('scroll-thin grid h-full place-items-center overflow-y-auto', className)}>
      {children}
    </div>
  );
}

/**
 * Rises in, then its parts follow one after another. Only the summary and actions are the alert;
 * the details sit outside it, so opening them never reads a stack trace aloud.
 */
function ErrorPanel({
  error,
  title,
  hint,
  actions,
}: {
  error: Error;
  title: string;
  hint: string;
  actions: ReactNode;
}) {
  return (
    <Enter preset="rise" className="flex w-full max-w-md flex-col items-center">
      <div role="alert">
        <EmptyState
          stagger
          icon={
            <span
              className="tone grid size-12 place-items-center rounded-full"
              style={tone('fail')}
            >
              <CircleAlert size={24} aria-hidden="true" />
            </span>
          }
          title={title}
          hint={hint}
          action={<div className="flex flex-wrap justify-center gap-2">{actions}</div>}
        />
      </div>
      <StaggerItem index={4} className="-mt-6 w-full px-6 pb-10">
        <ErrorDetails error={error} />
      </StaggerItem>
    </Enter>
  );
}

/** The error itself, folded away until asked for, and a way to copy it into a bug report. */
function ErrorDetails({ error }: { error: Error }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const text = describeError(error);

  useEffect(() => {
    if (!copied) return;

    const timer = setTimeout(() => setCopied(false), copiedMs);

    return () => clearTimeout(timer);
  }, [copied]);

  const copy = () => {
    const report = [text, `Page: ${pathname}`, `Time: ${new Date().toISOString()}`].join('\n\n');

    void navigator.clipboard
      .writeText(report)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <div className="flex flex-col items-center">
      <div className="flex items-center gap-1 text-xs">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          aria-expanded={open}
          className="inline-flex h-7 items-center gap-1 rounded-sm px-2 text-fg-muted transition-colors hover:bg-hover hover:text-fg"
        >
          <ChevronRight
            size={12}
            aria-hidden="true"
            className={cn('transition-transform', open && 'rotate-90')}
          />
          Technical details
        </button>
        {/* "Copied" floats beside the button, so the row never shifts when it comes and goes. */}
        <span className="relative inline-flex">
          <Button
            size="sm"
            variant="ghost"
            icon={<Copy size={12} aria-hidden="true" />}
            onClick={copy}
          >
            Copy details
          </Button>
          <span role="status" className="absolute top-1/2 left-full ml-1 -translate-y-1/2">
            <Reveal show={copied} preset="pop" as="span">
              <span className="inline-flex items-center gap-1 whitespace-nowrap text-ok">
                <Check size={12} aria-hidden="true" />
                Copied
              </span>
            </Reveal>
          </span>
        </span>
      </div>
      <Reveal show={open} className="w-full">
        {/* Focusable, so a keyboard can scroll a long stack; volatile, since the stack names
            build-specific files and screenshots mask it. */}
        <pre
          tabIndex={0}
          aria-label="Error details"
          data-volatile
          className="scroll-thin mt-2 max-h-48 overflow-auto rounded-sm border border-line bg-sunken p-3 text-left text-2xs text-fg-muted"
        >
          {text}
        </pre>
      </Reveal>
    </div>
  );
}

/** Reloads the window; it spins and stays disabled while the new page loads. */
function ReloadButton({ label }: { label: string }) {
  const [reloading, setReloading] = useState(false);

  return (
    <Button
      variant="primary"
      disabled={reloading}
      icon={<RefreshCw size={14} aria-hidden="true" className={cn(reloading && 'animate-spin')} />}
      onClick={() => {
        setReloading(true);
        window.location.reload();
      }}
    >
      {reloading ? 'Reloading…' : label}
    </Button>
  );
}

function InboxLink() {
  return (
    <Link
      to="/inbox/$queue"
      params={{ queue: 'attention' }}
      className={buttonClass({ variant: 'secondary' })}
    >
      <Inbox size={14} aria-hidden="true" />
      Go to your inbox
    </Link>
  );
}
