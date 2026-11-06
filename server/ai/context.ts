import { parseHunks, type DiffFile, type DiffManifest } from '../../shared/diff.js';
import type { FullReviewResult } from '../../shared/ai.js';
import type { ReviewDraft } from '../../shared/review.js';
import type { PullRequestSnapshot, ReviewThread } from '../../shared/types.js';

const BODY_LIMIT = 8_000;
const FILE_LIMIT = 20_000;

const fence = (text: string) => text.replace(/<\/?untrusted_pr_content>/gi, '');

/** Diff lines prefixed with GitHub coordinates (R12 = new line 12, L7 = old line 7). */
export function annotatePatch(patch: string): string {
  const lines: string[] = [];

  for (const hunk of parseHunks(patch)) {
    let oldLine = hunk.oldStart;
    let newLine = hunk.newStart;

    lines.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);

    for (const line of hunk.lines) {
      if (line.startsWith('\\')) continue;

      if (line.startsWith('-')) lines.push(`L${oldLine++} - ${line.slice(1)}`);
      else if (line.startsWith('+')) lines.push(`R${newLine++} + ${line.slice(1)}`);
      else {
        lines.push(`R${newLine}   ${line.slice(1)}`);
        oldLine++;
        newLine++;
      }
    }
  }

  return lines.join('\n');
}

function filesBlock(files: DiffFile[], budget: number): string {
  const parts: string[] = [];
  const skipped: string[] = [];
  let used = 0;

  const ordered = [...files].sort(
    (left, right) => right.additions + right.deletions - (left.additions + left.deletions),
  );

  for (const file of ordered) {
    if (!file.patch || file.generated || file.binary || file.tooLarge) {
      skipped.push(
        `${file.path} (${file.generated ? 'generated' : file.binary ? 'binary' : 'not shown'})`,
      );
      continue;
    }

    let body = annotatePatch(file.patch);

    if (body.length > FILE_LIMIT) body = `${body.slice(0, FILE_LIMIT)}\n[… truncated]`;

    if (used + body.length > budget) {
      skipped.push(`${file.path} (over the size budget)`);
      continue;
    }

    used += body.length;
    parts.push(
      `<file path="${file.path}" status="${file.status}" additions="${file.additions}" deletions="${file.deletions}">\n${fence(body)}\n</file>`,
    );
  }

  return [
    ...parts,
    ...(skipped.length ? [`<omitted_files>\n${skipped.join('\n')}\n</omitted_files>`] : []),
  ].join('\n\n');
}

function header(pr: PullRequestSnapshot): string {
  const body =
    pr.body.length > BODY_LIMIT ? `${pr.body.slice(0, BODY_LIMIT)}\n[… truncated]` : pr.body;

  return [
    `<pull_request repository="${pr.repository}" number="${pr.number}" author="${pr.author.login}" base="${pr.baseRefName}" head="${pr.headRefName}">`,
    `Title: ${fence(pr.title)}`,
    '',
    'Description:',
    fence(body) || '(no description)',
    '</pull_request>',
  ].join('\n');
}

function threadsBlock(threads: ReviewThread[]): string {
  return threads
    .map((thread) => {
      const comments = thread.comments
        .map((comment) => `${comment.author.login}: ${fence(comment.body)}`)
        .join('\n');

      return `<thread id="${thread.id}" path="${thread.path}" line="${thread.line ?? 'outdated'}" resolved="${thread.isResolved}">\n${comments}\n</thread>`;
    })
    .join('\n\n');
}

const wrap = (inner: string) => `<untrusted_pr_content>\n${inner}\n</untrusted_pr_content>`;

export function briefInput(pr: PullRequestSnapshot, diff: DiffManifest): string {
  return wrap(`${header(pr)}\n\n<diff kind="full">\n${filesBlock(diff.files, 160_000)}\n</diff>`);
}

export function fullReviewInput(pr: PullRequestSnapshot, diff: DiffManifest): string {
  return wrap(
    `${header(pr)}\n\nReview the complete PR using review.json, before/ and after/ in the workspace.\n${JSON.stringify({ baseOid: pr.baseOid, headOid: pr.headOid, files: diff.files.map(({ path, status }) => ({ path, status })), threads: pr.threads })}`,
  );
}

export function sinceReviewInput(
  pr: PullRequestSnapshot,
  diff: DiffManifest,
  login: string,
): string {
  const mine = pr.threads.filter((thread) =>
    thread.comments.some((comment) => comment.author.login.toLowerCase() === login.toLowerCase()),
  );
  const note = diff.note ? `Note: ${diff.note}\n` : '';

  return wrap(
    `${header(pr)}\n\n<diff kind="${diff.kind}" from="${diff.fromOid.slice(0, 7)}" to="${diff.toOid.slice(0, 7)}">\n${note}${filesBlock(diff.files, 140_000)}\n</diff>\n\n<threads reviewer="${login}">\n${threadsBlock(mine) || '(none)'}\n</threads>`,
  );
}

export function draftCommentsInput(pr: PullRequestSnapshot, diff: DiffManifest): string {
  return wrap(`${header(pr)}\n\n<diff kind="full">\n${filesBlock(diff.files, 300_000)}\n</diff>`);
}

export function authorFeedbackInput(pr: PullRequestSnapshot): string {
  const verdicts =
    pr.verdicts.map((verdict) => `${verdict.login}: ${verdict.state}`).join('\n') || '(none)';
  const conversation = pr.conversation
    .map((comment) => `${comment.author.login}: ${fence(comment.body)}`)
    .join('\n\n');

  return wrap(
    `${header(pr)}\n\n<verdicts>\n${verdicts}\n</verdicts>\n\n<threads>\n${threadsBlock(pr.threads.filter((thread) => !thread.isResolved)) || '(none)'}\n</threads>\n\n<conversation>\n${conversation || '(none)'}\n</conversation>`,
  );
}

export function draftSummaryInput(
  pr: PullRequestSnapshot,
  diff: DiffManifest,
  draft: ReviewDraft,
  review: Pick<FullReviewResult, 'overall' | 'coverage'> | null,
): string {
  const pending = draft.comments
    .filter((comment) => comment.status !== 'stale')
    .map(
      (comment) =>
        `${comment.path}${comment.line ? `:${comment.line}` : ''}: ${fence(comment.body)}`,
    )
    .join('\n');
  const completed = review
    ? `\n\n<completed_review>\n${fence(JSON.stringify({ overall: review.overall, coverage: review.coverage }))}\n</completed_review>`
    : '';

  return wrap(
    `${header(pr)}\n\n<verdict>${draft.event}</verdict>\n\n<pending_comments>\n${pending || '(none)'}\n</pending_comments>${completed}\n\n<diff kind="full">\n${filesBlock(diff.files, 160_000)}\n</diff>`,
  );
}
