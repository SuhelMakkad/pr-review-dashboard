import { call } from '@/lib/call';
import { routes } from '@review-desk/shared/contract';
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  notificationKindLabels,
  type NotificationKind,
  type NotificationSettings,
} from '@review-desk/shared/notify';
import { notificationsSupported } from '@/lib/notifications';
import { useNotificationSettings } from '@/lib/queries';
import { Button } from '@/ui/button';
import { Enter } from '@/ui/motion';
import { Switch } from '@/ui/switch';
import { CardSkeleton, SettingRow, SettingsCard } from '@/features/settings/parts';

type KindGroup = 'Reviewing' | 'Conversations' | 'Your PRs';

/** Which list each kind appears in. Typed by kind, so a new kind cannot go missing from the page. */
const kindGroup = {
  first_review: 'Reviewing',
  requested_again: 'Reviewing',
  changed: 'Reviewing',
  dismissed: 'Reviewing',
  ai_review_ready: 'Reviewing',
  reply: 'Conversations',
  mention: 'Conversations',
  changes_requested: 'Your PRs',
  approved: 'Your PRs',
  ci_failing: 'Your PRs',
} as const satisfies Record<NotificationKind, KindGroup>;

const kindGroups: KindGroup[] = ['Reviewing', 'Conversations', 'Your PRs'];

const kindsIn = (group: KindGroup) =>
  (Object.keys(kindGroup) as NotificationKind[]).filter((kind) => kindGroup[kind] === group);

export function NotificationSettingsPage({ account }: { account: string }) {
  const client = useQueryClient();
  const query = useNotificationSettings();
  const [permission, setPermission] = useState(() =>
    notificationsSupported() ? Notification.permission : 'denied',
  );
  const save = useMutation({
    mutationFn: (settings: NotificationSettings) =>
      call(routes.saveNotificationSettings, { params: {}, body: { account, settings } }),
    onSuccess: (settings) => client.setQueryData(['notify-settings'], settings),
  });
  const test = useMutation({
    mutationFn: () => call(routes.testNotification, { params: {} }),
  });
  // Edits live in React state until saved, so controlled inputs update within the click.
  const [pending, setPending] = useState<NotificationSettings | null>(null);
  const settings = pending ?? query.data;

  useEffect(() => {
    if (notificationsSupported()) setPermission(Notification.permission);
  }, []);

  if (!settings) return <CardSkeleton label="Loading notification settings…" rows={3} />;

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
    <Enter preset="fade" className="space-y-4">
      <SettingsCard title="Delivery">
        <SettingRow
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
            <Button size="sm" onClick={() => test.mutate()}>
              Send a test
            </Button>
          ) : (
            <Button
              size="sm"
              variant="primary"
              disabled={permission === 'denied'}
              onClick={() => void Notification.requestPermission().then(setPermission)}
            >
              Allow notifications
            </Button>
          )}
        </SettingRow>
        <SettingRow
          label="Use macOS notifications when no window is open"
          hint="Sent by the local server; clicking one opens Script Editor rather than the PR."
        >
          <Switch
            aria-label="Use macOS notifications when no Review Desk window is open"
            checked={settings.macosWhenClosed}
            onCheckedChange={(macosWhenClosed) => update({ macosWhenClosed })}
          />
        </SettingRow>
        <SettingRow
          label="Count my PRs that need me in the app badge"
          hint="The badge always counts the PRs in Needs attention."
        >
          <Switch
            aria-label="Count my PRs that need me in the app badge"
            checked={settings.badgeIncludesMine}
            onCheckedChange={(badgeIncludesMine) => update({ badgeIncludesMine })}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard title="What to notify me about">
        {kindGroups.map((group) => (
          <div key={group} role="group" aria-label={group} className="py-3">
            <div className="pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase">
              {group}
            </div>
            {kindsIn(group).map((kind) => (
              <label key={kind} className="flex items-center justify-between gap-4 py-1.5 text-sm">
                <span>{notificationKindLabels[kind]}</span>
                <Switch
                  checked={settings.kinds[kind]}
                  onCheckedChange={(checked) =>
                    update({ kinds: { ...settings.kinds, [kind]: checked } })
                  }
                />
              </label>
            ))}
          </div>
        ))}
      </SettingsCard>

      <SettingsCard title="Quiet hours">
        <SettingRow label="Hold notifications back" hint="During these hours, in local time.">
          <span className="flex shrink-0 items-center gap-2 text-xs">
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
            <Switch
              aria-label="Use quiet hours"
              className="ml-2"
              checked={Boolean(settings.quietHours)}
              onCheckedChange={(checked) =>
                update({ quietHours: checked ? { start: '19:00', end: '08:00' } : null })
              }
            />
          </span>
        </SettingRow>
      </SettingsCard>
    </Enter>
  );
}
