import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AiProvider, AiProviderStatus, AiRun, AiSettings, AiTask } from '../../../shared/ai';
import type { DraftComment, ReviewDraft } from '../../../shared/review';
import { api } from '../../lib/api';

export const aiKey = (prId: string) => ['ai', prId] as const;

export function useAiOverview() {
  return useQuery({
    queryKey: ['ai-overview'],
    queryFn: () => api<{ settings: AiSettings; providers: AiProviderStatus[] }>('/api/ai'),
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

  const start = useMutation({
    mutationFn: ({
      task,
      provider,
      force,
    }: {
      task: AiTask;
      provider?: AiProvider;
      force?: boolean;
    }) =>
      api<AiRun>(`/api/pulls/${encodeURIComponent(prId!)}/ai`, {
        method: 'POST',
        body: { account, task, provider, force },
      }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
  });

  const cancel = useMutation({
    mutationFn: (runId: string) =>
      api(`/api/ai/runs/${encodeURIComponent(runId)}`, { method: 'DELETE', body: { account } }),
    onSuccess: () => client.invalidateQueries({ queryKey: key }),
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
    mutationFn: ({ runId, indices }: { runId: string; indices: number[] }) =>
      api<ReviewDraft>(`/api/ai/runs/${encodeURIComponent(runId)}/draft`, {
        method: 'POST',
        body: { account, indices },
      }),
    onSuccess: (draft) => client.setQueryData(['draft', prId], draft),
  });

  const latest = (task: AiTask) => runs.data?.runs.find((run) => run.task === task) ?? null;

  return { runs, start, cancel, accept, prepare, latest };
}
