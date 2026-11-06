import { useState } from 'react';
import { ChartTooltip, niceTicks, useWidth } from './common';

export interface LineSeries {
  name: string;
  color: string;
  points: { x: number; y: number }[];
}

const MARGIN = { top: 14, right: 96, bottom: 24, left: 34 };
const dateLabel = (time: number) =>
  new Date(time).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** 2px lines with ringed end dots, direct end labels, and a crosshair that reads every series. */
export function LineChart({
  series,
  height = 200,
  label,
}: {
  series: LineSeries[];
  height?: number;
  label: string;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const xs = series[0]?.points.map((point) => point.x) ?? [];

  if (xs.length < 2) {
    return (
      <p className="py-8 text-center text-sm text-fg-muted">
        Not enough history yet. Queue sizes are recorded hourly while Review Desk runs.
      </p>
    );
  }

  const max = Math.max(1, ...series.flatMap((line) => line.points.map((point) => point.y)));
  const ticks = niceTicks(max);
  const top = ticks.at(-1)!;
  const plotWidth = width - MARGIN.left - MARGIN.right;
  const plotHeight = height - MARGIN.top - MARGIN.bottom;
  const minX = xs[0];
  const maxX = xs.at(-1)!;
  const x = (value: number) =>
    MARGIN.left + ((value - minX) / Math.max(1, maxX - minX)) * plotWidth;
  const y = (value: number) => MARGIN.top + plotHeight - (value / top) * plotHeight;
  const ends = series.map((line) => y(line.points.at(-1)!.y));
  // Converging end labels would detach from their lines; then the legend and tooltip carry identity.
  const endLabels = ends.every((value, index) =>
    ends.every((other, otherIndex) => otherIndex === index || Math.abs(other - value) >= 14),
  );
  const tickIndexes = [0, 0.25, 0.5, 0.75, 1].map((fraction) =>
    Math.round(fraction * (xs.length - 1)),
  );

  return (
    <div
      ref={ref}
      className="relative"
      onPointerMove={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        const pointer = event.clientX - box.left;
        let nearest = 0;

        xs.forEach((value, index) => {
          if (Math.abs(x(value) - pointer) < Math.abs(x(xs[nearest]) - pointer)) nearest = index;
        });
        setHover(nearest);
      }}
      onPointerLeave={() => setHover(null)}
    >
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        className="block overflow-visible"
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={MARGIN.left}
              x2={MARGIN.left + plotWidth}
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
              {tick}
            </text>
          </g>
        ))}
        {tickIndexes.map((index) => (
          <text
            key={index}
            x={x(xs[index])}
            y={height - 6}
            textAnchor="middle"
            className="fill-fg-subtle text-[10px]"
          >
            {dateLabel(xs[index])}
          </text>
        ))}
        {hover !== null && (
          <line
            x1={x(xs[hover])}
            x2={x(xs[hover])}
            y1={MARGIN.top}
            y2={MARGIN.top + plotHeight}
            stroke="var(--line-strong)"
            strokeWidth={1}
          />
        )}
        {series.map((line) => (
          <g key={line.name}>
            <path
              d={line.points
                .map(
                  (point, index) =>
                    `${index ? 'L' : 'M'}${x(point.x).toFixed(1)},${y(point.y).toFixed(1)}`,
                )
                .join(' ')}
              fill="none"
              stroke={line.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            <circle
              cx={x(line.points.at(-1)!.x)}
              cy={y(line.points.at(-1)!.y)}
              r={4}
              fill={line.color}
              stroke="var(--panel)"
              strokeWidth={2}
            />
            {endLabels && (
              <text
                x={x(line.points.at(-1)!.x) + 8}
                y={y(line.points.at(-1)!.y)}
                dy="0.32em"
                className="fill-fg-muted text-[11px]"
              >
                {line.name} {line.points.at(-1)!.y}
              </text>
            )}
            {hover !== null && (
              <circle
                cx={x(line.points[hover].x)}
                cy={y(line.points[hover].y)}
                r={4}
                fill={line.color}
                stroke="var(--panel)"
                strokeWidth={2}
              />
            )}
          </g>
        ))}
      </svg>
      {hover !== null && (
        <ChartTooltip
          x={x(xs[hover])}
          y={MARGIN.top}
          width={width}
          title={dateLabel(xs[hover])}
          rows={series.map((line) => ({
            label: line.name,
            value: String(line.points[hover].y),
            color: line.color,
          }))}
        />
      )}
    </div>
  );
}
