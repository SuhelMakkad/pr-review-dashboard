import { useEffect, useRef } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiProvider,
  AiProviderStatus,
  AiReviewStatus,
  AiRun,
  AiRunsResponse,
  AiSettings,
  AiTask,
  CodexAccountStatus,
} from '@review-desk/shared/ai';
import type {
  DraftComment,
  PrepareReviewOptions,
  ReviewDraft,
  ReviewEvent,
} from '@review-desk/shared/review';
import { api } from '@/lib/api';
import { accountSwitches } from '@/lib/live';
import { accountPath } from '@/lib/queries';
import { queryKeys } from '@/lib/query-keys';

export const aiReviewsKey = ['ai-reviews'] as const;

export function useAiOverview() {
  return useQuery({
    queryKey: ['ai-overview'],
    queryFn: () =>
      api<{
        settings: AiSettings;
        providers: AiProviderStatus[];
        codex: CodexAccountStatus | null;
      }>('/api/ai'),
    staleTime: 60_000,
  });
}

export function useAiSettings(account: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (settings: AiSettings) =>
      api<AiSettings>('/api/ai/settings', { method: 'PUT', body: { account, settings } }),
    // Turning automatic review off drops pending restarts, which lists and panels show.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['ai-overview'] }),
        client.invalidateQueries({ queryKey: aiReviewsKey }),
        client.invalidateQueries({ queryKey: ['ai'] }),
      ]),
  });
}

/** Automation and posting switches, saved one at a time. */
export type AutomationChanges = Partial<
  Record<'autoReview' | 'postFindings' | 'approveFindings' | 'resolveThreads', boolean>
>;

/**
 * Saves only the switches given: a page holding older settings never turns back on what was
 * turned off elsewhere.
 */
export function useAutomationSettings(account: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (changes: AutomationChanges) =>
      api<AiSettings>('/api/ai/automation', { method: 'PUT', body: { account, changes } }),
    // Turning automatic review off drops pending restarts, which lists and panels show.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['ai-overview'] }),
        client.invalidateQueries({ queryKey: aiReviewsKey }),
        client.invalidateQueries({ queryKey: ['ai'] }),
      ]),
  });
}

/** The latest full review of every tracked PR, keyed by PR id, for list badges. */
export function useAiReviewStatuses(account: string | null | undefined) {
  return useQuery({
    queryKey: [...aiReviewsKey, account],
    queryFn: () =>
      api<{ reviews: AiReviewStatus[] }>(
        `/api/ai/reviews?account=${encodeURIComponent(account ?? '')}`,
      ),
    enabled: Boolean(account),
    select: (data) => new Map(data.reviews.map((review) => [review.prId, review])),
    staleTime: 30_000,
  });
}

/** AI runs for one PR. Live progress arrives over the event stream; a light poll covers gaps. */
export function useAi(prId: string | null, account: string) {
  const client = useQueryClient();
  const key = queryKeys.ai(prId ?? 'none', account);
  const draftKey = queryKeys.draft(account, prId ?? 'none');
  /**
   * Shows the draft a write answered with, unless the account shown changed while it was on its
   * way: every draft was dropped then, to be read afresh, and an older answer must not refill it.
   */
  const seedDraft = (draft: ReviewDraft, since: number) => {
    if (since === accountSwitches()) client.setQueryData(draftKey, draft);
    else void client.invalidateQueries({ queryKey: draftKey });
  };
  const startKey = ['ai-start', account, prId] as const;
  const starts = useMutationState({
    filters: { mutationKey: startKey, exact: true },
    select: (mutation) => ({
      task: (mutation.state.variables as { task: AiTask }).task,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  });
  const prepareKey = ['ai-prepare', account, prId] as const;
  const preparations = useMutationState({
    filters: { mutationKey: prepareKey, exact: true },
    select: (mutation) => ({
      runId: (mutation.state.variables as { runId: string }).runId,
      indices: (mutation.state.variables as { indices: number[] }).indices,
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  });
  const applyKey = ['ai-apply-summary', account, prId] as const;
  const applications = useMutationState({
    filters: { mutationKey: applyKey, exact: true },
    select: (mutation) => ({ status: mutation.state.status, error: mutation.state.error }),
  });
  const controlKey = ['ai-control', account, prId] as const;
  const controls = useMutationState({
    filters: { mutationKey: controlKey, exact: true },
    select: (mutation) => ({
      ...(mutation.state.variables as { runId: string; operation: 'pause' | 'resume' }),
      status: mutation.state.status,
      error: mutation.state.error,
    }),
  });

  const runs = useQuery({
    queryKey: key,
    queryFn: () =>
      api<AiRunsResponse>(
        `/api/pulls/${encodeURIComponent(prId!)}/ai?account=${encodeURIComponent(account)}`,
      ),
    enabled: Boolean(prId && account),
    refetchInterval: (query) =>
      query.state.data?.runs.some((run) => run.status === 'queued' || run.status === 'running')
        ? 2000
        : false,
  });

  const busy = runs.data?.runs.some((run) => run.status === 'queued' || run.status === 'running');
  const wasBusy = useRef(false);

  // A finished run changes the plan's usage, so the Codex status is read again.
  useEffect(() => {
    if (wasBusy.current && !busy) void client.invalidateQueries({ queryKey: ['ai-overview'] });

    wasBusy.current = Boolean(busy);
  }, [busy, client]);

  const start = useMutation({
    mutationKey: startKey,
    mutationFn: async ({
      task,
      provider,
      force,
      draftEvent,
      draftBody,
    }: {
      task: AiTask;
      provider?: AiProvider;
      force?: boolean;
      draftEvent?: ReviewEvent;
      draftBody?: string;
    }) => {
      if (task === 'draft_summary' && draftEvent) {
        const since = accountSwitches();
        const draft = await api<ReviewDraft>(
          accountPath(account, `/pulls/${encodeURIComponent(prId!)}/draft`),
          { method: 'PUT', body: { event: draftEvent, body: draftBody } },
        );

        seedDraft(draft, since);
      }

      return api<AiRun>(`/api/pulls/${encodeURIComponent(prId!)}/ai`, {
        method: 'POST',
        body: { account, task, provider, force },
      });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const cancel = useMutation({
    mutationFn: (runId: string) =>
      api(`/api/ai/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', body: { account } }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const control = useMutation({
    mutationKey: controlKey,
    mutationFn: ({ runId, operation }: { runId: string; operation: 'pause' | 'resume' }) =>
      api(`/api/ai/runs/${encodeURIComponent(runId)}/${operation}`, {
        method: 'POST',
        body: { account },
      }),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  const accept = useMutation({
    mutationFn: ({ runId, index, body }: { runId: string; index: number; body?: string }) =>
      api<DraftComment>(`/api/ai/runs/${encodeURIComponent(runId)}/accept`, {
        method: 'POST',
        body: { account, index, body },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: draftKey }),
  });

  const prepare = useMutation({
    mutationKey: prepareKey,
    mutationFn: ({
      runId,
      ...options
    }: { runId: string; indices: number[] } & PrepareReviewOptions) =>
      api<ReviewDraft>(`/api/ai/runs/${encodeURIComponent(runId)}/draft`, {
        method: 'POST',
        body: { account, ...options },
      }),
    onMutate: () => ({ since: accountSwitches() }),
    onSuccess: (draft, _variables, context) => seedDraft(draft, context.since),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: draftKey }),
      ]),
  });

  const applySummary = useMutation({
    mutationKey: applyKey,
    mutationFn: (runId: string) =>
      api<ReviewDraft>(`/api/ai/runs/${encodeURIComponent(runId)}/summary`, {
        method: 'POST',
        body: { account },
      }),
    onMutate: () => ({ since: accountSwitches() }),
    onSuccess: (draft, _variables, context) => seedDraft(draft, context.since),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  const latest = (task: AiTask) => runs.data?.runs.find((run) => run.task === task) ?? null;
  const completed = (task: AiTask) =>
    runs.data?.runs.find((run) => run.task === task && run.status === 'done') ?? null;
  const startError = (task: AiTask) => starts.filter((state) => state.task === task).at(-1)?.error;
  const isStarting = (task: AiTask) =>
    starts.some((state) => state.task === task && state.status === 'pending') ||
    controls.some(
      (state) =>
        state.operation === 'resume' &&
        state.runId === latest(task)?.id &&
        state.status === 'pending',
    );
  const isRunning = (task: AiTask) => {
    const run = latest(task);

    return isStarting(task) || run?.status === 'queued' || run?.status === 'running';
  };

  return {
    runs,
    /** New commits stopped the automatic review; a fresh one starts at this time. */
    restartAt: runs.data?.restartAt ?? null,
    start,
    cancel,
    pause: (runId: string) => control.mutate({ runId, operation: 'pause' }),
    resume: (runId: string) => control.mutate({ runId, operation: 'resume' }),
    controlError: controls.at(-1)?.error,
    accept,
    prepare,
    preparation: preparations.at(-1),
    applySummary,
    application: applications.at(-1),
    latest,
    completed,
    startError,
    isStarting,
    isRunning,
  };
}
