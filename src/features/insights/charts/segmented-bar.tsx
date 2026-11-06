import { useState } from 'react';
import { ChartTooltip, Legend, useWidth } from './common';

export interface Segment {
  label: string;
  value: number;
  color: string;
  /** Ink for a share printed inside the block. */
  ink: string;
}

const HEIGHT = 28;
const GAP = 2;

/** One whole split into parts: 28px blocks with 2px gaps, shares inside where they fit. */
export function SegmentedBar({ segments, label }: { segments: Segment[]; label: string }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const visible = segments.filter((segment) => segment.value > 0);
  const usable = width - GAP * Math.max(0, visible.length - 1);
  let cursor = 0;

  if (total === 0)
    return <p className="py-6 text-center text-sm text-fg-muted">No reviews in this range.</p>;

  return (
    <div className="space-y-2">
      <div ref={ref} className="relative" onPointerLeave={() => setActive(null)}>
        <svg width={width} height={HEIGHT} role="group" aria-label={label} className="block">
          {segments.map((segment, index) => {
            if (segment.value === 0) return null;

            const blockWidth = (segment.value / total) * usable;
            const x = cursor;
            const share = `${Math.round((segment.value / total) * 100)}%`;

            cursor += blockWidth + GAP;

            return (
              <g
                key={segment.label}
                tabIndex={0}
                role="img"
                aria-label={`${segment.label}: ${segment.value} (${share})`}
                onPointerEnter={() => setActive(index)}
                onFocus={() => setActive(index)}
                onBlur={() => setActive(null)}
                className="outline-none"
              >
                <rect
                  x={x}
                  y={0}
                  width={blockWidth}
                  height={HEIGHT}
                  rx={4}
                  fill={segment.color}
                  opacity={active === null || active === index ? 1 : 0.6}
                />
                {share.length * 7 + 16 < blockWidth && (
                  <text
                    x={x + 8}
                    y={HEIGHT / 2}
                    dy="0.34em"
                    fill={segment.ink}
                    className="text-[11px] font-semibold"
                  >
                    {share}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {active !== null && (
          <ChartTooltip
            x={
              (segments.slice(0, active).reduce((sum, segment) => sum + segment.value, 0) / total) *
              width
            }
            y={HEIGHT + 6}
            width={width}
            title={segments[active].label}
            rows={[
              {
                label: `${Math.round((segments[active].value / total) * 100)}% of reviews`,
                value: String(segments[active].value),
                color: segments[active].color,
              },
            ]}
          />
        )}
      </div>
      <Legend
        items={segments.map((segment) => ({
          label: segment.label,
          color: segment.color,
          shape: 'rect',
        }))}
      />
    </div>
  );
}
