import type { ReactNode } from 'react';

export function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon?: ReactNode;
  title: string;
  hint?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex max-w-sm flex-col items-center gap-2 px-6 py-10 text-center">
      {icon && <div className="mb-1 text-fg-subtle">{icon}</div>}
      <h3 className="text-base font-semibold text-fg">{title}</h3>
      {hint && <p className="text-sm text-fg-muted">{hint}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
