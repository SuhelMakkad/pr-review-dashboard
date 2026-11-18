/** A GitLab release, as `GET /version` reports it (`17.8.7-ee` → 17.8). */
export interface GitLabVersion {
  major: number;
  minor: number;
}

export function parseVersion(text: string | null | undefined): GitLabVersion | null {
  const match = /^(\d+)\.(\d+)/.exec(text ?? '');

  return match ? { major: Number(match[1]), minor: Number(match[2]) } : null;
}

const atLeast = (version: GitLabVersion | null, major: number, minor: number) =>
  Boolean(
    version && (version.major > major || (version.major === major && version.minor >= minor)),
  );

/**
 * What publishing a review can carry on this GitLab. Older releases ignore parameters they do not
 * know, so a feature is used only once the release is known to have it; an unknown release has none.
 */
export function reviewFeatures(version: GitLabVersion | null) {
  return {
    // Both arrived in GitLab 19.2; earlier releases ignore them and publish the drafts alone.
    /** `bulk_publish` posts the review summary after the drafts. */
    summary: atLeast(version, 19, 2),
    /** `bulk_publish` sets your reviewer state to reviewed or requested changes. */
    reviewerState: atLeast(version, 19, 2),
  };
}
