import { useEffect, useRef, useState, type ReactNode } from 'react';

/** Width of a container, tracked with ResizeObserver so charts fill their card. */
export function useWidth<T extends HTMLElement>(
  fallback = 600,
): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(fallback);

  useEffect(() => {
    const element = ref.current;

    if (!element || typeof ResizeObserver === 'undefined') return;

    const observer = new ResizeObserver(([entry]) =>
      setWidth(Math.max(240, Math.floor(entry.contentRect.width))),
    );

    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return [ref, width];
}

/** Round axis ticks: 0 and three or four clean steps up to the maximum. */
export function niceTicks(max: number, count = 4): number[] {
  if (max <= 0) return [0, 1];

  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step =
    [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ??
    raw;
  const ticks: number[] = [];

  for (let value = 0; value <= max + step * 0.001; value += step)
    ticks.push(Number(value.toFixed(6)));

  if (ticks.at(-1)! < max) ticks.push(Number((ticks.at(-1)! + step).toFixed(6)));

  return ticks;
}

export function formatHours(hours: number | null): string {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24)
    return `${hours < 10 ? hours.toFixed(1).replace(/\.0$/, '') : Math.round(hours)}h`;

  const days = hours / 24;

  return `${days < 10 ? days.toFixed(1).replace(/\.0$/, '') : Math.round(days)}d`;
}

/** Legend key that mirrors the mark: a rect for bars, a short line for lines. */
export function Legend({
  items,
}: {
  items: { label: string; color: string; shape: 'rect' | 'line'; icon?: ReactNode }[];
}) {
  return (
    <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-muted">
      {items.map((item) => (
        <li key={item.label} className="inline-flex items-center gap-1.5">
          {item.shape === 'rect' ? (
            <span
              className="size-2.5 rounded-[2px]"
              style={{ background: item.color }}
              aria-hidden="true"
            />
          ) : (
            <span
              className="h-0.5 w-3 rounded-full"
              style={{ background: item.color }}
              aria-hidden="true"
            />
          )}
          {item.icon}
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/** Tooltip near the pointer: value first and strong, label second. Content is plain text. */
export function ChartTooltip({
  x,
  y,
  width,
  title,
  rows,
}: {
  x: number;
  y: number;
  width: number;
  title: string;
  rows: { label: string; value: string; color?: string }[];
}) {
  const left = Math.min(Math.max(8, x + 12), width - 180);

  return (
    <div
      role="status"
      className="pointer-events-none absolute z-10 min-w-[150px] rounded-md border border-line bg-elevated px-2.5 py-2 text-xs shadow-popover"
      style={{ left, top: Math.max(0, y - 10) }}
    >
      <div className="mb-1 text-fg-muted">{title}</div>
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-2">
          {row.color && (
            <span
              className="h-0.5 w-3 rounded-full"
              style={{ background: row.color }}
              aria-hidden="true"
            />
          )}
          <span className="font-semibold text-fg tabular-nums">{row.value}</span>
          <span className="text-fg-muted">{row.label}</span>
        </div>
      ))}
    </div>
  );
}
