import { useState } from 'react';
import { ChartTooltip, niceTicks, useWidth } from './common';

export interface Column {
  key: string;
  label: string;
  value: number;
  color: string;
  /** Tooltip / accessible text, e.g. "4 reviews". */
  detail: string;
}

const MARGIN = { top: 18, right: 8, bottom: 24, left: 34 };

/** Columns with 4px rounded caps from one baseline; the tallest and the latest are labelled. */
export function ColumnChart({
  columns,
  height = 180,
  label,
}: {
  columns: Column[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const max = Math.max(1, ...columns.map((column) => column.value));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const band = plotWidth / Math.max(1, columns.length);
  const barWidth = Math.min(24, Math.max(2, band - 4));
  const y = (value: number) => MARGIN.top + plotHeight - (value / top) * plotHeight;
  const labelEvery = Math.max(1, Math.ceil((columns.length * 44) / plotWidth));
  const tallest = columns.reduce(
    (best, column, index) => (column.value > columns[best].value ? index : best),
    0,
  );
  const labelled = new Set(
    [tallest, columns.length - 1].filter((index) => columns[index]?.value > 0),
  );

  return (
    <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
      <svg
        width={width}
        height={height}
        role="group"
        aria-label={label}
        className="block overflow-visible"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={width - MARGIN.right}
              y1={y(tick)}
              y2={y(tick)}
              stroke={tick === 0 ? 'var(--line-strong)' : 'var(--line)'}
              strokeWidth={1}
            />
            <text
              x={MARGIN.left - 6}
              y={y(tick)}
              dy="0.32em"
              textAnchor="end"
              className="fill-fg-subtle text-[10px] tabular-nums"
            >
              {tick.toLocaleString()}
            </text>
          </g>
        ))}
        {columns.map((column, index) => {
          const x = MARGIN.left + index * band + (band - barWidth) / 2;
          const barTop = y(column.value);
          const base = y(0);
          const radius = Math.min(4, barWidth / 2, base - barTop);

          return (
            <g
              key={column.key}
              tabIndex={0}
              role="img"
              aria-label={`${column.label}: ${column.detail}`}
              onPointerEnter={() => setActive(index)}
              onFocus={() => setActive(index)}
              onBlur={() => setActive(null)}
              className="outline-none"
            >
              <rect
                x={MARGIN.left + index * band}
                y={MARGIN.top}
                width={band}
                height={plotHeight}
                fill="transparent"
              />
              {column.value > 0 && (
                <path
                  d={`M${x},${base} V${barTop + radius} Q${x},${barTop} ${x + radius},${barTop} H${x + barWidth - radius} Q${x + barWidth},${barTop} ${x + barWidth},${barTop + radius} V${base} Z`}
                  fill={column.color}
                  opacity={active === null || active === index ? 1 : 0.55}
                />
              )}
              {labelled.has(index) && (
                <text
                  x={x + barWidth / 2}
                  y={barTop - 5}
                  textAnchor="middle"
                  className="fill-fg-muted text-[10px] font-medium tabular-nums"
                >
                  {column.value.toLocaleString()}
                </text>
              )}
              {index % labelEvery === 0 && (
                <text
                  x={x + barWidth / 2}
                  y={height - 6}
                  textAnchor="middle"
                  className="fill-fg-subtle text-[10px]"
                >
                  {column.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {active !== null && columns[active] && (
        <ChartTooltip
          x={MARGIN.left + active * band + band / 2}
          y={y(columns[active].value)}
          width={width}
          title={columns[active].label}
          rows={[{ label: '', value: columns[active].detail, color: columns[active].color }]}
        />
      )}
    </div>
  );
}
