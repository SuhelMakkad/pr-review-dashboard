import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, LoaderCircle, RefreshCw, Table2 } from 'lucide-react';
import type { Insights } from '@review-desk/shared/insights';
import { api } from '@/lib/api';
import { accountPath, useAccount, useForge } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';
import { relativePhrase } from '@/lib/time';
import { Button } from '@/ui/button';
import { cn } from '@/ui/cn';
import { ErrorState } from '@/ui/error-state';
import { ActiveIndicator, Enter, IndicatorGroup } from '@/ui/motion';
import { Skeleton, SkeletonRegion } from '@/ui/skeleton';
import { ColumnChart } from '@/features/insights/charts/column-chart';
import { formatHours, Legend } from '@/features/insights/charts/common';
import { LineChart } from '@/features/insights/charts/line-chart';
import { SegmentedBar } from '@/features/insights/charts/segmented-bar';

interface InsightsResponse {
  insights: Insights | null;
  backfill: {
    doneWindows: string[];
    finishedAt: string | null;
    lastError: string | null;
    running: boolean;
  } | null;
  slaHours: number;
  repositories: string[];
}

const ranges = [7, 30, 90] as const;

function Card({
  title,
  subtitle,
  table,
  children,
  className,
}: {
  title: string;
  subtitle?: string;
  table?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const [showTable, setShowTable] = useState(false);

  return (
    <section
      aria-label={title}
      className={cn('rounded-lg border border-line bg-panel p-4', className)}
    >
      <div className="mb-3 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-fg">{title}</h2>
          {subtitle && <p className="text-xs text-fg-muted">{subtitle}</p>}
        </div>
        {table && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Table2 size={12} />}
            aria-pressed={showTable}
            onClick={() => setShowTable(!showTable)}
          >
            {showTable ? 'Chart' : 'Table'}
          </Button>
        )}
      </div>
      {showTable && table ? table : children}
    </section>
  );
}

function DataTable({ head, rows }: { head: string[]; rows: (string | number)[][] }) {
  return (
    <div className="scroll-thin max-h-64 overflow-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 bg-panel text-fg-muted">
          <tr>
            {head.map((cell, index) => (
              <th
                key={cell}
                className={cn('border-b border-line py-1.5 font-medium', index > 0 && 'text-right')}
              >
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="tabular-nums">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b border-line last:border-0">
              {row.map((cell, index) => (
                <td key={index} className={cn('py-1.5', index > 0 && 'text-right')}>
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Tile({
  label,
  value,
  note,
  tone,
}: {
  label: string;
  value: string;
  note?: string;
  tone?: 'warning';
}) {
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="text-xs text-fg-muted">{label}</div>
      <div className="mt-1 text-xl font-semibold text-fg">{value}</div>
      {note && (
        <div
          className={cn(
            'mt-0.5 flex items-center gap-1 text-xs',
            tone === 'warning' ? 'text-pending' : 'text-fg-subtle',
          )}
        >
          {tone === 'warning' && <AlertTriangle size={11} aria-hidden="true" />}
          {note}
        </div>
      )}
    </div>
  );
}

const shortDate = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** Your review habits over time: speed, volume, verdicts and the queue, from local history. */
export function InsightsPage() {
  const forge = useForge();
  const client = useQueryClient();
  const account = useAccount() ?? '';
  const [days, setDays] = useState<(typeof ranges)[number]>(30);
  const [repo, setRepo] = useState('');
  const query = useQuery({
    queryKey: queryKeys.insights(account, days, repo),
    queryFn: () =>
      api<InsightsResponse>(
        accountPath(
          account,
          `/insights?days=${days}${repo ? `&repo=${encodeURIComponent(repo)}` : ''}`,
        ),
      ),
    enabled: Boolean(account),
    placeholderData: (previous) => previous,
    refetchInterval: (state) => (state.state.data?.backfill?.running ? 3000 : false),
  });
  const backfill = useMutation({
    mutationFn: () => api(accountPath(account, '/insights/backfill'), { method: 'POST', body: {} }),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.insights(account) }),
  });
  const target = useMutation({
    mutationFn: (slaHours: number) =>
      api('/api/insights/settings', { method: 'PUT', body: { account, slaHours } }),
    // Every account's Insights measure against the review target.
    onSuccess: () =>
      client.invalidateQueries({
        predicate: (query) => query.queryKey[0] === 'account' && query.queryKey[2] === 'insights',
      }),
  });
  const data = query.data;
  const insights = data?.insights;
  const turnaround = insights?.turnaround;
  const overTargetShare =
    turnaround && turnaround.count ? Math.round((turnaround.breaches / turnaround.count) * 100) : 0;

  return (
    <div className="scroll-thin h-full overflow-y-auto bg-bg">
      <div className="mx-auto max-w-6xl space-y-4 px-6 py-6">
        <header className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">Insights</h1>
            <p className="text-sm text-fg-muted">
              How quickly you review, how much, and how your queue has changed.
            </p>
          </div>
          <p className="flex items-center gap-2 text-xs text-fg-muted" aria-live="polite">
            {data?.backfill?.running ? (
              <>
                <LoaderCircle size={12} className="animate-spin" aria-hidden="true" /> Reading your
                last 90 days of reviews from {forge.name}…
              </>
            ) : backfill.error ? (
              <span className="text-fail">{backfill.error.message}</span>
            ) : data?.backfill?.lastError ? (
              <span className="text-fail">History is incomplete: {data.backfill.lastError}</span>
            ) : data?.backfill?.finishedAt ? (
              <>History up to date · read {relativePhrase(data.backfill.finishedAt)}</>
            ) : null}
            <Button
              size="sm"
              variant="ghost"
              icon={<RefreshCw size={12} />}
              disabled={data?.backfill?.running || backfill.isPending}
              onClick={() => backfill.mutate()}
            >
              Re-read history
            </Button>
          </p>
        </header>

        <div role="toolbar" aria-label="Filters" className="flex flex-wrap items-center gap-3">
          <IndicatorGroup>
            <div
              role="radiogroup"
              aria-label="Date range"
              className="inline-flex rounded-sm border border-line bg-sunken p-0.5"
            >
              {ranges.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={days === value}
                  onClick={() => setDays(value)}
                  className={cn(
                    'relative h-7 rounded-xs px-3 text-xs transition-colors',
                    days === value ? 'font-medium text-fg' : 'text-fg-muted hover:text-fg',
                  )}
                >
                  {days === value && <ActiveIndicator variant="pill" />}
                  <span className="relative z-10">Last {value} days</span>
                </button>
              ))}
            </div>
          </IndicatorGroup>
          <select
            aria-label="Repository"
            value={repo}
            onChange={(event) => setRepo(event.target.value)}
            className="h-8 rounded-sm border border-line bg-panel px-2 text-xs"
          >
            <option value="">All repositories</option>
            {data?.repositories.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <label className="flex items-center gap-2 text-xs text-fg-muted">
            Review target
            <select
              aria-label="Review target"
              value={data?.slaHours ?? 24}
              onChange={(event) => target.mutate(Number(event.target.value))}
              className="h-8 rounded-sm border border-line bg-panel px-2 text-xs text-fg"
            >
              {[4, 8, 24, 48].map((hours) => (
                <option key={hours} value={hours}>
                  {formatHours(hours)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/* Outline while loading; then the charts, a failure or the first-sync note eases in. */}
        {!insights ? (
          query.isPending ? (
            <InsightsSkeleton />
          ) : query.error ? (
            <Enter key="error" preset="fade" className="grid place-items-center py-10">
              <ErrorState
                title="Could not load insights"
                error={query.error}
                onRetry={() => void query.refetch()}
              />
            </Enter>
          ) : (
            <Enter key="empty" preset="fade">
              <p className="py-16 text-center text-sm text-fg-muted">
                Insights appear after the first sync.
              </p>
            </Enter>
          )
        ) : (
          <Enter key="ready" preset="fade">
            <div
              className={cn(
                'space-y-4 transition-opacity',
                query.isFetching && query.isPlaceholderData && 'opacity-60',
              )}
            >
              <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
                <div className="col-span-2 rounded-lg border border-line bg-panel px-4 py-3 lg:col-span-1">
                  <div className="text-xs text-fg-muted">Median time to review</div>
                  <div className="mt-1 text-5xl font-semibold tracking-tight text-fg">
                    {formatHours(turnaround!.medianHours)}
                  </div>
                  <div className="mt-1 text-xs text-fg-subtle">
                    across {turnaround!.count} review requests
                  </div>
                </div>
                <Tile
                  label="Slowest 10% take"
                  value={formatHours(turnaround!.p90Hours)}
                  note="90th percentile"
                />
                <Tile
                  label="Reviews submitted"
                  value={insights.reviews.total.toLocaleString()}
                  note={`in the last ${insights.range.days} days`}
                />
                <Tile
                  label="Over your target"
                  value={`${overTargetShare}%`}
                  note={`${turnaround!.breaches} took longer than ${formatHours(insights.slaHours)}`}
                  tone={overTargetShare > 25 ? 'warning' : undefined}
                />
                <Tile
                  label="Waiting on you now"
                  value={String(insights.open.count)}
                  note={
                    insights.open.oldestAt
                      ? `oldest asked ${relativePhrase(insights.open.oldestAt)}`
                      : 'nothing outstanding'
                  }
                />
              </div>

              <div className="grid gap-4 lg:grid-cols-2">
                <Card
                  title="Reviews submitted"
                  subtitle={insights.reviews.granularity === 'week' ? 'Per week' : 'Per day'}
                  table={
                    <DataTable
                      head={[
                        insights.reviews.granularity === 'week' ? 'Week of' : 'Day',
                        'Reviews',
                      ]}
                      rows={insights.reviews.series.map((point) => [
                        shortDate(point.start),
                        point.count,
                      ])}
                    />
                  }
                >
                  <ColumnChart
                    label="Reviews submitted over time"
                    columns={insights.reviews.series.map((point) => ({
                      key: point.start,
                      label: shortDate(point.start),
                      value: point.count,
                      color: 'var(--series-1)',
                      detail: `${point.count} ${point.count === 1 ? 'review' : 'reviews'}`,
                    }))}
                  />
                </Card>

                <Card
                  title="Time to review"
                  subtitle={`How long requests waited for your review; target ${formatHours(insights.slaHours)}`}
                  table={
                    <DataTable
                      head={['Waited', 'Requests', 'Over target']}
                      rows={turnaround!.buckets.map((bucket) => [
                        bucket.label,
                        bucket.count,
                        bucket.overTarget ? 'yes' : 'no',
                      ])}
                    />
                  }
                >
                  <ColumnChart
                    label="Distribution of time to review"
                    columns={turnaround!.buckets.map((bucket) => ({
                      key: bucket.label,
                      label: bucket.label,
                      value: bucket.count,
                      color: bucket.overTarget ? 'var(--status-warning)' : 'var(--series-1)',
                      detail: `${bucket.count} ${bucket.count === 1 ? 'request' : 'requests'}${bucket.overTarget ? ' · over target' : ''}`,
                    }))}
                  />
                  <div className="mt-2">
                    <Legend
                      items={[
                        { label: 'Within target', color: 'var(--series-1)', shape: 'rect' },
                        {
                          label: 'Over target',
                          color: 'var(--status-warning)',
                          shape: 'rect',
                          icon: (
                            <AlertTriangle size={11} className="text-pending" aria-hidden="true" />
                          ),
                        },
                      ]}
                    />
                  </div>
                </Card>

                <Card
                  title="Your queue"
                  subtitle="Pull requests needing you vs. waiting on authors, end of each day"
                  table={
                    <DataTable
                      head={['Day', 'Needs attention', 'Waiting on author']}
                      rows={insights.queue.map((point) => [
                        shortDate(point.day),
                        point.attention,
                        point.waiting,
                      ])}
                    />
                  }
                >
                  <LineChart
                    label="Queue size over time"
                    series={[
                      {
                        name: 'Needs you',
                        color: 'var(--series-1)',
                        points: insights.queue.map((point) => ({
                          x: Date.parse(point.day),
                          y: point.attention,
                        })),
                      },
                      {
                        name: 'Waiting',
                        color: 'var(--series-2)',
                        points: insights.queue.map((point) => ({
                          x: Date.parse(point.day),
                          y: point.waiting,
                        })),
                      },
                    ]}
                  />
                  {insights.queue.length >= 2 && (
                    <div className="mt-2">
                      <Legend
                        items={[
                          { label: 'Needs you', color: 'var(--series-1)', shape: 'line' },
                          { label: 'Waiting on author', color: 'var(--series-2)', shape: 'line' },
                        ]}
                      />
                    </div>
                  )}
                </Card>

                <Card
                  title="Your verdicts"
                  subtitle="What your submitted reviews said"
                  table={
                    <DataTable
                      head={['Verdict', 'Reviews']}
                      rows={[
                        ['Approved', insights.verdicts.approved],
                        ['Changes requested', insights.verdicts.changesRequested],
                        ['Commented', insights.verdicts.commented],
                      ]}
                    />
                  }
                >
                  <SegmentedBar
                    label="Review verdicts"
                    segments={[
                      {
                        label: 'Approved',
                        value: insights.verdicts.approved,
                        color: 'var(--series-1)',
                        ink: '#ffffff',
                      },
                      {
                        label: 'Changes requested',
                        value: insights.verdicts.changesRequested,
                        color: 'var(--series-2)',
                        ink: '#ffffff',
                      },
                      {
                        label: 'Commented',
                        value: insights.verdicts.commented,
                        color: 'var(--series-3)',
                        ink: '#ffffff',
                      },
                    ]}
                  />
                </Card>
              </div>

              <div className="grid gap-4 lg:grid-cols-3">
                <Card
                  title="By repository"
                  subtitle="Reviews and time to review"
                  className="lg:col-span-2"
                >
                  {insights.repositories.length ? (
                    <DataTable
                      head={['Repository', 'Reviews', 'Median wait', 'Over target']}
                      rows={insights.repositories.map((row) => [
                        row.repository,
                        row.reviews,
                        formatHours(row.medianHours),
                        row.breaches,
                      ])}
                    />
                  ) : (
                    <p className="text-sm text-fg-muted">No reviews in this range.</p>
                  )}
                </Card>
                <Card title="Your PRs" subtitle="As an author">
                  <dl className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <dt className="text-fg-muted">Opened</dt>
                      <dd className="font-semibold">{insights.authored.opened}</dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-muted">Median wait for a first review</dt>
                      <dd className="font-semibold">
                        {formatHours(insights.authored.medianFirstReviewHours)}
                      </dd>
                    </div>
                    <div className="flex justify-between">
                      <dt className="text-fg-muted">Merged</dt>
                      <dd className="font-semibold">{insights.authored.merged}</dd>
                    </div>
                  </dl>
                </Card>
              </div>
            </div>
          </Enter>
        )}
      </div>
    </div>
  );
}

/** The insights layout in outline: the headline tiles, then two charts. */
function InsightsSkeleton() {
  return (
    <SkeletonRegion label="Loading insights…" className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        {[0, 1, 2, 3, 4].map((index) => (
          <div
            key={index}
            className={cn(
              'space-y-2.5 rounded-lg border border-line bg-panel px-4 py-3',
              index === 0 && 'col-span-2 lg:col-span-1',
            )}
          >
            <Skeleton className="h-3 w-24" />
            <Skeleton className={index === 0 ? 'h-11 w-28' : 'h-7 w-16'} />
            <Skeleton className="h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {[0, 1].map((index) => (
          <div key={index} className="space-y-3 rounded-lg border border-line bg-panel p-4">
            <Skeleton className="h-3.5 w-40" />
            <Skeleton className="h-48 rounded-md" />
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
