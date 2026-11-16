import { useId, type ReactNode } from 'react';
import { ToggleGroup } from 'radix-ui';
import { cn } from '@/ui/cn';
import { ActiveIndicator, IndicatorGroup } from '@/ui/motion';
import { Skeleton, SkeletonRegion } from '@/ui/skeleton';

/** A titled group of related settings, drawn as one card with its rows divided. */
export function SettingsCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();

  return (
    <div role="group" aria-labelledby={id} className="rounded-lg border border-line bg-panel">
      <div className="px-4 pt-3.5">
        <h3 id={id} className="text-sm font-semibold">
          {title}
        </h3>
        {description && <p className="mt-0.5 text-xs text-fg-muted">{description}</p>}
      </div>
      <div className="divide-y divide-line px-4">{children}</div>
    </div>
  );
}

/** One setting: its label and hint on the left, its control on the right. */
export function SettingRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-3.5">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        {hint && <div className="mt-0.5 text-xs leading-relaxed text-fg-muted">{hint}</div>}
      </div>
      {children}
    </div>
  );
}

/** A card in outline while its data loads: its title, then its rows. */
export function CardSkeleton({ label, rows }: { label: string; rows: number }) {
  return (
    <SkeletonRegion label={label}>
      <div className="rounded-lg border border-line bg-panel px-4 pt-3.5">
        <Skeleton className="h-3.5 w-28" />
        <div className="divide-y divide-line">
          {Array.from({ length: rows }, (_, index) => (
            <div key={index} className="flex items-center justify-between gap-6 py-3.5">
              <div className="space-y-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-7 w-28 rounded-sm" />
            </div>
          ))}
        </div>
      </div>
    </SkeletonRegion>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <IndicatorGroup>
      <ToggleGroup.Root
        type="single"
        value={value}
        onValueChange={(next) => next && onChange(next as T)}
        aria-label={label}
        className="inline-flex shrink-0 rounded-sm border border-line bg-sunken p-0.5"
      >
        {options.map((option) => (
          <ToggleGroup.Item
            key={option.value}
            value={option.value}
            className={cn(
              'relative h-7 rounded-xs px-3 text-xs text-fg-muted transition-colors hover:text-fg',
              'data-[state=on]:font-medium data-[state=on]:text-fg',
            )}
          >
            {option.value === value && <ActiveIndicator variant="pill" />}
            <span className="relative z-10">{option.label}</span>
          </ToggleGroup.Item>
        ))}
      </ToggleGroup.Root>
    </IndicatorGroup>
  );
}
