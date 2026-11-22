import { useLive } from '@/lib/live';
import { useStatus } from '@/lib/queries';
import { SettingsCard } from '@/features/settings/parts';

const storage = (folder: string | undefined) => ({
  term: 'Storage',
  detail: (
    <>
      Cached GitHub and GitLab data, notes, snoozes and acknowledgements live in{' '}
      {folder ? <code>{folder}</code> : 'the data folder'} on this machine.
    </>
  ),
});

const points = [
  {
    term: 'Network',
    detail:
      'The server only listens on 127.0.0.1, and every write needs this window’s session token.',
  },
  {
    term: 'Credentials',
    detail: (
      <>
        GitHub credentials come from the GitHub CLI. When you pick an account, its token goes only
        to the <code>gh</code> commands the server runs; it is never saved or sent to this window.
        GitLab requests run through <code>glab</code>, which keeps its own token; Review Desk never
        reads it.
      </>
    ),
  },
];

export function PrivacySettings() {
  const live = useLive();
  const status = useStatus();

  return (
    <SettingsCard title="On this machine">
      <dl className="divide-y divide-line">
        {[storage(status.data?.dataFolder), ...points].map((point) => (
          <div key={point.term} className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3.5">
            <dt className="text-sm font-medium">{point.term}</dt>
            <dd className="text-sm leading-relaxed text-fg-muted">{point.detail}</dd>
          </div>
        ))}
        {live.demo && (
          <div className="grid grid-cols-[7rem_minmax(0,1fr)] gap-4 py-3.5">
            <dt className="text-sm font-medium">Demo mode</dt>
            <dd className="text-sm leading-relaxed text-fg-muted">
              This window is running in demo mode with a fictional scenario; nothing reaches GitHub.
            </dd>
          </div>
        )}
      </dl>
    </SettingsCard>
  );
}
