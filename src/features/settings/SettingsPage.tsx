import type { ReactNode } from 'react';
import { ToggleGroup } from 'radix-ui';
import { appearance, useAppearance, type Density, type ThemePreference } from '../../lib/theme';
import { useLive } from '../../lib/live';
import { useStatus } from '../../lib/queries';
import { dateTime } from '../../lib/time';
import { cn } from '../../ui/cn';

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
