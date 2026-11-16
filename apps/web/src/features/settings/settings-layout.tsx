import type { ReactNode } from 'react';
import { useParams, useSearch } from '@tanstack/react-router';
import { useStatus } from '@/lib/queries';
import { Enter } from '@/ui/motion';
import { AiAgentSettings } from '@/features/settings/pages/ai-agents';
import { AppearanceSettings } from '@/features/settings/pages/appearance';
import { AutomationSettings } from '@/features/settings/pages/automation';
import { GitHubSettings } from '@/features/settings/pages/github';
import { LinearSettings } from '@/features/settings/pages/linear';
import { NotificationSettingsPage } from '@/features/settings/pages/notifications';
import { PrivacySettings } from '@/features/settings/pages/privacy';
import type { SettingsSearch } from '@/features/settings/search';
import { type SettingsSlug, settingsSection } from '@/features/settings/sections';
import { SettingsNav } from '@/features/settings/settings-nav';

interface PageProps {
  account: string;
  search: SettingsSearch;
}

const pages: Record<SettingsSlug, (props: PageProps) => ReactNode> = {
  appearance: () => <AppearanceSettings />,
  notifications: ({ account }) => <NotificationSettingsPage account={account} />,
  github: () => <GitHubSettings />,
  linear: ({ search }) => <LinearSettings result={search.linear} />,
  ai: ({ account }) => <AiAgentSettings account={account} />,
  automation: ({ account }) => <AutomationSettings account={account} />,
  privacy: () => <PrivacySettings />,
};

/** Settings: the list of pages on the left, the open page on the right. */
export function SettingsLayout() {
  // The route only matches a known slug; anything else redirects before rendering.
  const slug = useParams({ from: '/settings/$section' }).section as SettingsSlug;
  const search = useSearch({ from: '/settings/$section' });
  const account = useStatus().data?.account?.login ?? '';
  const section = settingsSection(slug);
  const Page = pages[slug];

  return (
    <div className="flex h-full bg-bg">
      <SettingsNav active={slug} />

      {/* Keyed by page, so each one starts at the top and eases in while the list stays put. */}
      <div key={slug} className="scroll-thin min-w-0 flex-1 overflow-y-auto">
        <Enter preset="fade">
          <section aria-labelledby="settings-title" className="max-w-3xl px-8 py-6">
            <header className="mb-6">
              <h2 id="settings-title" className="text-xl font-semibold">
                {section.label}
              </h2>
              <p className="mt-1 text-sm text-fg-muted">{section.description}</p>
            </header>
            <div className="space-y-4">
              <Page account={account} search={search} />
            </div>
          </section>
        </Enter>
      </div>
    </div>
  );
}
