import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { DiffManifest, DiffMode } from '@review-desk/shared/diff';
import type { DraftComment, ReviewDraft, ReviewEvent, Side } from '@review-desk/shared/review';
import { showsViewedTarget, type ViewedTarget } from '@review-desk/shared/operations';
import type { Field } from '@/features/review/draft-writer';
import { newerDraft, useDraftWriter } from '@/features/review/use-draft-writer';
import { ApiError } from '@/lib/api';
import { routes } from '@review-desk/shared/contract';
import { call, command } from '@/lib/call';
import { queryKeys } from '@/lib/query-keys';
import { useOperations } from '@/features/activity/use-operations';

const viewedVersions = new Map<string, number>();

export interface CommentTarget {
  path: string;
  line: number | null;
  side: Side;
  startLine: number | null;
}

/** The diff of `path` that `manifest` renders, as a viewed mark made there names it. */
export function viewedTarget(manifest: DiffManifest, path: string): ViewedTarget | undefined {
  const file = manifest.files.find((candidate) => candidate.path === path);

  if (!manifest.revision || !file) return undefined;

  return { ...manifest.revision, ...(file.viewedKey ? { fileKey: file.viewedKey } : {}) };
}

/** The patch a view renders: its comparison, both sides, and the PR revision it was built from. */
export interface DiffView {
  mode: DiffMode;
  fromOid: string;
  toOid: string;
  headOid: string;
  baseOid: string | null;
}

/**
 * The patch `manifest` renders, or undefined where it cannot say: without a revision, or with
 * patches that could not be confirmed as that revision's (unpinned), its line numbers belong to
 * no known patch.
 */
export function diffView(manifest: DiffManifest | undefined): DiffView | undefined {
  if (!manifest?.revision || manifest.unpinned) return undefined;

  return {
    mode: manifest.mode,
    fromOid: manifest.fromOid,
    toOid: manifest.toOid,
    headOid: manifest.revision.headOid,
    baseOid: manifest.revision.baseOid,
  };
}

/**
 * True when lines picked in `picked.path` of the patch `picked.view` are still those lines in
 * `manifest` showing `path`: another file, comparison, or revision makes them other lines, and
 * lines picked where the view could not say which patch it showed name none.
 */
export function linesShown(
  picked: { path: string; view?: DiffView },
  path: string,
  manifest: DiffManifest | undefined,
): boolean {
  const shown = diffView(manifest);
  const view = picked.view;

  return Boolean(
    view &&
    shown &&
    picked.path === path &&
    view.mode === shown.mode &&
    view.fromOid === shown.fromOid &&
    view.toOid === shown.toOid &&
    view.headOid === shown.headOid &&
    view.baseOid === shown.baseOid,
  );
}

/** False where the view cannot say which diff of `path` it shows, so it cannot be marked viewed. */
export function canMarkViewed(manifest: DiffManifest | undefined, path: string): boolean {
  const file = manifest?.files.find((candidate) => candidate.path === path);

  return Boolean(file) && !(manifest?.keyed && !file?.viewedKey);
}

/** True when `manifest` renders the diff of `path` that `target` names. */
export function viewShows(manifest: DiffManifest, path: string, target: ViewedTarget): boolean {
  const file = manifest.files.find((candidate) => candidate.path === path);

  return Boolean(
    manifest.revision && file && showsViewedTarget(target, manifest.revision, file.viewedKey),
  );
}

/**
 * Everything the workspace writes for one PR of `account`, the account the page shows it for:
 * each request goes to that account's routes, so one sent before a switch is refused rather than
 * made as another account.
 */
export function useReview(prId: string | null, account: string) {
  const client = useQueryClient();
  const pr = { account, id: prId ?? '' };
  const operations = useOperations(account);
  const refreshOperations = () =>
    client.invalidateQueries({ queryKey: queryKeys.operations(account) });

  const draftKey = queryKeys.draft(account, prId ?? 'none');
  const draft = useQuery({
    queryKey: draftKey,
    queryFn: ({ signal }) => call(routes.draft, { params: pr, signal }),
    // Kept the newer of each part as any data is published, a read landing or a write's answer:
    // neither an older read nor an older write ever undoes a newer.
    structuralSharing: (cached, next) =>
      newerDraft(cached as ReviewDraft | undefined, next as ReviewDraft),
    enabled: Boolean(prId && account),
  });
  // Every draft write goes through the PR's writer, in one queue, on the draft you saw. The
  // summary and verdict are edited there too (`writer.edit`), each refused save saying why.
  const writer = useDraftWriter(account, prId ?? 'none', draft.data);

  const refreshDraft = () => client.invalidateQueries({ queryKey: draftKey });

  const addComment = useMutation({
    mutationFn: (
      input: CommentTarget & {
        body: string;
        origin?: 'user' | 'ai';
        revision?: { headOid: string; baseOid: string | null };
      },
    ) => writer.write<DraftComment>('addComment', pr, { ...input }),
    onSuccess: refreshDraft,
  });

  const editComment = useMutation({
    mutationFn: ({ id, body }: { id: string; body: string }) =>
      writer.write<DraftComment>('editComment', { ...pr, cid: id }, { body }),
    onSuccess: refreshDraft,
  });

  const deleteComment = useMutation({
    mutationFn: (id: string) => writer.write<{ ok: true }>('deleteComment', { ...pr, cid: id }, {}),
    onSuccess: refreshDraft,
  });

  const discard = useMutation({
    // None of your summary and verdict is autosaved into the draft it discards; text not saved
    // is kept, unsent, since its cleanup may yet not happen (a cancel in Activity).
    mutationFn: () =>
      writer.command(['body', 'event'], () => command(routes.discard, pr, {}), 'keep'),
    onSuccess: () => {
      void refreshDraft();
      void refreshOperations();
    },
  });

  const submit = useMutation({
    mutationFn: ({
      carried,
      ...input
    }: {
      event: ReviewEvent;
      body: string;
      expectedHeadOid: string;
      allowNewHead?: boolean;
      /** The versions of the summary and verdict sent, as `writer.versions` gave them. */
      carried?: Partial<Record<Field, number>>;
    }) =>
      // Carries the summary and verdict as you left them: none is autosaved into the draft it
      // submits meanwhile, nor, once it was accepted, the versions it carried.
      writer.command(['body', 'event'], () => command(routes.submit, pr, input), 'retire', carried),
    onSettled: refreshDraft,
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: queryKeys.pulls(account) });
      void client.invalidateQueries({ queryKey: queryKeys.diff(account, prId ?? 'none') });
      void refreshOperations();
    },
  });

  const commentNow = useMutation({
    mutationFn: (input: CommentTarget & { body: string; expectedHeadOid: string }) =>
      command(routes.commentNow, pr, { ...input }),
    onSuccess: refreshOperations,
  });

  const reply = useMutation({
    mutationFn: ({ threadId, body }: { threadId: string; body: string }) =>
      command(routes.reply, { account, threadId }, { prId: prId!, body }),
    onSuccess: refreshOperations,
  });

  const resolve = useMutation({
    mutationFn: ({ threadId, resolved }: { threadId: string; resolved: boolean }) =>
      command(routes.resolve, { account, threadId }, { prId: prId!, resolved }),
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
    }) => command(routes.viewed, pr, { path, viewed, ...(target ? { target } : {}) }),
    onMutate: ({ path, viewed, target }) => {
      const versionKey = `${account}:${prId}:${path}`;
      const version = (viewedVersions.get(versionKey) ?? 0) + 1;
      viewedVersions.set(versionKey, version);

      // Only views of the diff the mark names show it early; a newer diff is not marked.
      // This account's views only: the keys name the account they were fetched for.
      const snapshots = client
        .getQueriesData<DiffManifest>({ queryKey: queryKeys.diff(account, prId ?? 'none') })
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
        if (!original) continue;

        // Only while the view still shows the diff the mark named: a view refreshed to a newer
        // diff meanwhile already has that diff's own state.
        client.setQueryData<DiffManifest>(key, (current) =>
          current && (!variables.target || viewShows(current, variables.path, variables.target))
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
    writer,
    addComment,
    editComment,
    deleteComment,
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
