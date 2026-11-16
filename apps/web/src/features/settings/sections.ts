import { Bell, Bot, Palette, ShieldCheck, Workflow } from 'lucide-react';
import { GitHubMark, LinearMark } from '@/ui/brand-icons';
import type { NavIcon } from '@/features/shell/nav-item';

export type SettingsGroup = 'App' | 'Connections' | 'AI' | 'About';

export interface SettingsSection {
  slug: string;
  label: string;
  group: SettingsGroup;
  icon: NavIcon;
  /** One line under the page title. */
  description: string;
  /** Extra words the command palette matches, so a search for a setting finds its page. */
  keywords: string[];
}

/** Every settings page, in nav order. The nav, the router, the palette and page headers read it. */
export const settingsSections = [
  {
    slug: 'appearance',
    label: 'Appearance',
    group: 'App',
    icon: Palette,
    description: 'How Review Desk looks on this machine.',
    keywords: ['theme', 'dark', 'light', 'system', 'density', 'compact', 'comfortable'],
  },
  {
    slug: 'notifications',
    label: 'Notifications',
    group: 'App',
    icon: Bell,
    description: 'What reaches you, how, and when it stays quiet.',
    keywords: ['desktop', 'macos', 'quiet hours', 'badge', 'mentions', 'alerts'],
  },
  {
    slug: 'github',
    label: 'GitHub',
    group: 'Connections',
    icon: GitHubMark,
    description: 'The account Review Desk works as, and how fresh its data is.',
    keywords: ['account', 'switch', 'teams', 'sync', 'gh cli'],
  },
  {
    slug: 'linear',
    label: 'Linear',
    group: 'Connections',
    icon: LinearMark,
    description: 'Ticket status, owner and priority for the tickets your PRs reference.',
    keywords: ['tickets', 'issues', 'connect', 'api key', 'oauth'],
  },
  {
    slug: 'ai',
    label: 'AI agents',
    group: 'AI',
    icon: Bot,
    description: 'Which agent runs each task, with which model and how much effort.',
    keywords: ['codex', 'claude', 'model', 'effort', 'chatgpt plan', 'usage', 'limit'],
  },
  {
    slug: 'automation',
    label: 'Automation',
    group: 'AI',
    icon: Workflow,
    description: 'What Review Desk does for you without being asked.',
    keywords: ['automatic review', 'auto review', 'post findings', 'comment'],
  },
  {
    slug: 'privacy',
    label: 'Data & privacy',
    group: 'About',
    icon: ShieldCheck,
    description: 'Where your data lives and what leaves this machine.',
    keywords: ['storage', 'sqlite', 'token', 'credentials', 'security'],
  },
] as const satisfies readonly SettingsSection[];

export type SettingsSlug = (typeof settingsSections)[number]['slug'];

export const settingsSlugs: readonly SettingsSlug[] = settingsSections.map(
  (section) => section.slug,
);

export const firstSettingsSlug: SettingsSlug = settingsSections[0].slug;

export const isSettingsSlug = (value: string): value is SettingsSlug =>
  (settingsSlugs as readonly string[]).includes(value);

export const settingsSection = (slug: SettingsSlug): SettingsSection =>
  settingsSections.find((section) => section.slug === slug)!;
