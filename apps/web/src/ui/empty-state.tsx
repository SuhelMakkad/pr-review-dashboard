import type { ReactNode } from 'react';
import { StaggerItem } from '@/ui/motion';

export function EmptyState({
  icon,
  title,
  hint,
  action,
  stagger = false,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
  /** Rises each part in a beat after the one before, when an ancestor such as `Enter` enters. */
  stagger?: boolean;
}) {
  let index = 0;
  const part = (node: ReactNode) =>
    stagger ? <StaggerItem index={index++}>{node}</StaggerItem> : node;

  return (
    <div className="flex max-w-sm flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && part(<div className="mb-1 text-fg-subtle">{icon}</div>)}
      {part(<h3 className="text-base font-semibold text-fg">{title}</h3>)}
      {hint && part(<p className="text-sm text-fg-muted">{hint}</p>)}
      {action && part(<div className="mt-2">{action}</div>)}
    </div>
  );
}
