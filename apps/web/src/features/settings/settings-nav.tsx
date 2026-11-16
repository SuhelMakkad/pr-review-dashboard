import { Link } from '@tanstack/react-router';
import { cn } from '@/ui/cn';
import { IndicatorGroup } from '@/ui/motion';
import { NavContent, navClass } from '@/features/shell/nav-item';
import { type SectionBadge, useSettingsBadges } from '@/features/settings/section-status';
import {
  type SettingsGroup,
  type SettingsSection,
  type SettingsSlug,
  settingsSections,
} from '@/features/settings/sections';

const groups: SettingsGroup[] = ['App', 'Connections', 'AI'];

const dotClass: Record<SectionBadge['tone'], string> = {
  ok: 'bg-ok',
  warn: 'bg-pending',
  fail: 'bg-fail',
  muted: 'bg-fg-subtle',
};

const textClass: Record<SectionBadge['tone'], string> = {
  ok: 'text-ok',
  warn: 'text-pending',
  fail: 'text-fail',
  muted: 'text-fg-subtle',
};

/**
 * A page's status after its name. The link's accessible name comes from its content, so the hidden
 * comma makes it read "Linear, Connected" while the visible text stays in the name as shown.
 */
function Badge({ badge }: { badge: SectionBadge }) {
  if (badge.dot) {
    return (
      <>
        <span
          className={cn('size-1.5 shrink-0 rounded-full', dotClass[badge.tone])}
          title={badge.label}
          aria-hidden="true"
        />
        <span className="sr-only">, {badge.label}</span>
      </>
    );
  }

  return (
    <>
      <span className="sr-only">,</span>{' '}
      <span className={cn('shrink-0 text-2xs font-medium', textClass[badge.tone])}>
        {badge.label}
      </span>
    </>
  );
}

function SectionLink({
  section,
  active,
  badge,
}: {
  section: SettingsSection;
  active: boolean;
  badge?: SectionBadge;
}) {
  return (
    <Link
      to="/settings/$section"
      params={{ section: section.slug }}
      aria-current={active ? 'page' : undefined}
      className={navClass(active)}
    >
      <NavContent
        active={active}
        icon={section.icon}
        label={section.label}
        trailing={badge && <Badge badge={badge} />}
      />
    </Link>
  );
}

/** The list of settings pages, beside the page itself. Each entry can flag what needs you. */
export function SettingsNav({ active }: { active: SettingsSlug }) {
  const badges = useSettingsBadges();
  const inGroup = (group: SettingsGroup) =>
    settingsSections.filter((section) => section.group === group);

  return (
    <div className="scroll-thin flex w-52 shrink-0 flex-col overflow-y-auto border-r border-line px-2 py-6">
      <h1 className="px-2 text-xl font-semibold">Settings</h1>

      <IndicatorGroup>
        <nav aria-label="Settings sections" className="mt-4 flex flex-1 flex-col">
          {groups.map((group) => (
            <div
              key={group}
              role="group"
              aria-labelledby={`settings-group-${group}`}
              className="mb-4 flex flex-col gap-px"
            >
              <div
                id={`settings-group-${group}`}
                className="px-2 pb-1 text-2xs font-medium tracking-wide text-fg-subtle uppercase"
              >
                {group}
              </div>
              {inGroup(group).map((section) => (
                <SectionLink
                  key={section.slug}
                  section={section}
                  active={active === section.slug}
                  badge={badges[section.slug]}
                />
              ))}
            </div>
          ))}

          <div className="mt-auto flex flex-col gap-px border-t border-line pt-2">
            {inGroup('About').map((section) => (
              <SectionLink
                key={section.slug}
                section={section}
                active={active === section.slug}
                badge={badges[section.slug]}
              />
            ))}
          </div>
        </nav>
      </IndicatorGroup>
    </div>
  );
}
