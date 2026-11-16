import { ChevronDown, RefreshCw } from 'lucide-react';
import { useStatus, useSyncNow } from '@/lib/queries';
import { dateTime } from '@/lib/time';
import { Avatar } from '@/ui/avatar';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { AccountMenu } from '@/features/shell/account-menu';
import { SettingRow, SettingsCard } from '@/features/settings/parts';

export function GitHubSettings() {
  const status = useStatus();
  const sync = useSyncNow();
  const state = status.data;
  const login = state?.account?.login;
  const coolingDown = Boolean(state?.retryAt && Date.parse(state.retryAt) > Date.now());

  return (
    <>
      <SettingsCard title="Account">
        <SettingRow
          label="Signed in as"
          hint="Switching here leaves the GitHub CLI's own account, used in your terminal, as it is. Each account keeps separate data."
        >
          <AccountMenu side="bottom" align="end">
            <Button size="sm" icon={<Avatar login={login ?? '?'} size={16} />}>
              <span className="sr-only">Switch GitHub account, now</span>
              {login ?? '—'}
              <ChevronDown size={13} className="text-fg-subtle" aria-hidden="true" />
            </Button>
          </AccountMenu>
        </SettingRow>
        <SettingRow label="Teams" hint="Team review requests are matched against these.">
          {state?.teams.length ? (
            <ul aria-label="Teams" className="flex max-w-xs flex-wrap justify-end gap-1">
              {state.teams.map((team) => (
                <li
                  key={team}
                  className="rounded-xs border border-line bg-sunken px-1.5 py-0.5 text-xs text-fg-muted"
                >
                  {team}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-fg-muted">None</span>
          )}
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="Sync">
        <SettingRow
          label="Last successful sync"
          hint={
            state?.error
              ? `GitHub could not be reached: ${state.error}`
              : 'Review Desk syncs in the background while the server runs.'
          }
        >
          <span className="flex shrink-0 items-center gap-3">
            <span className="text-sm text-fg-muted" data-volatile>
              {state?.lastSuccessfulSync ? dateTime(state.lastSuccessfulSync) : 'Not yet'}
            </span>
            <Button
              size="sm"
              icon={
                <RefreshCw
                  size={12}
                  className={cn(state?.syncing && 'animate-spin')}
                  aria-hidden="true"
                />
              }
              disabled={state?.syncing || sync.isPending || coolingDown}
              title={
                coolingDown && state?.retryAt
                  ? `Rate limited until ${dateTime(state.retryAt)}`
                  : undefined
              }
              onClick={() => sync.mutate()}
            >
              {state?.syncing ? 'Syncing…' : 'Sync now'}
            </Button>
          </span>
        </SettingRow>
      </SettingsCard>
    </>
  );
}
