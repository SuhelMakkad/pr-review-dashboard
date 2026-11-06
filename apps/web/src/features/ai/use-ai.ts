import { useEffect, useRef } from 'react';
import { useMutation, useMutationState, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AiProvider,
  AiProviderStatus,
  AiRun,
  AiSettings,
  AiTask,
  CodexAccountStatus,
} from '../../../../../packages/shared/src/ai';
import type { DraftComment, ReviewDraft, ReviewEvent } from '../../../../../packages/shared/src/review';
import { api } from '../../lib/api';

export const aiKey = (prId: string) => ['ai', prId] as const;

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
    onSuccess: () => client.invalidateQueries({ queryKey: ['ai-overview'] }),
  });
}

/** AI runs for one PR. Live progress arrives over the event stream; a light poll covers gaps. */
export function useAi(prId: string | null, account: string) {
  const client = useQueryClient();
  const key = aiKey(prId ?? 'none');
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
      api<{ runs: AiRun[] }>(
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
        const draft = await api<ReviewDraft>(`/api/pulls/${encodeURIComponent(prId!)}/draft`, {
          method: 'PUT',
          body: { account, event: draftEvent, body: draftBody },
        });

        client.setQueryData(['draft', prId], draft);
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
    onSuccess: () => client.invalidateQueries({ queryKey: ['draft', prId] }),
  });

  const prepare = useMutation({
    mutationKey: prepareKey,
    mutationFn: ({ runId, indices }: { runId: string; indices: number[] }) =>
      api<ReviewDraft>(`/api/ai/runs/${encodeURIComponent(runId)}/draft`, {
        method: 'POST',
        body: { account, indices },
      }),
    onSuccess: (draft) => {
      client.setQueryData(['draft', prId], draft);
    },
    onSettled: () => client.invalidateQueries({ queryKey: key }),
  });

  const applySummary = useMutation({
    mutationKey: applyKey,
    mutationFn: (runId: string) =>
      api<ReviewDraft>(`/api/ai/runs/${encodeURIComponent(runId)}/summary`, {
        method: 'POST',
        body: { account },
      }),
    onSuccess: (draft) => client.setQueryData(['draft', prId], draft),
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
