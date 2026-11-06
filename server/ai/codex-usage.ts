import type { CodexAccountStatus, CodexUsageWindow } from '../../shared/ai.js';

/** The parts of app-server's `account/rateLimits/read` the dashboard relies on (codex-cli 0.153). */
export interface RateLimitWindow {
  usedPercent: number;
  windowDurationMins: number | null;
  /** Unix seconds. */
  resetsAt: number | null;
}

export interface RateLimitSnapshot {
  limitId?: string | null;
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  spendControlReached?: boolean | null;
  planType?: string | null;
  rateLimitReachedType?: string | null;
}

export interface RateLimitsResponse {
  rateLimits: RateLimitSnapshot;
  rateLimitsByLimitId?: Record<string, RateLimitSnapshot | undefined> | null;
  /** Newer CLIs only: false once the plan's included usage is used up. */
  ordinaryUsageAllowed?: boolean | null;
}

export interface CodexAccount {
  type: string;
  planType?: string | null;
}

export interface PlanUsage {
  plan: string | null;
  windows: CodexUsageWindow[];
  limitReached: boolean;
  resetsAt: string | null;
  /** The credit balance, used to measure what a run spent; null when unlimited or unknown. */
  credits: number | null;
}

const planNames: Record<string, string> = {
  free: 'Free',
  go: 'Go',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
  edu: 'Edu',
};

export function planLabel(planType: string | null | undefined): string | null {
  if (!planType || planType === 'unknown') return null;

  return `ChatGPT ${planNames[planType] ?? planType.replaceAll('_', ' ')}`;
}

function windowLabel(minutes: number | null): string {
  if (!minutes) return 'Usage';
  if (minutes === 7 * 24 * 60) return 'Weekly';
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;

  return `${minutes}-minute`;
}

const isoFromSeconds = (seconds: number | null) =>
  seconds ? new Date(seconds < 1e12 ? seconds * 1000 : seconds).toISOString() : null;

/** The Codex bucket: newer CLIs key buckets by limit id, older ones send a single snapshot. */
export function codexSnapshot(response: RateLimitsResponse): RateLimitSnapshot {
  return response.rateLimitsByLimitId?.codex ?? response.rateLimits;
}

/** Applies a sparse `account/rateLimits/updated` snapshot on top of the last full one. */
export function mergeSnapshot(
  last: RateLimitSnapshot,
  update: RateLimitSnapshot,
): RateLimitSnapshot {
  if (update.limitId && last.limitId && update.limitId !== last.limitId) return last;

  const present = Object.entries(update).filter(
    ([, value]) => value !== null && value !== undefined,
  );

  return { ...last, ...Object.fromEntries(present) };
}

export function summariseUsage(
  snapshot: RateLimitSnapshot,
  ordinaryUsageAllowed: boolean | null = null,
): PlanUsage {
  const windows = [snapshot.primary, snapshot.secondary].filter(
    (window): window is RateLimitWindow => Boolean(window),
  );
  const exhausted = windows.filter((window) => window.usedPercent >= 100);
  // Usage resumes only once every exhausted window has reset.
  const resetsAt = exhausted
    .map((window) => window.resetsAt ?? 0)
    .reduce((latest, value) => Math.max(latest, value), 0);
  const balance = Number(snapshot.credits?.balance);

  return {
    plan: planLabel(snapshot.planType),
    windows: windows.map((window) => ({
      label: windowLabel(window.windowDurationMins),
      usedPercent: Math.round(window.usedPercent),
      resetsAt: isoFromSeconds(window.resetsAt),
    })),
    limitReached:
      ordinaryUsageAllowed === false ||
      Boolean(snapshot.rateLimitReachedType) ||
      snapshot.spendControlReached === true ||
      exhausted.length > 0,
    resetsAt: isoFromSeconds(resetsAt || null),
    credits:
      snapshot.credits && !snapshot.credits.unlimited && Number.isFinite(balance) ? balance : null,
  };
}

const resetPhrase = (resetsAt: string | null) =>
  resetsAt
    ? ` until ${new Date(resetsAt).toLocaleString(undefined, {
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })}`
    : '';

export function limitMessage(usage: Pick<PlanUsage, 'resetsAt'>, running = false): string {
  return running
    ? `Your ChatGPT plan's Codex limit ran out during this run, so it was stopped before using credits. Runs are paused${resetPhrase(usage.resetsAt)}.`
    : `Your ChatGPT plan's Codex limit is used up${resetPhrase(usage.resetsAt)}. Not run, so no credits are spent.`;
}

/** Why Codex cannot run on the ChatGPT plan with this sign-in, or null when it can. */
export function accountProblem(account: CodexAccount | null): string | null {
  if (!account) return 'Codex is not signed in. Run `codex login` and sign in with ChatGPT.';

  if (account.type === 'apiKey') {
    return 'Codex is signed in with an API key, which bills API usage. Run `codex login` and sign in with ChatGPT so runs use your plan.';
  }

  if (account.type !== 'chatgpt') {
    return 'Codex is not signed in with ChatGPT. Run `codex login` and sign in with ChatGPT so runs use your plan.';
  }

  return null;
}

export function accountType(account: CodexAccount | null): CodexAccountStatus['type'] {
  if (!account) return null;
  if (account.type === 'chatgpt' || account.type === 'apiKey') return account.type;

  return 'other';
}
