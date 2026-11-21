import { useEffect, useRef } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiProvider, AiSettings, AiTask } from '@review-desk/shared/ai';
import type { DraftComment, PrepareReviewOptions, ReviewDraft } from '@review-desk/shared/review';
import { useDraftWriter } from '@/features/review/use-draft-writer';
import { routes } from '@review-desk/shared/contract';
import { call } from '@/lib/call';
import { queryKeys } from '@/lib/query-keys';

/** Every account's AI runs and latest reviews: settings are shared, and change what they show. */
const isAiQuery = (query: { queryKey: readonly unknown[] }) =>
  query.queryKey[0] === 'account' && ['ai', 'ai-reviews'].includes(String(query.queryKey[2]));

export function useAiOverview() {
  return useQuery({
    queryKey: ['ai-overview'],
    queryFn: ({ signal }) => call(routes.ai, { params: {}, signal }),
    staleTime: 60_000,
  });
}

export function useAiSettings(account: string) {
  const client = useQueryClient();

  return useMutation({
    mutationFn: (settings: AiSettings) =>
      call(routes.aiSettings, { params: {}, body: { account, settings } }),
    // Turning automatic review off drops pending restarts, which lists and panels show.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['ai-overview'] }),
        client.invalidateQueries({ predicate: isAiQuery }),
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
      call(routes.aiAutomation, { params: {}, body: { account, changes } }),
    // Turning automatic review off drops pending restarts, which lists and panels show.
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: ['ai-overview'] }),
        client.invalidateQueries({ predicate: isAiQuery }),
      ]),
  });
}

/** The latest full review of every tracked PR, keyed by PR id, for list badges. */
export function useAiReviewStatuses(account: string | null | undefined) {
  return useQuery({
    queryKey: queryKeys.aiReviews(account ?? null),
    queryFn: ({ signal }) => call(routes.aiReviews, { params: { account: account! }, signal }),
    enabled: Boolean(account),
    select: (data) => new Map(data.reviews.map((review) => [review.prId, review])),
    staleTime: 30_000,
  });
}

/** AI runs for one PR. Live progress arrives over the event stream; a light poll covers gaps. */
export function useAi(prId: string | null, account: string) {
  const client = useQueryClient();
  const key = queryKeys.ai(account, prId ?? 'none');
  const run = (runId: string) => ({ account, runId });
  const pr = { account, id: prId ?? '' };
  const draftKey = queryKeys.draft(account, prId ?? 'none');
  // AI writes to the draft are the PR's writer's, queued with your own and claimed under the PR.
  // The writer seeds the draft each leaves, newer of each part, never across an account switch.
  const writer = useDraftWriter(account, prId ?? 'none', undefined);
  const forPr = prId ? { prId } : {};
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
    queryFn: ({ signal }) => call(routes.aiRuns, { params: pr, signal }),
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
    // Queued at the click, offline too: a summary start captures what is shown then, never text
    // typed while a paused mutation waited.
    networkMode: 'always',
    mutationFn: async ({
      task,
      provider,
      force,
    }: {
      task: AiTask;
      provider?: AiProvider;
      force?: boolean;
    }) => {
      // The summary is written from the verdict and text as you left them: the writer's own job,
      // which saves them first and fences the start on the draft that save left.
      if (task === 'draft_summary')
        return writer.startSummary({
          ...(provider ? { provider } : {}),
          ...(force !== undefined ? { force } : {}),
        });

      return call(routes.startAi, { params: pr, body: { task, provider, force } });
    },
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const cancel = useMutation({
    mutationFn: (runId: string) => call(routes.cancelAi, { params: run(runId), body: {} }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const control = useMutation({
    mutationKey: controlKey,
    mutationFn: ({ runId, operation }: { runId: string; operation: 'pause' | 'resume' }) =>
      (operation === 'pause'
        ? call(routes.pauseAi, { params: run(runId), body: {} })
        : call(routes.resumeAi, { params: run(runId), body: {} })) as Promise<unknown>,
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  const accept = useMutation({
    mutationFn: ({ runId, index, body }: { runId: string; index: number; body?: string }) =>
      writer.write<DraftComment>('acceptAi', run(runId), {
        index,
        ...(body !== undefined ? { body } : {}),
        ...forPr,
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: draftKey }),
  });

  const prepare = useMutation({
    mutationKey: prepareKey,
    mutationFn: ({
      runId,
      ...options
    }: { runId: string; indices: number[] } & PrepareReviewOptions) =>
      writer.write<ReviewDraft>(
        'prepareAi',
        run(runId),
        { ...options, ...forPr },
        { replaces: ['body', 'event'] },
      ),
    onSettled: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: key }),
        client.invalidateQueries({ queryKey: draftKey }),
      ]),
  });

  const applySummary = useMutation({
    mutationKey: applyKey,
    mutationFn: (runId: string) =>
      writer.write<ReviewDraft>('applyAi', run(runId), forPr, { replaces: ['body'] }),
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  const latest = (task: AiTask) => runs.data?.runs.find((run) => run.task === task) ?? null;
  const completed = (task: AiTask) =>
    runs.data?.runs.find((run) => run.task === task && run.status === 'done') ?? null;
  const startError = (task: AiTask) => starts.filter((state) => state.task === task).at(-1)?.error;
  // A summary start is the writer's own job: starting while it is queued or on its way, across a
  // navigation or a reload too. Resuming a paused run starts it as well.
  const isStarting = (task: AiTask) =>
    (task === 'draft_summary'
      ? writer.summaryStarting()
      : starts.some((state) => state.task === task && state.status === 'pending')) ||
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
    /** A restart waits for this account to be in use again. */
    restartPaused: Boolean(runs.data?.restartPaused),
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
