import type { ForgePort } from '@/forge/port.js';

export type {
  BlobText,
  CompareResult,
  DetectOptions,
  DetectResult,
  PinnedFiles,
  RateBudget,
  RemoteFile,
  ResolvedPull,
  ReviewReceipt,
} from '@/forge/types.js';

/** The forge interface under its original name (see `ForgePort`). */
export type GitHubApi = ForgePort;
