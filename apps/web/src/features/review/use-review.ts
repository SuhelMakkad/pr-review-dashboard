import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiffManifest } from '@review-desk/shared/diff';
import type { DraftComment, ReviewDraft, ReviewEvent, Side } from '@review-desk/shared/review';
import {
  showsViewedTarget,
  type OperationReceipt,
  type ViewedTarget,
} from '@review-desk/shared/operations';
import { api, ApiError } from '@/lib/api';
import { cacheBelongsTo } from '@/lib/live';
import { queryKeys } from '@/lib/query-keys';
import { githubCommand } from '@/lib/operation-command';
import { useOperations } from '@/features/activity/use-operations';

const viewedVersions = new Map<string, number>();

export interface CommentTarget {
  path: string;
  line: number | null;
  side: Side;
  startLine: number | null;
}

/** Everything the workspace writes, each scoped to one PR and the active account. */
/** The diff of `path` that `manifest` renders, as a viewed mark made there names it. */
export function viewedTarget(manifest: DiffManifest, path: string): ViewedTarget | undefined {
  const file = manifest.files.find((candidate) => candidate.path === path);

  if (!manifest.revision || !file) return undefined;

  return { ...manifest.revision, ...(file.viewedKey ? { fileKey: file.viewedKey } : {}) };
}

/** True when `manifest` renders the diff of `path` that `target` names. */
export function viewShows(manifest: DiffManifest, path: string, target: ViewedTarget): boolean {
  const file = manifest.files.find((candidate) => candidate.path === path);

  return Boolean(
    manifest.revision && file && showsViewedTarget(target, manifest.revision, file.viewedKey),
  );
}

export function useReview(prId: string | null, account: string) {
  const client = useQueryClient();
  const enc = encodeURIComponent(prId ?? '');
  const operations = useOperations(account);
  const refreshOperations = () => client.invalidateQueries({ queryKey: ['operations', account] });

  const draft = useQuery({
    queryKey: queryKeys.draft(prId ?? 'none', account),
    queryFn: () =>
      api<ReviewDraft>(`/api/pulls/${enc}/draft?account=${encodeURIComponent(account)}`),
    enabled: Boolean(prId && account),
  });

  const refreshDraft = () =>
    client.invalidateQueries({ queryKey: queryKeys.draft(prId ?? 'none', account) });

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
    // Refetch rather than applying an old autosave response over a newly queued/finished review.
    onSuccess: refreshDraft,
  });

  const discard = useMutation({
    mutationFn: () =>
      githubCommand<OperationReceipt | { ok: true }>(
        `/api/pulls/${enc}/draft`,
        { account },
        'DELETE',
      ),
    onSuccess: () => {
      void refreshDraft();
      void refreshOperations();
    },
  });

  const submit = useMutation({
    mutationFn: (input: {
      event: ReviewEvent;
      body: string;
      expectedHeadOid: string;
      allowNewHead?: boolean;
    }) => githubCommand(`/api/pulls/${enc}/review`, { account, ...input }),
    onSettled: refreshDraft,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.pulls });
      void client.invalidateQueries({ queryKey: ['diff', prId] });
      void refreshOperations();
    },
  });

  const commentNow = useMutation({
    mutationFn: (input: CommentTarget & { body: string; expectedHeadOid: string }) =>
      githubCommand(`/api/pulls/${enc}/comments`, { account, ...input }),
    onSuccess: refreshOperations,
  });

  const reply = useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      githubCommand(`/api/threads/${encodeURIComponent(threadId)}/replies`, {
        account,
        prId,
        body,
      }),
    onSuccess: refreshOperations,
  });

  const resolve = useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      githubCommand(`/api/threads/${encodeURIComponent(threadId)}/resolution`, {
        account,
        prId,
        resolved,
      }),
    onSuccess: refreshOperations,
  });

  /**
   * Optimistic: the tree and progress update before GitHub confirms. Diffs carry the viewer's own
   * viewed state under keys both accounts share, so nothing is written once another account shows.
   */
  const setViewed = useMutation({
    mutationFn: ({
      path,
      viewed,
      target,
    }: {
      path: string;
      viewed: boolean;
      target?: ViewedTarget;
    }) =>
      githubCommand(`/api/pulls/${enc}/viewed`, {
        account,
        path,
        viewed,
        ...(target ? { target } : {}),
      }),
    onMutate: ({ path, viewed, target }) => {
      const versionKey = `${account}:${prId}:${path}`;
      const version = (viewedVersions.get(versionKey) ?? 0) + 1;
      viewedVersions.set(versionKey, version);

      // Only views of the diff the mark names show it early; a newer diff is not marked.
      const snapshots = client
        .getQueriesData<DiffManifest>({ queryKey: ['diff', prId] })
        .filter(([key]) => cacheBelongsTo(client, account, key))
        .filter(([, manifest]) => !target || !manifest || viewShows(manifest, path, target));

      for (const [key, manifest] of snapshots) {
        if (!manifest) continue;

        client.setQueryData<DiffManifest>(key, {
          ...manifest,
          files: manifest.files.map((file) =>
            file.path === path ? { ...file, viewed: viewed ? 'VIEWED' : 'UNVIEWED' } : file,
          ),
        });
      }

      return { snapshots, version, versionKey };
    },
    onError: (_error, variables, context) => {
      if (!context || viewedVersions.get(context.versionKey) !== context.version) return;
      for (const [key, manifest] of context.snapshots) {
        const original = manifest?.files.find((file) => file.path === variables.path);
        if (!original || !cacheBelongsTo(client, account, key)) continue;

        client.setQueryData<DiffManifest>(key, (current) =>
          current
            ? {
                ...current,
                files: current.files.map((file) =>
                  file.path === variables.path ? { ...file, viewed: original.viewed } : file,
                ),
              }
            : current,
        );
      }
    },
    onSuccess: refreshOperations,
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
    operations:
      operations.data?.pages
        .flatMap((page) => page.items)
        .filter((operation) => operation.prId === prId) ?? [],
    allOperations: operations.data?.pages.flatMap((page) => page.items) ?? [],
  };
}

export const errorCode = (error: unknown) => (error instanceof ApiError ? error.code : undefined);
