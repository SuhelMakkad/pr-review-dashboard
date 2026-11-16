import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CircleCheck, CircleX } from 'lucide-react';
import { toast } from 'sonner';
import {
  aiTaskLabels,
  type AiEffort,
  type AiProvider,
  type AiSettings,
  type AiTask,
  type CodexAccountStatus,
} from '@review-desk/shared/ai';
import { shortDateTime } from '@/lib/time';
import { cn } from '@/ui/cn';
import { Enter } from '@/ui/motion';
import { Select } from '@/ui/select';
import { useAiOverview, useAiSettings } from '@/features/ai/use-ai';
import { CardSkeleton, Segmented, SettingRow, SettingsCard } from '@/features/settings/parts';

const efforts: AiEffort[] = ['low', 'medium', 'high', 'xhigh'];

/** How much of each Codex usage window is used, as a bar that turns red when it runs out. */
function UsageMeter({ window }: { window: CodexAccountStatus['windows'][number] }) {
  const used = Math.min(100, Math.max(0, window.usedPercent));
  const full = window.usedPercent >= 100;

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-4 text-xs">
        <span className={full ? 'font-medium text-fail' : 'text-fg'}>
          {window.label}: {window.usedPercent}% used
        </span>
        {window.resetsAt && (
          <span className="text-fg-subtle" data-volatile>
            resets {shortDateTime(window.resetsAt)}
          </span>
        )}
      </div>
      <div
        role="meter"
        aria-label={`${window.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={used}
        className="h-1.5 overflow-hidden rounded-full bg-sunken"
      >
        <div
          className={cn(
            'h-full rounded-full',
            full ? 'bg-fail' : used >= 80 ? 'bg-pending' : 'bg-accent',
          )}
          style={{ width: `${used}%` }}
        />
      </div>
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
  if (agent !== 'codex' || !status || status.models.length === 0) {
    return <span className="text-xs text-fg-subtle">Agent's default</span>;
  }

  const fallback = status.models.find((model) => model.isDefault);
  const known = value === null || status.models.some((model) => model.id === value);

  return (
    <Select
      aria-label={`${aiTaskLabels[task]} model`}
      value={value ?? ''}
      onChange={(event) => onChange(event.target.value || null)}
      className="w-full max-w-44"
    >
      <option value="">{fallback ? `${fallback.displayName} (default)` : 'Default model'}</option>
      {status.models.map((model) => (
        <option key={model.id} value={model.id}>
          {model.displayName}
        </option>
      ))}
      {!known && <option value={value!}>{value} (not offered; uses the default)</option>}
    </Select>
  );
}

export function AiAgentSettings({ account }: { account: string }) {
  const client = useQueryClient();
  const overview = useAiOverview();
  const save = useAiSettings(account);
  // The latest choice, shown until the server confirms it, so a select never snaps back.
  const [pending, setPending] = useState<AiSettings | null>(null);
  const latest = useRef(0);
  const saved = overview.data?.settings;
  const providers = overview.data?.providers ?? [];
  const codex = overview.data?.codex ?? null;

  if (!saved) return <CardSkeleton label="Loading AI settings…" rows={4} />;

  const settings = pending ?? saved;

  const update = (next: AiSettings) => {
    const id = ++latest.current;

    setPending(next);
    save.mutate(next, {
      onSuccess: (confirmed) => {
        client.setQueryData<typeof overview.data>(['ai-overview'], (current) =>
          current ? { ...current, settings: confirmed } : current,
        );
      },
      onError: (error) => toast.error(error.message),
      onSettled: () => {
        if (id === latest.current) setPending(null);
      },
    });
  };

  const updateTask = (task: AiTask, patch: Partial<AiSettings['tasks'][AiTask]>) =>
    update({
      ...settings,
      tasks: { ...settings.tasks, [task]: { ...settings.tasks[task], ...patch } },
    });

  return (
    <Enter preset="fade" className="space-y-4">
      <SettingsCard title="Agents">
        <SettingRow
          label="Default agent"
          hint="Used for every task unless a task below says otherwise."
        >
          <Segmented<AiProvider>
            label="Default agent"
            value={settings.defaultProvider}
            onChange={(defaultProvider) => update({ ...settings, defaultProvider })}
            options={[
              { value: 'codex', label: 'Codex' },
              { value: 'claude', label: 'Claude Code' },
            ]}
          />
        </SettingRow>
        <div className="py-3.5">
          <div className="text-sm font-medium">Installed agents</div>
          <div className="mt-0.5 text-xs text-fg-muted">
            Runs locally through each CLI's own login; no API keys are stored here.
          </div>
          <ul aria-label="Installed agents" className="mt-2.5 space-y-1.5">
            {providers.map((provider) => (
              <li key={provider.id} className="flex items-center gap-2 text-sm">
                {provider.available ? (
                  <CircleCheck size={14} className="shrink-0 text-ok" aria-hidden="true" />
                ) : (
                  <CircleX size={14} className="shrink-0 text-fail" aria-hidden="true" />
                )}
                <span className="font-medium">{provider.label}</span>
                <span className={cn('truncate text-xs', !provider.available && 'text-fail')}>
                  {provider.available
                    ? (provider.version ?? 'available')
                    : (provider.reason ?? 'unavailable')}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </SettingsCard>

      {codex && (
        <SettingsCard
          title="Codex plan"
          description="Codex uses your ChatGPT plan. Runs pause when the plan's limit is reached, so they never fall back to credits."
        >
          <div className="space-y-3 py-3.5">
            {codex.plan && <div className="text-sm font-medium">{codex.plan}</div>}
            {codex.windows.map((window) => (
              <UsageMeter key={window.label} window={window} />
            ))}
            {codex.problem && (
              <p className="text-xs text-fail" role="alert">
                {codex.problem}
              </p>
            )}
          </div>
        </SettingsCard>
      )}

      <SettingsCard
        title="Tasks"
        description="Higher effort and larger models use more of your plan. Full reviews always run on Codex."
      >
        <table className="w-full text-left text-sm">
          <caption className="sr-only">Agent, model and effort for each AI task</caption>
          <thead>
            <tr className="text-2xs font-medium tracking-wide text-fg-subtle uppercase">
              <th scope="col" className="py-2.5 pr-3 font-medium">
                Task
              </th>
              <th scope="col" className="py-2.5 pr-3 font-medium">
                Agent
              </th>
              <th scope="col" className="py-2.5 pr-3 font-medium">
                Model
              </th>
              <th scope="col" className="py-2.5 font-medium">
                Effort
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line border-t border-line">
            {(Object.keys(settings.tasks) as AiTask[]).map((task) => {
              const agent =
                task === 'full_review'
                  ? 'codex'
                  : (settings.tasks[task].provider ?? settings.defaultProvider);

              return (
                <tr key={task}>
                  <th scope="row" className="py-2.5 pr-3 font-medium">
                    {aiTaskLabels[task]}
                  </th>
                  <td className="py-2.5 pr-3">
                    <Select
                      aria-label={`${aiTaskLabels[task]} agent`}
                      disabled={task === 'full_review'}
                      value={settings.tasks[task].provider ?? ''}
                      onChange={(event) =>
                        updateTask(task, {
                          provider: (event.target.value || null) as AiProvider | null,
                          // Model ids belong to one agent.
                          model: null,
                        })
                      }
                    >
                      <option value="">Default agent</option>
                      <option value="codex">Codex</option>
                      <option value="claude">Claude Code</option>
                    </Select>
                  </td>
                  <td className="py-2.5 pr-3">
                    <CodexModelSelect
                      task={task}
                      status={codex}
                      agent={agent}
                      value={settings.tasks[task].model}
                      onChange={(model) => updateTask(task, { model })}
                    />
                  </td>
                  <td className="py-2.5">
                    <Select
                      aria-label={`${aiTaskLabels[task]} effort`}
                      value={settings.tasks[task].effort}
                      onChange={(event) =>
                        updateTask(task, { effort: event.target.value as AiEffort })
                      }
                    >
                      {efforts.map((effort) => (
                        <option key={effort} value={effort}>
                          {effort}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </SettingsCard>
    </Enter>
  );
}
