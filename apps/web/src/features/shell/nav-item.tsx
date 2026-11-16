import type { ComponentType, ReactNode } from 'react';
import { cn } from '@/ui/cn';
import { ActiveIndicator } from '@/ui/motion';

/** Any icon that takes a size and a class: a lucide icon or one of the brand marks. */
export type NavIcon = ComponentType<{ size?: number; className?: string; 'aria-hidden'?: boolean }>;

/** Classes for one sidebar entry, shared by the app sidebar and the settings sidebar. */
export const navClass = (active: boolean) =>
  cn(
    'relative flex h-8 items-center rounded-sm px-2 text-sm transition-colors',
    active ? 'font-medium text-fg' : 'text-fg-muted hover:bg-hover hover:text-fg',
  );

/** One navigation entry's content. The active entry carries the indicator that glides between them. */
export function NavContent({
  active,
  icon: Icon,
  label,
  trailing,
}: {
  active: boolean;
  icon: NavIcon;
  label: string;
  trailing?: ReactNode;
}) {
  return (
    <>
      {active && <ActiveIndicator variant="fill" />}
      <span className="relative z-10 flex min-w-0 flex-1 items-center gap-2.5">
        <Icon size={15} aria-hidden={true} className={active ? 'text-accent' : ''} />
        <span className="flex-1 truncate">{label}</span>
        {trailing}
      </span>
    </>
  );
}
