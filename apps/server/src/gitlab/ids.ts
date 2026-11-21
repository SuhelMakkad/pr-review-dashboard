import { ForgeError } from '@/forge/port.js';

/**
 * GitLab objects get ids in the same opaque, URL-safe style as GitHub node ids, carrying what a
 * later REST call needs. Project ids and IIDs are numbers and discussion ids are hex, so `_` never
 * appears inside a part.
 *
 * - `MR_<projectId>_<iid>`: a merge request.
 * - `MRD_<projectId>_<iid>_<discussionId>`: a discussion (review thread) on it.
 * - `MRR_<projectId>_<iid>`: your pending review there, which GitLab keeps as draft notes.
 * - `MRN_<noteId>`: a submitted review, named after its first note or approval.
 */

export interface MergeRequestRef {
  projectId: number;
  iid: number;
}

export const mergeRequestId = (projectId: number, iid: number) => `MR_${projectId}_${iid}`;

export const discussionId = (ref: MergeRequestRef, discussion: string) =>
  `MRD_${ref.projectId}_${ref.iid}_${discussion}`;

export const pendingReviewId = (ref: MergeRequestRef) => `MRR_${ref.projectId}_${ref.iid}`;

export const reviewNoteId = (noteId: number) => `MRN_${noteId}`;

const MERGE_REQUEST = /^MR[R]?_(\d+)_(\d+)$/;
const DISCUSSION = /^MRD_(\d+)_(\d+)_([0-9a-f]+)$/i;

function invalid(kind: string, id: string): ForgeError {
  return new ForgeError(`Not a GitLab ${kind} id: ${id.slice(0, 80)}`, null, 400, 'rejected');
}

/** The merge request behind an `MR_` id or an `MRR_` pending review id. */
export function parseMergeRequestId(id: string): MergeRequestRef {
  const match = MERGE_REQUEST.exec(id);

  if (!match) throw invalid('merge request', id);

  return { projectId: Number(match[1]), iid: Number(match[2]) };
}

export function parseDiscussionId(id: string): MergeRequestRef & { discussion: string } {
  const match = DISCUSSION.exec(id);

  if (!match) throw invalid('discussion', id);

  return { projectId: Number(match[1]), iid: Number(match[2]), discussion: match[3] };
}

export const isPendingReviewId = (id: string) => id.startsWith('MRR_') && MERGE_REQUEST.test(id);

/** `projects/<id>/merge_requests/<iid>`, the REST prefix for everything on one merge request. */
export const mergeRequestPath = (ref: MergeRequestRef) =>
  `projects/${ref.projectId}/merge_requests/${ref.iid}`;

/** A project in a REST path: its numeric id, or its URL-encoded full path (`group/sub/project`). */
export const projectPath = (project: number | string) =>
  `projects/${typeof project === 'number' ? project : encodeURIComponent(project)}`;
