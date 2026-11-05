import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowDownWideNarrow,
  ArrowUpRight,
  CheckCheck,
  CircleAlert,
  Clock3,
  Command,
  Github,
  GitPullRequest,
  Inbox,
  Layers3,
  LoaderCircle,
  LockKeyhole,
  Monitor,
  Moon,
  RefreshCw,
  Search,
  SlidersHorizontal,
  Sun,
  X,
} from 'lucide-react';
import type { AttentionKind, CiState, PullRequestList, Queue, SyncStatus } from '../shared/types';
import { api, dateTime, relativeTime } from './api';
import { CiBadge, ReasonBadges } from './components';
import { Detail, reviewLabels } from './Detail';

const views: { id: Queue; label: string; icon: typeof Inbox }[] = [
  { id: 'attention', label: 'Needs attention', icon: Inbox },
  { id: 'waiting', label: 'Waiting on author', icon: Clock3 },
  { id: 'caught_up', label: 'Caught up', icon: CheckCheck },
  { id: 'snoozed', label: 'Snoozed', icon: Clock3 },
  { id: 'all', label: 'All tracked', icon: Layers3 },
];
const reasonLabels: Record<AttentionKind, string> = {
  first_review: 'First review',
  changed: 'Changed since review',
  requested_again: 'Requested again',
  reply: 'New replies',
  dismissed: 'Review dismissed',
};

export function App() {
  const client = useQueryClient();
  const [view, setView] = useState<Queue>('attention');
  const [search, setSearch] = useState('');
  const [repository, setRepository] = useState('');
  const [author, setAuthor] = useState('');
  const [reason, setReason] = useState('');
  const [ci, setCi] = useState('');
  const [drafts, setDrafts] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [theme, setTheme] = useState(() => localStorage.getItem('review-desk-theme') ?? 'system');
  const searchRef = useRef<HTMLInputElement>(null);
  const initialized = useRef<string | null>(null);
  const status = useQuery({
    queryKey: ['status'],
    queryFn: () => api<SyncStatus>('/api/status'),
    refetchInterval: 3000,
  });
  const pulls = useQuery({
    queryKey: ['pulls'],
    queryFn: () => api<PullRequestList>('/api/pulls'),
    refetchInterval: 5000,
  });
  const sync = useMutation({
    mutationFn: () => api<SyncStatus>('/api/sync', {}),
    onSuccess: () => {
      void client.invalidateQueries({ queryKey: ['status'] });
    },
  });
  const items = pulls.data?.items ?? [];
  const account = pulls.data?.account ?? null;
  const state = status.data;
  const counts = Object.fromEntries(
    views.map((item) => [
      item.id,
      item.id === 'all'
        ? items.length
        : items.filter((pr) => pr.queue === item.id && (item.id !== 'caught_up' || !pr.isDraft))
            .length,
    ]),
  ) as Record<Queue, number>;
  const followUps = items.filter(
    (pr) => pr.queue === 'attention' && pr.reasons.some((signal) => signal.kind !== 'first_review'),
  ).length;
  const firstReviews = items.filter(
    (pr) => pr.queue === 'attention' && pr.reasons.some((signal) => signal.kind === 'first_review'),
  ).length;
  const repositories = [...new Set(items.map((pr) => pr.repository))].sort();
  const authors = [...new Set(items.map((pr) => pr.author.login))].sort();
  const filtered = items.filter(
    (pr) =>
      (view === 'all' || (pr.queue === view && !(view === 'caught_up' && pr.isDraft))) &&
      (!search ||
        `${pr.title} ${pr.number} ${pr.repository} ${pr.author.login}`
          .toLowerCase()
          .includes(search.toLowerCase())) &&
      (!repository || pr.repository === repository) &&
      (!author || pr.author.login === author) &&
      (!reason || pr.reasons.some((signal) => signal.kind === reason)) &&
      (!ci || pr.ci === ci) &&
      (!drafts || (drafts === 'only' ? pr.isDraft : !pr.isDraft)),
  );
  const filterCount = [repository, author, reason, ci, drafts].filter(Boolean).length;
  const stale =
    state &&
    (Boolean(state.error) ||
      state.warnings.length > 0 ||
      (!state.syncing && !state.lastSuccessfulSync) ||
      Boolean(
        state.lastSuccessfulSync && Date.now() - Date.parse(state.lastSuccessfulSync) > 150_000,
      ));

  useEffect(() => {
    if (account && initialized.current !== account && pulls.data?.items.length) {
      setSelected(pulls.data?.items.find((pr) => pr.queue === 'attention')?.id ?? null);
      initialized.current = account;
      setRepository('');
      setAuthor('');
    }
  }, [account, pulls.data]);

  useEffect(() => {
    if (selected && pulls.data && !pulls.data.items.some((pr) => pr.id === selected))
      setSelected(null);
  }, [pulls.data, selected]);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => {
      document.documentElement.dataset.theme =
        theme === 'system' ? (media.matches ? 'dark' : 'light') : theme;
    };

    localStorage.setItem('review-desk-theme', theme);
    update();
    media.addEventListener('change', update);

    return () => media.removeEventListener('change', update);
  }, [theme]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === 'Escape') {
        setSelected(null);
        searchRef.current?.blur();
      }
    };

    window.addEventListener('keydown', onKey);

    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const changeView = (next: Queue) => {
    setView(next);
    setSelected(null);
  };
  const clearFilters = () => {
    setRepository('');
    setAuthor('');
    setReason('');
    setCi('');
    setDrafts('');
    setSearch('');
  };
  const today = new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(new Date());

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="wordmark" href="/" aria-label="Review Desk home">
          <span className="brand-icon">
            <GitPullRequest size={21} strokeWidth={2} />
          </span>
          <span>
            Review Desk<span className="brand-subtitle">YOUR LOCAL WORKSPACE</span>
          </span>
        </a>
        <div className="workspace">
          <div className="workspace-avatar">
            {(state?.account?.login ?? 'GH').slice(0, 2).toUpperCase()}
          </div>
          <div>
            <strong>{state?.account?.login ?? 'Connecting…'}</strong>
            <span>Personal workspace</span>
          </div>
          <LockKeyhole size={13} />
        </div>
        <div className="nav-label">REVIEWS</div>
        <nav aria-label="Review queues">
          {views.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={`nav-item ${view === id ? 'active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => changeView(id)}
            >
              <Icon size={17} />
              <span>{label}</span>
              <span className="nav-count">{counts[id]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-card">
            <span className="local-indicator">
              <span /> LOCAL ONLY
            </span>
            <p>Your reviews, a little clearer.</p>
            <span>Private notes stay on this device.</span>
          </div>
          <div className="theme-switch" role="group" aria-label="Color theme">
            {[
              { value: 'light', icon: Sun, title: 'Light theme' },
              { value: 'system', icon: Monitor, title: 'System theme' },
              { value: 'dark', icon: Moon, title: 'Dark theme' },
            ].map(({ value, icon: Icon, title }) => (
              <button
                key={value}
                aria-label={title}
                aria-pressed={theme === value}
                className={theme === value ? 'active' : ''}
                onClick={() => setTheme(value)}
              >
                <Icon size={15} />
              </button>
            ))}
          </div>
          <div className="sidebar-footer">
            <Github size={14} />
            <span>Connected with GitHub CLI</span>
          </div>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div>
            <span className="breadcrumb">Workspace</span>
            <span className="breadcrumb-slash">/</span>
            <strong>Overview</strong>
          </div>
          <div className="topbar-right">
            <span className="read-only">
              <LockKeyhole size={12} />
              Read-only GitHub access
            </span>
            <a href="https://github.com/pulls/review-requested" target="_blank" rel="noreferrer">
              GitHub <ArrowUpRight size={14} />
            </a>
          </div>
        </header>
        <div className="page-content">
          <section className="page-heading">
            <div>
              <div className="eyebrow">{today}</div>
              <h1>
                Your review workspace<span>.</span>
              </h1>
              <p>Know what needs a first look, a second pass, or a little patience.</p>
            </div>
            <button
              className="button refresh-button"
              disabled={
                state?.syncing ||
                sync.isPending ||
                Boolean(state?.retryAt && Date.parse(state.retryAt) > Date.now())
              }
              onClick={() => sync.mutate()}
            >
              <RefreshCw size={15} className={state?.syncing ? 'spinning' : ''} />
              {state?.syncing ? 'Syncing…' : 'Sync now'}
            </button>
          </section>
          <section className="stats-grid" aria-label="Review overview">
            <button
              className={`stat-card attention-card ${view === 'attention' ? 'chosen' : ''}`}
              onClick={() => changeView('attention')}
            >
              <div className="stat-top">
                <span>Needs your attention</span>
                <span className="stat-icon amber">
                  <Inbox size={18} />
                </span>
              </div>
              <div className="stat-number">
                {counts.attention}
                <span>open {counts.attention === 1 ? 'PR' : 'PRs'}</span>
              </div>
              <div className="stat-foot">
                <span className="mini-dot amber" />
                {firstReviews} first {firstReviews === 1 ? 'review' : 'reviews'}
                <span className="stat-separator">·</span>
                {followUps} follow-ups
                <ArrowUpRight size={14} />
              </div>
            </button>
            <button
              className={`stat-card ${view === 'waiting' ? 'chosen' : ''}`}
              onClick={() => changeView('waiting')}
            >
              <div className="stat-top">
                <span>Waiting on author</span>
                <span className="stat-icon blue">
                  <Clock3 size={18} />
                </span>
              </div>
              <div className="stat-number">
                {counts.waiting}
                <span>open {counts.waiting === 1 ? 'PR' : 'PRs'}</span>
              </div>
              <div className="stat-foot">
                <span className="mini-dot blue" />
                Changes requested, next move is theirs
                <ArrowUpRight size={14} />
              </div>
            </button>
            <button
              className={`stat-card ${view === 'caught_up' ? 'chosen' : ''}`}
              onClick={() => changeView('caught_up')}
            >
              <div className="stat-top">
                <span>You’re caught up</span>
                <span className="stat-icon green">
                  <CheckCheck size={18} />
                </span>
              </div>
              <div className="stat-number">
                {counts.caught_up}
                <span>open {counts.caught_up === 1 ? 'PR' : 'PRs'}</span>
              </div>
              <div className="stat-foot">
                <span className="mini-dot green" />
                Reviewed, with no new follow-up
                <ArrowUpRight size={14} />
              </div>
            </button>
          </section>
          {(status.error || pulls.error || sync.error) && (
            <div className="error-banner" role="alert">
              <CircleAlert size={17} />
              <span>
                {status.error?.message ?? pulls.error?.message ?? sync.error?.message} Check that
                the local API is running.
              </span>
            </div>
          )}
          {stale && (
            <div className="error-banner" role="status">
              <CircleAlert size={17} />
              <div>
                <strong>{state?.error ? 'Showing saved data' : 'Coverage needs a check'}</strong>
                <p>
                  {state?.error ?? 'Some GitHub data could not be refreshed completely.'}
                  {state?.retryAt && ` Retry after ${dateTime(state.retryAt)}.`}
                </p>
                {state?.warnings.length ? (
                  <details>
                    <summary>
                      {state.warnings.length} sync{' '}
                      {state.warnings.length === 1 ? 'warning' : 'warnings'}
                    </summary>
                    <ul>
                      {state.warnings.map((warning, index) => (
                        <li key={index}>{warning}</li>
                      ))}
                    </ul>
                  </details>
                ) : null}
                {state?.error && <code>gh auth status · gh auth login</code>}
              </div>
            </div>
          )}
          <section className="review-workspace" aria-label="Tracked pull requests">
            <div className="list-heading">
              <div>
                <h2>
                  {views.find((item) => item.id === view)?.label}
                  <span>{filtered.length}</span>
                </h2>
                <p>
                  {view === 'attention'
                    ? 'Follow-ups first. Oldest pending activity at the top.'
                    : view === 'waiting'
                      ? 'Your feedback is with the author. We’ll surface the next update.'
                      : view === 'caught_up'
                        ? 'Reviewed and quiet. New commits and replies will bring them back.'
                        : view === 'snoozed'
                          ? 'Taking a pause. New relevant activity brings these back early.'
                          : 'Every open PR in your review orbit, including drafts.'}
                </p>
              </div>
              <span className="sort-label">
                <ArrowDownWideNarrow size={14} />
                Priority, then oldest
              </span>
            </div>
            <div className="list-toolbar">
              <div className="search-field">
                <Search size={16} />
                <input
                  ref={searchRef}
                  aria-label="Search PRs"
                  placeholder="Search pull requests…"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                />
                <kbd>
                  <Command size={10} /> K
                </kbd>
                {search && (
                  <button
                    className="icon-button"
                    aria-label="Clear search"
                    onClick={() => setSearch('')}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
              <label className="select-field">
                <span className="sr-only">Repository</span>
                <GitPullRequest size={14} />
                <select
                  aria-label="Repository"
                  value={repository}
                  onChange={(event) => setRepository(event.target.value)}
                >
                  <option value="">All repositories</option>
                  {repositories.map((repo) => (
                    <option key={repo}>{repo}</option>
                  ))}
                </select>
              </label>
              <button
                className={`button filter-button ${showFilters || filterCount ? 'selected' : ''}`}
                aria-expanded={showFilters}
                onClick={() => setShowFilters(!showFilters)}
              >
                <SlidersHorizontal size={14} />
                Filters{filterCount > 0 && <span className="filter-count">{filterCount}</span>}
              </button>
            </div>
            {showFilters && (
              <div className="advanced-filters">
                <label>
                  Author
                  <select
                    aria-label="Author"
                    value={author}
                    onChange={(event) => setAuthor(event.target.value)}
                  >
                    <option value="">Anyone</option>
                    {authors.map((value) => (
                      <option key={value}>{value}</option>
                    ))}
                  </select>
                </label>
                <label>
                  Attention reason
                  <select
                    aria-label="Attention reason"
                    value={reason}
                    onChange={(event) => setReason(event.target.value)}
                  >
                    <option value="">Any reason</option>
                    {Object.entries(reasonLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  Checks
                  <select
                    aria-label="Checks"
                    value={ci}
                    onChange={(event) => setCi(event.target.value as CiState)}
                  >
                    <option value="">Any status</option>
                    <option value="success">Passing</option>
                    <option value="failure">Failing</option>
                    <option value="pending">Running</option>
                    <option value="none">No checks</option>
                  </select>
                </label>
                <label>
                  Drafts
                  <select
                    aria-label="Drafts"
                    value={drafts}
                    onChange={(event) => setDrafts(event.target.value)}
                  >
                    <option value="">Include drafts</option>
                    <option value="hide">Hide drafts</option>
                    <option value="only">Drafts only</option>
                  </select>
                </label>
                <button className="text-button" onClick={clearFilters}>
                  Reset filters
                </button>
              </div>
            )}
            <div className={`workspace-body ${selected && account ? 'with-detail' : ''}`}>
              <div className="table-container">
                <table className="pr-table">
                  <thead>
                    <tr>
                      <th>Pull request</th>
                      <th>Review status</th>
                      <th>Checks</th>
                      <th>Activity</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((pr) => (
                      <tr
                        key={pr.id}
                        className={selected === pr.id ? 'selected-row' : ''}
                        onClick={() => setSelected(pr.id)}
                      >
                        <td>
                          <div className="row-repo">
                            <GitPullRequest size={13} />
                            <span>{pr.repository}</span>
                            <span>#{pr.number}</span>
                            {pr.hasNote && (
                              <span title="Has a private note" className="note-marker" />
                            )}
                          </div>
                          <button
                            className="pr-title"
                            onClick={() => setSelected(pr.id)}
                            aria-label={`Show details for ${pr.title}`}
                          >
                            {pr.title}
                          </button>
                          <div className="row-meta">
                            <span className="avatar micro">
                              {pr.author.login.slice(0, 1).toUpperCase()}
                            </span>
                            <span>{pr.author.login}</span>
                            <span>·</span>
                            <span className="diff">
                              <em>+{pr.additions}</em>
                              <i>−{pr.deletions}</i>
                            </span>
                            <span>·</span>
                            <span>{pr.changedFiles} files</span>
                            {pr.unresolvedThreads > 0 && (
                              <span title="Unresolved review threads">
                                · {pr.unresolvedThreads} open threads
                              </span>
                            )}
                          </div>
                        </td>
                        <td>
                          <ReasonBadges reasons={pr.reasons} />
                          {pr.isDraft && <span className="badge neutral">Draft</span>}
                          <div className="last-review">
                            {pr.latestReview
                              ? pr.latestReview.state === 'DISMISSED'
                                ? 'Your review was dismissed'
                                : pr.latestReview.state === 'CHANGES_REQUESTED'
                                  ? 'You requested changes'
                                  : `You ${reviewLabels[pr.latestReview.state].toLowerCase()}`
                              : 'Not reviewed yet'}
                          </div>
                          {pr.requestedVia.some((value) => value !== 'Direct request') && (
                            <span className="team-source">
                              Via{' '}
                              {pr.requestedVia
                                .filter((value) => value !== 'Direct request')
                                .join(', ')}
                            </span>
                          )}
                          {pr.snoozedUntil && (
                            <span className="last-review">Until {dateTime(pr.snoozedUntil)}</span>
                          )}
                        </td>
                        <td>
                          <CiBadge state={pr.ci} />
                        </td>
                        <td>
                          <time className="activity-time" title={dateTime(pr.attentionAt)}>
                            {relativeTime(pr.attentionAt)}
                          </time>
                          <span className="activity-label">
                            {pr.reasons.length ? 'pending' : 'last activity'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {!filtered.length && (
                  <div className="empty-state">
                    {pulls.isPending || (state?.syncing && !items.length) ? (
                      <>
                        <LoaderCircle size={30} className="spinning" />
                        <h3>Gathering your review workload</h3>
                        <p>Reading requests, reviews, and conversations from GitHub.</p>
                      </>
                    ) : !items.length && (stale || status.error || pulls.error) ? (
                      <>
                        <CircleAlert size={30} />
                        <h3>Couldn’t load your review queue</h3>
                        <p>
                          Resolve the sync message above, then sync again to see what needs
                          attention.
                        </p>
                      </>
                    ) : search || filterCount ? (
                      <>
                        <Search size={30} />
                        <h3>No matching pull requests</h3>
                        <p>Try a different search or clear your filters.</p>
                        <button className="button" onClick={clearFilters}>
                          Clear filters
                        </button>
                      </>
                    ) : (
                      <>
                        <CheckCheck size={32} />
                        <h3>
                          {view === 'attention'
                            ? 'Nothing needs your attention'
                            : view === 'waiting'
                              ? 'No PRs waiting on an author'
                              : view === 'snoozed'
                                ? 'No snoozed pull requests'
                                : 'No pull requests here yet'}
                        </h3>
                        <p>
                          {view === 'attention'
                            ? 'You’re clear for now. New review requests and follow-ups will appear here.'
                            : 'We’ll keep this view up to date as your reviews move along.'}
                        </p>
                        {view !== 'all' && (
                          <button className="button" onClick={() => changeView('all')}>
                            View all tracked PRs
                            <ArrowUpRight size={14} />
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                <div className="table-footer">
                  <span>
                    {filtered.length} of {items.length} tracked pull requests
                  </span>
                  <span>
                    <span className="mini-dot green" />
                    Updates every 60 seconds
                  </span>
                </div>
              </div>
              {selected && account && (
                <Detail
                  key={`${account}:${selected}`}
                  id={selected}
                  account={account}
                  onClose={() => setSelected(null)}
                />
              )}
            </div>
          </section>
          <footer className="page-footer">
            <span className={`sync-status ${stale ? 'stale' : ''}`}>
              <span className={`mini-dot ${stale ? 'amber' : 'green'}`} />
              {state?.syncing
                ? 'Syncing with GitHub…'
                : state?.lastSuccessfulSync
                  ? `Last successful sync ${relativeTime(state.lastSuccessfulSync)}`
                  : 'Waiting for first sync'}
              {state?.lastSuccessfulSync && (
                <span title={dateTime(state.lastSuccessfulSync)}>
                  {' '}
                  ·{' '}
                  {new Date(state.lastSuccessfulSync).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </span>
              )}
            </span>
            <span>
              <LockKeyhole size={12} />
              Runs on your machine. Reviews happen on GitHub.
            </span>
          </footer>
        </div>
      </main>
    </div>
  );
}
