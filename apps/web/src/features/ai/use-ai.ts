import { useEffect, useRef } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiProvider, AiSettings, AiTask } from '@review-desk/shared/ai';
import type { PrepareReviewOptions, ReviewDraft, ReviewEvent } from '@review-desk/shared/review';
import { accountSwitches } from '@/lib/live';
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
/**
 * A draft write's answer, which only a write sent with an id could have left pending. These are
 * sent without one, so a pending answer is never expected.
 */
const answered = <T extends object>(answer: T): Exclude<T, { pending: true }> => {
  if ('pending' in answer) throw new Error('The server answered as for a write still in progress.');

  return answer as Exclude<T, { pending: true }>;
};

export function useAi(prId: string | null, account: string) {
  const client = useQueryClient();
  const key = queryKeys.ai(account, prId ?? 'none');
  const run = (runId: string) => ({ account, runId });
  const pr = { account, id: prId ?? '' };
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
        const draft = await call(routes.saveDraft, {
          params: pr,
          body: { event: draftEvent, body: draftBody },
        });

        // Pending only answers a guarded write, which this save is not.
        if (!('pending' in draft)) seedDraft(draft, since);
      }

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
      call(routes.acceptAi, { params: run(runId), body: { index, body } }),
    onSuccess: () => client.invalidateQueries({ queryKey: draftKey }),
  });

  const prepare = useMutation({
    mutationKey: prepareKey,
    mutationFn: ({
      runId,
      ...options
    }: { runId: string; indices: number[] } & PrepareReviewOptions) =>
      call(routes.prepareAi, { params: run(runId), body: options }).then(answered),
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
      call(routes.applyAi, { params: run(runId), body: {} }).then(answered),
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
