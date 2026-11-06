import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiffManifest } from '../../../shared/diff';
import type {
  DraftComment,
  ReviewDraft,
  ReviewEvent,
  Side,
  SubmitReviewResult,
} from '../../../shared/review';
import { api, ApiError } from '../../lib/api';
import { queryKeys } from '../../lib/query-keys';

export const draftKey = (prId: string) => ['draft', prId] as const;

export interface CommentTarget {
  path: string;
  line: number | null;
  side: Side;
  startLine: number | null;
}

/** Everything the workspace writes, each scoped to one PR and the active account. */
export function useReview(prId: string | null, account: string) {
  const client = useQueryClient();
  const enc = encodeURIComponent(prId ?? '');

  const draft = useQuery({
    queryKey: draftKey(prId ?? 'none'),
    queryFn: () =>
      api<ReviewDraft>(`/api/pulls/${enc}/draft?account=${encodeURIComponent(account)}`),
    enabled: Boolean(prId && account),
  });

  const refreshDraft = () => client.invalidateQueries({ queryKey: draftKey(prId ?? 'none') });

  const addComment = useMutation({
    mutationFn: (input: CommentTarget & { body: string; origin?: 'user' | 'ai' }) =>
      api<DraftComment>(`/api/pulls/${enc}/draft/comments`, {
        method: 'POST',
        body: { account, ...input },
      }),
    onSuccess: refreshDraft,
  });

  const editComment = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      api<DraftComment>(`/api/pulls/${enc}/draft/comments/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        body: { account, body },
      }),
    onSuccess: refreshDraft,
  });

  const deleteComment = useMutation({
    mutationFn: (id: string) =>
      api(`/api/pulls/${enc}/draft/comments/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        body: { account },
      }),
    onSuccess: refreshDraft,
  });

  const saveMeta = useMutation({
    mutationFn: (changes: { body?: string; event?: ReviewEvent }) =>
      api<ReviewDraft>(`/api/pulls/${enc}/draft`, { method: 'PUT', body: { account, ...changes } }),
    onSuccess: (next) => client.setQueryData(draftKey(prId ?? 'none'), next),
  });

  const discard = useMutation({
    mutationFn: () => api(`/api/pulls/${enc}/draft`, { method: 'DELETE', body: { account } }),
    onSuccess: refreshDraft,
  });

  const submit = useMutation({
    mutationFn: (input: {
      event: ReviewEvent;
      body: string;
      expectedHeadOid: string;
      allowNewHead?: boolean;
    }) =>
      api<SubmitReviewResult>(`/api/pulls/${enc}/review`, {
        method: 'POST',
        body: { account, ...input },
      }),
    onSettled: refreshDraft,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.pulls });
      void client.invalidateQueries({ queryKey: ['diff', prId] });
    },
  });

  const commentNow = useMutation({
    mutationFn: (input: CommentTarget & { body: string }) =>
      api<{ url: string }>(`/api/pulls/${enc}/comments`, {
        method: 'POST',
        body: { account, ...input },
      }),
  });

  const reply = useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      api<{ url: string; pending: boolean }>(
        `/api/threads/${encodeURIComponent(threadId)}/replies`,
        {
          method: 'POST',
          body: { account, prId, body },
        },
      ),
  });

  const resolve = useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      api(`/api/threads/${encodeURIComponent(threadId)}/resolution`, {
        method: 'POST',
        body: { account, prId, resolved },
      }),
  });

  /** Optimistic: the tree and progress update before GitHub confirms. */
  const setViewed = useMutation({
    mutationFn: ({ path, viewed }: { path: string; viewed: boolean }) =>
      api(`/api/pulls/${enc}/viewed`, { method: 'POST', body: { account, path, viewed } }),
    onMutate: ({ path, viewed }) => {
      const snapshots = client.getQueriesData<DiffManifest>({ queryKey: ['diff', prId] });

      for (const [key, manifest] of snapshots) {
        if (!manifest) continue;

        client.setQueryData<DiffManifest>(key, {
          ...manifest,
          files: manifest.files.map((file) =>
            file.path === path ? { ...file, viewed: viewed ? 'VIEWED' : 'UNVIEWED' } : file,
          ),
        });
      }

      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      for (const [key, manifest] of context?.snapshots ?? []) client.setQueryData(key, manifest);
    },
  });

  return {
    draft,
    addComment,
    editComment,
    deleteComment,
    saveMeta,
    discard,
    submit,
    commentNow,
    reply,
    resolve,
    setViewed,
  };
}

export const errorCode = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
