import { codexBlocked } from '@review-desk/shared/ai';
import { notificationsSupported } from '@/lib/notifications';
import { useAiOverview } from '@/features/ai/use-ai';
import { useLinearStatus } from '@/features/linear/use-linear';
import type { SettingsSlug } from '@/features/settings/sections';

export interface SectionBadge {
  tone: 'ok' | 'warn' | 'fail' | 'muted';
  label: string;
  /** Shown as a coloured dot; the label becomes its tooltip and is read with the link. */
  dot?: boolean;
}

/** What each settings page wants you to know before you open it: a connection, a problem, a mode. */
export function useSettingsBadges(): Partial<Record<SettingsSlug, SectionBadge>> {
  const ai = useAiOverview();
  const linear = useLinearStatus();
  const badges: Partial<Record<SettingsSlug, SectionBadge>> = {};

  if (notificationsSupported() && Notification.permission === 'denied') {
    badges.notifications = { tone: 'fail', label: 'Blocked' };
  }

  if (linear.data?.connected) badges.linear = { tone: 'ok', label: 'Connected', dot: true };
  else if (linear.data?.error)
    badges.linear = { tone: 'fail', label: 'Needs attention', dot: true };

  const overview = ai.data;

  if (overview) {
    const unavailable = (id: string) =>
      overview.providers.some((provider) => provider.id === id && !provider.available);
    // Full reviews always run on Codex, so Codex matters even when another agent is the default.
    const blocked =
      codexBlocked(overview.codex) ||
      unavailable('codex') ||
      unavailable(overview.settings.defaultProvider);

    if (blocked) badges.ai = { tone: 'warn', label: 'Needs attention', dot: true };
    if (overview.settings.autoReview.enabled) badges.automation = { tone: 'muted', label: 'On' };
  }

  return badges;
}
