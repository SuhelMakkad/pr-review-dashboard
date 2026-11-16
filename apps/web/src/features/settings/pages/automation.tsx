import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Enter } from '@/ui/motion';
import { Switch } from '@/ui/switch';
import { useAiOverview, useAiSettings } from '@/features/ai/use-ai';
import { CardSkeleton, SettingRow, SettingsCard } from '@/features/settings/parts';

type AiToggle = 'autoReview' | 'postFindings';

export function AutomationSettings({ account }: { account: string }) {
  const client = useQueryClient();
  const overview = useAiOverview();
  const save = useAiSettings(account);
  // Choices being saved, shown until the server confirms them, so the switches never flicker.
  const [pending, setPending] = useState<Partial<Record<AiToggle, boolean>>>({});
  const saved = overview.data?.settings;

  if (!saved) return <CardSkeleton label="Loading automation settings…" rows={2} />;

  const autoReview = pending.autoReview ?? saved.autoReview.enabled;
  const postFindings = pending.postFindings ?? saved.postFindings;
  // Every save carries the toggles still being saved, so one change never undoes another.
  const settings = {
    ...saved,
    autoReview: { ...saved.autoReview, enabled: autoReview },
    postFindings,
  };

  const settle = (toggle: AiToggle) => setPending(({ [toggle]: _settled, ...rest }) => rest);

  const setToggle = (toggle: AiToggle, enabled: boolean) => {
    setPending((current) => ({ ...current, [toggle]: enabled }));
    save.mutate(
      toggle === 'autoReview'
        ? { ...settings, autoReview: { ...settings.autoReview, enabled } }
        : { ...settings, postFindings: enabled },
      {
        onSuccess: (next) => {
          client.setQueryData<typeof overview.data>(['ai-overview'], (current) =>
            current ? { ...current, settings: next } : current,
          );
          settle(toggle);
        },
        onError: (error) => {
          settle(toggle);
          toast.error(error.message);
        },
      },
    );
  };

  return (
    <Enter preset="fade" className="space-y-4">
      <SettingsCard title="Automatic reviews">
        <SettingRow
          label="Review requested PRs automatically"
          hint={`Runs a full review as soon as you or one of your teams is asked to review, including re-requests. Uses your ChatGPT plan. ${
            postFindings
              ? 'Findings are posted to the PR when each review finishes.'
              : 'Findings are never posted for you.'
          }${autoReview ? ' Requests already waiting when you turned this on are not reviewed.' : ''}`}
        >
          <Switch
            aria-label="Review requested PRs automatically"
            checked={autoReview}
            onCheckedChange={(enabled) => setToggle('autoReview', enabled)}
          />
        </SettingRow>
      </SettingsCard>

      <SettingsCard
        title="Posting to GitHub"
        description="Posts go out as you, so they are off until you turn them on."
      >
        <SettingRow
          label="Post findings to the PR"
          hint="When a full review finishes, automatic or started by you, its summary and findings are posted to the PR as one comment from your account. Your review request stays open, and it never approves or requests changes. A review is not posted once new commits arrive. Activity shows each post."
        >
          <Switch
            aria-label="Post findings to the PR"
            checked={postFindings}
            onCheckedChange={(enabled) => setToggle('postFindings', enabled)}
          />
        </SettingRow>
      </SettingsCard>
    </Enter>
  );
}
