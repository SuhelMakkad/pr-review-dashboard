import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { forgeTerms } from '@review-desk/shared/accounts';
import { toast } from 'sonner';
import { Enter } from '@/ui/motion';
import { Switch } from '@/ui/switch';
import { quietMinutes } from '@/features/ai/restart';
import { useAiOverview, useAiSettings } from '@/features/ai/use-ai';
import { CardSkeleton, SettingRow, SettingsCard } from '@/features/settings/parts';

type AiToggle = 'autoReview' | 'postFindings' | 'approveFindings' | 'resolveThreads';

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
  const approveFindings = pending.approveFindings ?? saved.approveFindings;
  const resolveThreads = pending.resolveThreads ?? saved.resolveThreads;
  // Every save carries the toggles still being saved, so one change never undoes another.
  const settings = {
    ...saved,
    autoReview: { ...saved.autoReview, enabled: autoReview },
    postFindings,
    approveFindings,
    resolveThreads,
  };

  const settle = (toggle: AiToggle) => setPending(({ [toggle]: _settled, ...rest }) => rest);

  const setToggle = (toggle: AiToggle, enabled: boolean) => {
    setPending((current) => ({ ...current, [toggle]: enabled }));
    save.mutate(
      toggle === 'autoReview'
        ? { ...settings, autoReview: { ...settings.autoReview, enabled } }
        : { ...settings, [toggle]: enabled },
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
          hint={`Runs a full review as soon as you or one of your teams is asked to review, including re-requests. If new commits arrive while it runs, it stops and reviews the latest commits once the PR has had none for ${quietMinutes} minutes. Uses your ChatGPT plan. ${
            postFindings
              ? approveFindings
                ? 'Findings are posted to the PR when each review finishes, approving it where nothing blocks.'
                : 'Findings are posted to the PR as a comment when each review finishes.'
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
        title={`Posting to ${forgeTerms(account).name}`}
        description="Posts go out as you, so they are off until you turn them on."
      >
        <SettingRow
          label="Post findings to the PR"
          hint="When a full review finishes, automatic or started by you, it posts the summary and findings as one comment from your account. Reviews skipped because of new commits or new discussion stay in the dashboard. Activity shows each post."
        >
          <Switch
            aria-label="Post findings to the PR"
            checked={postFindings}
            onCheckedChange={(enabled) => setToggle('postFindings', enabled)}
          />
        </SettingRow>
        <SettingRow
          label="Approve when there are no blocking findings"
          hint="Approves instead of commenting, but only when the review read every changed file and nothing changed on the PR since. Otherwise it comments and says why."
        >
          <Switch
            aria-label="Approve when there are no blocking findings"
            checked={approveFindings}
            disabled={!postFindings}
            onCheckedChange={(enabled) => setToggle('approveFindings', enabled)}
          />
        </SettingRow>
        <SettingRow
          label="Resolve threads before approving"
          hint="Resolves the open review threads the review read. Threads opened later are left alone, and stop the approval."
        >
          <Switch
            aria-label="Resolve threads before approving"
            checked={resolveThreads}
            disabled={!postFindings || !approveFindings}
            onCheckedChange={(enabled) => setToggle('resolveThreads', enabled)}
          />
        </SettingRow>
      </SettingsCard>
    </Enter>
  );
}
