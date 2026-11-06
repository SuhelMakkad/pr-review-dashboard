import type { ReactNode } from 'react';
import { ToggleGroup } from 'radix-ui';
import { appearance, useAppearance, type Density, type ThemePreference } from '@/lib/theme';
import { useLive } from '@/lib/live';
import { useStatus } from '@/lib/queries';
import { dateTime, shortDateTime } from '@/lib/time';
import { cn } from '@/ui/cn';
import {
  aiTaskLabels,
  type AiEffort,
  type AiProvider,
  type AiTask,
  type CodexAccountStatus,
} from '@review-desk/shared/ai';
import { useAiOverview, useAiSettings } from '@/features/ai/use-ai';
import { useLinearStatus } from '@/features/linear/use-linear';
import type { LinearStatus } from '@review-desk/shared/tickets';
import { Button } from '@/ui/button';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { notificationsSupported } from '@/lib/notifications';
import { useNotificationSettings } from '@/lib/queries';
import {
  notificationKindLabels,
  type NotificationKind,
  type NotificationSettings,
} from '@review-desk/shared/notify';
import { toast } from 'sonner';

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-6 border-b border-line py-4">
      <div>
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="text-xs text-fg-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      value={value}
      onValueChange={(next) => next && onChange(next as T)}
      aria-label={label}
      className="inline-flex rounded-sm border border-line bg-sunken p-0.5"
    >
      {options.map((option) => (
        <ToggleGroup.Item
          key={option.value}
          value={option.value}
          className={cn(
            'h-7 rounded-xs px-3 text-xs text-fg-muted',
            'data-[state=on]:bg-panel data-[state=on]:font-medium data-[state=on]:text-fg data-[state=on]:shadow-sm',
          )}
        >
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function SettingsPage() {
  const { theme, density } = useAppearance();
  const status = useStatus();
  const live = useLive();
  const state = status.data;

  return (
    <div className="scroll-thin h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl px-6 py-8">
        <h1 className="mb-6 text-xl font-semibold">Settings</h1>

        <h2 className="text-xs font-semibold tracking-wide text-fg-subtle uppercase">Appearance</h2>
        <Row label="Theme" hint="System follows your macOS appearance.">
          <Segmented<ThemePreference>
            label="Theme"
            value={theme}
            onChange={appearance.setTheme}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
              { value: 'dark', label: 'Dark' },
            ]}
          />
        </Row>
        <Row label="Row density" hint="Compact shows one line per PR.">
          <Segmented<Density>
            label="Row density"
            value={density}
            onChange={appearance.setDensity}
            options={[
              { value: 'comfortable', label: 'Comfortable' },
              { value: 'compact', label: 'Compact' },
            ]}
          />
        </Row>

        <h2 className="mt-8 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
          GitHub
        </h2>
        <Row label="Account" hint="Switch with `gh auth switch`; each account keeps separate data.">
          <span className="text-sm">{state?.account?.login ?? '—'}</span>
        </Row>
        <Row label="Teams" hint="Team review requests are matched against these.">
          <span className="max-w-xs truncate text-right text-sm text-fg-muted">
            {state?.teams.join(', ') || 'None'}
          </span>
        </Row>
        <Row label="Last successful sync">
          <span className="text-sm text-fg-muted">
            {state?.lastSuccessfulSync ? dateTime(state.lastSuccessfulSync) : 'Not yet'}
          </span>
        </Row>

        <NotificationsSection account={state?.account?.login ?? ''} />

        <AiSection account={state?.account?.login ?? ''} />

        <LinearSection />

        <h2 className="mt-8 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
          Data and privacy
        </h2>
        <p className="py-4 text-sm leading-relaxed text-fg-muted">
          Cached GitHub data, notes, snoozes and acknowledgements live in{' '}
          <code>.data/review-desk.sqlite</code> on this machine. The server only listens on
          127.0.0.1, every write needs this window's session token, and GitHub credentials stay
          inside the GitHub CLI.
          {live.demo && ' This window is running in demo mode with a fictional scenario.'}
        </p>
      </div>
    </div>
  );
}

const efforts: AiEffort[] = ['low', 'medium', 'high', 'xhigh'];

/** Which ChatGPT plan Codex bills, how much of it is used, and why runs may be paused. */
function CodexPlan({ status }: { status: CodexAccountStatus }) {
  return (
    <div className="max-w-xs text-right text-xs">
      {status.plan && <div className="text-fg">{status.plan}</div>}
      {status.windows.map((window) => (
        <div
          key={window.label}
          className={window.usedPercent >= 100 ? 'text-fail' : 'text-fg-muted'}
        >
          {window.label}: {window.usedPercent}% used
          {window.resetsAt && ` · resets ${shortDateTime(window.resetsAt)}`}
        </div>
      ))}
      {status.problem && (
        <div className="text-fail" role="alert">
          {status.problem}
        </div>
      )}
    </div>
  );
}

/** Codex models this ChatGPT account offers; shown only for tasks Codex runs. */
function CodexModelSelect({
  task,
  status,
  agent,
  value,
  onChange,
}: {
  task: AiTask;
  status: CodexAccountStatus | null;
  agent: AiProvider;
  value: string | null;
  onChange: (model: string | null) => void;
}) {
  if (agent !== 'codex' || !status || status.models.length === 0) return null;

  const fallback = status.models.find((model) => model.isDefault);
  const known = value === null || status.models.some((model) => model.id === value);

  return (
    <select
      aria-label={`${aiTaskLabels[task]} model`}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className="h-7 max-w-44 rounded-sm border border-line bg-sunken px-2 text-xs"
    >
      <option value="">{fallback ? `${fallback.displayName} (default)` : 'Default model'}</option>
      {status.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.displayName}
        </option>
      ))}
      {!known && <option value={value!}>{value} (not offered; uses the default)</option>}
    </select>
  );
}

function AiSection({ account }: { account: string }) {
  const overview = useAiOverview();
  const save = useAiSettings(account);
  const settings = overview.data?.settings;
  const providers = overview.data?.providers ?? [];
  const codex = overview.data?.codex ?? null;

  if (!settings) return null;

  const update = (next: typeof settings) => save.mutate(next);

  return (
    <>
      <h2 className="mt-8 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        AI assist
      </h2>
      <Row label="Default agent" hint="Used for every task unless a task says otherwise.">
        <Segmented<AiProvider>
          label="Default agent"
          value={settings.defaultProvider}
          onChange={(defaultProvider) => update({ ...settings, defaultProvider })}
          options={[
            { value: 'codex', label: 'Codex' },
            { value: 'claude', label: 'Claude Code' },
          ]}
        />
      </Row>
      <Row
        label="Installed agents"
        hint="Runs locally through each CLI's own login; no API keys are stored here."
      >
        <ul className="text-right text-xs">
          {providers.map((provider) => (
            <li key={provider.id} className={provider.available ? 'text-fg' : 'text-fail'}>
              {provider.label}:{' '}
              {provider.available
                ? (provider.version ?? 'available')
                : (provider.reason ?? 'unavailable')}
            </li>
          ))}
        </ul>
      </Row>
      {codex && (
        <Row
          label="Codex plan"
          hint="Codex uses your ChatGPT plan. Runs pause when the plan's limit is reached, so they never fall back to credits."
        >
          <CodexPlan status={codex} />
        </Row>
      )}
      {(Object.keys(settings.tasks) as AiTask[]).map((task) => (
        <Row
          key={task}
          label={aiTaskLabels[task]}
          hint="Higher effort and larger models use more of your plan."
        >
          <span className="flex items-center gap-2">
            <select
              aria-label={`${aiTaskLabels[task]} agent`}
              disabled={task === 'full_review'}
              value={settings.tasks[task].provider ?? ''}
              onChange={(event) =>
                update({
                  ...settings,
                  tasks: {
                    ...settings.tasks,
                    [task]: {
                      ...settings.tasks[task],
                      provider: (event.target.value || null) as AiProvider | null,
                      // Model ids belong to one agent.
                      model: null,
                    },
                  },
                })
              }
              className="h-7 rounded-sm border border-line bg-sunken px-2 text-xs"
            >
              <option value="">Default agent</option>
              <option value="codex">Codex</option>
              <option value="claude">Claude Code</option>
            </select>
            <CodexModelSelect
              task={task}
              status={codex}
              agent={
                task === 'full_review'
                  ? 'codex'
                  : (settings.tasks[task].provider ?? settings.defaultProvider)
              }
              value={settings.tasks[task].model}
              onChange={(model) =>
                update({
                  ...settings,
                  tasks: { ...settings.tasks, [task]: { ...settings.tasks[task], model } },
                })
              }
            />
            <select
              aria-label={`${aiTaskLabels[task]} effort`}
              value={settings.tasks[task].effort}
              onChange={(event) =>
                update({
                  ...settings,
                  tasks: {
                    ...settings.tasks,
                    [task]: { ...settings.tasks[task], effort: event.target.value as AiEffort },
                  },
                })
              }
              className="h-7 rounded-sm border border-line bg-sunken px-2 text-xs"
            >
              {efforts.map((effort) => (
                <option key={effort} value={effort}>
                  {effort} effort
                </option>
              ))}
            </select>
          </span>
        </Row>
      ))}
    </>
  );
}

function LinearSection() {
  const status = useLinearStatus();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const search = useSearch({ strict: false }) as { linear?: string };
  const data = status.data;

  const connect = useMutation({
    mutationFn: () => api<{ url: string }>('/api/linear/connect', { method: 'POST' }),
    // Linear's sign-in page sends the browser back to Settings when it is done.
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error) => toast.error(error.message),
  });
  const disconnect = useMutation({
    mutationFn: () => api<LinearStatus>('/api/linear/disconnect', { method: 'POST' }),
    onSuccess: (next) => {
      queryClient.setQueryData(['linear-status'], next);
      void queryClient.invalidateQueries({ queryKey: ['tickets'] });
      toast('Disconnected from Linear');
    },
    onError: (error) => toast.error(error.message),
  });

  useEffect(() => {
    if (search.linear !== 'connected' && search.linear !== 'failed') return;

    if (search.linear === 'connected') toast.success('Linear connected');
    else toast.error('Linear sign-in did not finish');

    void queryClient.invalidateQueries({ queryKey: ['linear-status'] });
    void queryClient.invalidateQueries({ queryKey: ['tickets'] });
    void navigate({ to: '/settings', search: {}, replace: true });
  }, [search.linear, navigate, queryClient]);

  if (!data) return null;

  const via = data.method === 'oauth' ? 'your Linear sign-in' : 'a personal API key';

  return (
    <section aria-labelledby="settings-linear">
      <h2
        id="settings-linear"
        className="mt-8 text-xs font-semibold tracking-wide text-fg-subtle uppercase"
      >
        Linear
      </h2>
      <Row
        label="Connection"
        hint={
          data.connected
            ? `Connected to ${data.workspace} with ${via}. Teams: ${data.teamKeys.join(', ')}.`
            : 'Shows the status, owner and priority of tickets your PRs reference.'
        }
      >
        {data.connected ? (
          <span className="flex items-center gap-3">
            <span className="text-sm text-ok">Connected</span>
            {data.method === 'oauth' && data.canSignIn && (
              <Button size="sm" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                Disconnect
              </Button>
            )}
          </span>
        ) : data.canSignIn ? (
          <Button
            variant="primary"
            size="sm"
            disabled={connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? 'Opening Linear…' : 'Connect Linear'}
          </Button>
        ) : (
          <span className={cn('text-sm', data.error ? 'text-fail' : 'text-fg-muted')}>
            {data.error ? 'Key rejected' : 'Not connected'}
          </span>
        )}
      </Row>
      {!data.connected && (
        <div className="space-y-3 border-b border-line py-4 text-sm text-fg-muted">
          {data.error && <p className="text-xs text-fail">{data.error}</p>}
          {data.canSignIn && (
            <p className="text-xs">
              Connect opens Linear, where you approve read-only access for Review Desk. It goes
              through Linear’s MCP server, so it works even where personal API keys are turned off.
              The sign-in is kept in your macOS Keychain, never in this app’s pages or data folder.
            </p>
          )}
          <details className="group text-xs" open={!data.canSignIn}>
            <summary className="cursor-default select-none hover:text-fg">
              {data.canSignIn ? 'Use a personal API key instead' : 'Use a personal API key'}
            </summary>
            <div className="mt-2 space-y-2">
              <p>
                If your workspace allows personal API keys (Linear Settings → Security & access →
                Personal API keys), create one and store it in your macOS Keychain by running this
                in a terminal and pasting the key when asked:
              </p>
              <div className="flex items-center gap-2">
                <code className="min-w-0 flex-1 truncate rounded-sm border border-line bg-sunken px-2 py-1.5 text-xs text-fg">
                  {data.setupCommand}
                </code>
                <Button
                  size="sm"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(data.setupCommand)
                      .then(() => toast('Command copied'))
                  }
                >
                  Copy
                </Button>
                <Button size="sm" onClick={() => void status.refetch()}>
                  Check again
                </Button>
              </div>
            </div>
          </details>
        </div>
      )}
    </section>
  );
}

function Toggle({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-4 py-1.5 text-sm">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="size-4 accent-accent"
      />
    </label>
  );
}

function NotificationsSection({ account }: { account: string }) {
  const client = useQueryClient();
  const query = useNotificationSettings();
  const [permission, setPermission] = useState(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );
  const save = useMutation({
    mutationFn: (settings: NotificationSettings) =>
      api<NotificationSettings>('/api/notifications/settings', {
        method: 'PUT',
        body: { account, settings },
      }),
    onSuccess: (settings) => client.setQueryData(['notify-settings'], settings),
  });
  const test = useMutation({
    mutationFn: () => api('/api/notifications/test', { method: 'POST' }),
  });
  // Edits live in React state until saved, so controlled inputs update within the click.
  const [pending, setPending] = useState<NotificationSettings | null>(null);
  const settings = pending ?? query.data;

  useEffect(() => {
    if (notificationsSupported()) setPermission(Notification.permission);
  }, []);

  if (!settings) return null;

  const update = (next: Partial<NotificationSettings>) => {
    const merged = { ...settings, ...next };

    setPending(merged);
    save.mutate(merged, {
      onSuccess: (saved) => {
        client.setQueryData(['notify-settings'], saved);
        setPending(null);
      },
      onError: () => setPending(null),
    });
  };

  return (
    <>
      <h2 className="mt-8 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
        Notifications
      </h2>
      <Row
        label="Desktop notifications"
        hint={
          permission === 'granted'
            ? 'On. Shown while a Review Desk window is open; in-app toasts while you are looking at it.'
            : permission === 'denied'
              ? 'Blocked in this browser. Allow them in the site settings for 127.0.0.1.'
              : 'Get a notification when something needs you.'
        }
      >
        {permission === 'granted' ? (
          <button
            type="button"
            className="h-7 rounded-sm border border-line px-2 text-xs hover:bg-hover"
            onClick={() => test.mutate()}
          >
            Send a test
          </button>
        ) : (
          <button
            type="button"
            disabled={permission === 'denied'}
            className="h-7 rounded-sm bg-accent px-2 text-xs font-medium text-accent-fg disabled:opacity-50"
            onClick={() => void Notification.requestPermission().then(setPermission)}
          >
            Allow notifications
          </button>
        )}
      </Row>
      <div className="border-b border-line py-3">
        {(Object.keys(settings.kinds) as NotificationKind[]).map((kind) => (
          <Toggle
            key={kind}
            label={notificationKindLabels[kind]}
            checked={settings.kinds[kind]}
            onChange={(checked) => update({ kinds: { ...settings.kinds, [kind]: checked } })}
          />
        ))}
      </div>
      <Row label="Quiet hours" hint="Hold notifications back during these hours (local time).">
        <span className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            aria-label="Use quiet hours"
            checked={Boolean(settings.quietHours)}
            onChange={(event) =>
              update({ quietHours: event.target.checked ? { start: '19:00', end: '08:00' } : null })
            }
            className="size-4 accent-accent"
          />
          <input
            type="time"
            aria-label="Quiet hours start"
            disabled={!settings.quietHours}
            value={settings.quietHours?.start ?? '19:00'}
            onChange={(event) =>
              settings.quietHours &&
              update({ quietHours: { ...settings.quietHours, start: event.target.value } })
            }
            className="h-7 rounded-sm border border-line bg-sunken px-1 disabled:opacity-50"
          />
          to
          <input
            type="time"
            aria-label="Quiet hours end"
            disabled={!settings.quietHours}
            value={settings.quietHours?.end ?? '08:00'}
            onChange={(event) =>
              settings.quietHours &&
              update({ quietHours: { ...settings.quietHours, end: event.target.value } })
            }
            className="h-7 rounded-sm border border-line bg-sunken px-1 disabled:opacity-50"
          />
        </span>
      </Row>
      <div className="border-b border-line py-3">
        <Toggle
          label="Use macOS notifications when no Review Desk window is open"
          checked={settings.macosWhenClosed}
          onChange={(macosWhenClosed) => update({ macosWhenClosed })}
        />
        <p className="text-xs text-fg-muted">
          Sent by the local server; clicking one opens Script Editor rather than the PR.
        </p>
        <Toggle
          label="Count my PRs that need me in the app badge"
          checked={settings.badgeIncludesMine}
          onChange={(badgeIncludesMine) => update({ badgeIncludesMine })}
        />
      </div>
    </>
  );
}
