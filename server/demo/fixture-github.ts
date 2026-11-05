import type { Actor, PullRequestSnapshot, Source } from '../../shared/types.js';
import type { GitHubApi } from '../github/api.js';
import { GitHubError } from '../github/errors.js';
import type { Scenario } from './scenario.js';

/** A GitHub stand-in backed by an in-memory scenario. Used by demo mode and end-to-end tests. */
export class FixtureGitHub implements GitHubApi {
  private stepIndex = 0;
  scenario: Scenario;

  constructor(private readonly source: Scenario | (() => Scenario)) {
    this.scenario = typeof source === 'function' ? source() : source;
  }

  /** Rebuilds the scenario from scratch (demo reset; requires a factory). */
  reset(): void {
    if (typeof this.source !== 'function') throw new Error('Reset needs a scenario factory.');

    this.scenario = this.source();
    this.stepIndex = 0;
  }

  async identity(): Promise<Actor> {
    return { ...this.scenario.world.viewer };
  }

  async teams(): Promise<string[]> {
    return [...this.scenario.world.teams];
  }

  async discover(_login: string, source: Source): Promise<string[]> {
    return this.scenario.world.pulls
      .filter((pull) => pull.snapshot.state === 'OPEN' && pull.feeds.includes(source))
      .map((pull) => pull.snapshot.id);
  }

  async snapshot(
    id: string,
    _login: string,
    sources: Source[],
    previous?: PullRequestSnapshot,
  ): Promise<PullRequestSnapshot> {
    const pull = this.scenario.world.pulls.find((item) => item.snapshot.id === id);

    if (!pull)
      throw new GitHubError(
        `PR ${previous?.number ?? id} is unavailable; its cached record was retained.`,
      );

    const now = new Date(this.scenario.world.now()).toISOString();
    const snapshot = structuredClone(pull.snapshot);

    return {
      ...snapshot,
      sources,
      fetchedAt: now,
      headObservedAt:
        previous?.headOid === snapshot.headOid
          ? previous.headObservedAt
          : previous
            ? now
            : snapshot.headCommittedAt,
    };
  }

  /** Applies the next scripted change. Returns its label, or null when the script is finished. */
  advance(): string | null {
    const step = this.scenario.steps[this.stepIndex];

    if (!step) return null;

    step.apply(this.scenario.world);
    this.stepIndex += 1;

    return step.label;
  }
}
