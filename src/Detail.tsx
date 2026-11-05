import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ArrowUpRight,
  CheckCheck,
  Clock3,
  ExternalLink,
  FileCode2,
  GitBranch,
  GitCommitHorizontal,
  MessageSquare,
  X,
} from 'lucide-react';
import type { PullRequestDetail, ReviewState, TriageUpdate } from '../shared/types';
import { api, dateTime, relativeTime, tomorrowMorning } from './api';
import { CiBadge, ReasonBadges } from './components';

export const reviewLabels: Record<ReviewState, string> = {
  APPROVED: 'Approved',
  CHANGES_REQUESTED: 'Changes requested',
  COMMENTED: 'Commented',
  DISMISSED: 'Dismissed',
};

function Content({ children }: { children: string }) {
  return (
    <div className="markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        skipHtml
        components={{
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          img: ({ alt }) => (
            <span className="image-placeholder">[Image: {alt || 'view on GitHub'}]</span>
          ),
        }}
      >
        {children}
      </Markdown>
    </div>
  );
}

function Notes({
  detail,
  onSave,
  saving,
}: {
  detail: PullRequestDetail;
  onSave: (update: Partial<TriageUpdate>) => void;
  saving: boolean;
}) {
  const storageKey = `review-desk-draft:${detail.account}:${detail.item.id}`;
  const [note, setNote] = useState(() => sessionStorage.getItem(storageKey) ?? detail.triage.note);
  const dirty = note !== detail.triage.note;

  useEffect(() => {
    if (dirty) sessionStorage.setItem(storageKey, note);
    else sessionStorage.removeItem(storageKey);
  }, [note, dirty, storageKey]);

  return (
    <section className="note-editor">
      <div className="section-heading">
        <h3>Private notes</h3>
        <span className="local-label">
          <span /> Only on this device
        </span>
      </div>
      <p className="muted">
        Keep review reminders and context for your next pass. Nothing here is sent to GitHub.
      </p>
      <label className="sr-only" htmlFor="private-note">
        Private note
      </label>
      <textarea
        id="private-note"
        maxLength={30000}
        value={note}
        onChange={(event) => setNote(event.target.value)}
        placeholder="What do you want to remember about this PR?"
      />
      <div className="note-footer">
        <span className="muted">
          {dirty ? 'Unsaved changes · draft kept in this tab' : 'All changes saved locally'}
        </span>
        <button
          className="button primary small"
          disabled={!dirty || saving}
          onClick={() => onSave({ note })}
        >
          {saving ? 'Saving…' : 'Save note'}
        </button>
      </div>
    </section>
  );
}

export function Detail({
  id,
  account,
  onClose,
}: {
  id: string;
  account: string;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [tab, setTab] = useState('overview');
  const [snoozeOpen, setSnoozeOpen] = useState(false);
  const query = useQuery({
    queryKey: ['detail', account, id],
    queryFn: () => api<PullRequestDetail>(`/api/pulls/${encodeURIComponent(id)}`),
    refetchInterval: 5000,
  });
  const mutation = useMutation({
    mutationFn: (update: Partial<TriageUpdate>) =>
      api<PullRequestDetail>(
        `/api/pulls/${encodeURIComponent(id)}/triage`,
        { account, ...update },
        'PATCH',
      ),
    onSuccess: (detail) => {
      client.setQueryData(['detail', account, id], detail);
      void client.invalidateQueries({ queryKey: ['pulls'] });
      setSnoozeOpen(false);
    },
  });

  useEffect(() => {
    setTab('overview');
    setSnoozeOpen(false);
  }, [id]);

  if (!query.data)
    return (
      <aside className="detail-panel" aria-label="Pull request details">
        <div className="panel-placeholder">
          <button className="icon-button panel-close" onClick={onClose} aria-label="Close details">
            <X size={18} />
          </button>
          {query.error ? <p role="alert">{query.error.message}</p> : <p>Loading PR details…</p>}
        </div>
      </aside>
    );

  const { snapshot: pr, item, triage } = query.data;
  const ownThreads = pr.threads.filter((thread) =>
    thread.comments.some((comment) => comment.author.login.toLowerCase() === account.toLowerCase()),
  );
  const latest = item.latestReview;
  const snooze = (until: string) => mutation.mutate({ snoozeUntil: until });

  return (
    <aside className="detail-panel" aria-label="Pull request details">
      <div className="detail-top">
        <span className="eyebrow">PULL REQUEST DETAILS</span>
        <button className="icon-button" aria-label="Close details" onClick={onClose}>
          <X size={18} />
        </button>
      </div>
      <div className="detail-intro">
        <a className="repo-link" href={pr.url} target="_blank" rel="noreferrer">
          {pr.repository} <span>#{pr.number}</span>
          <ArrowUpRight size={13} />
        </a>
        <h2>{pr.title}</h2>
        <div className="detail-author">
          <span className="avatar tiny">{pr.author.login.slice(0, 2).toUpperCase()}</span>
          <strong>{pr.author.login}</strong>
          <span>opened {relativeTime(pr.createdAt)}</span>
          {pr.isDraft && <span className="badge neutral">Draft</span>}
        </div>
        <ReasonBadges reasons={item.reasons} />
      </div>
      <div className="detail-actions">
        <a className="button primary" href={pr.url} target="_blank" rel="noreferrer">
          Review on GitHub <ArrowUpRight size={15} />
        </a>
        <div className="snooze-wrapper">
          <button
            className="button"
            aria-expanded={snoozeOpen}
            onClick={() => setSnoozeOpen(!snoozeOpen)}
          >
            <Clock3 size={15} />
            {item.snoozedUntil ? 'Snoozed' : 'Snooze'}
          </button>
          {snoozeOpen && (
            <div className="snooze-menu">
              <button onClick={() => snooze(new Date(Date.now() + 3_600_000).toISOString())}>
                For one hour
              </button>
              <button onClick={() => snooze(tomorrowMorning())}>Tomorrow at 09:00</button>
              {item.snoozedUntil && (
                <button onClick={() => mutation.mutate({ snoozeUntil: null })}>Wake now</button>
              )}
            </div>
          )}
        </div>
      </div>
      {item.snoozedUntil && (
        <p className="snooze-message">
          <Clock3 size={13} /> Snoozed until {dateTime(item.snoozedUntil)}. New activity wakes this
          PR.
        </p>
      )}
      {mutation.error && (
        <p className="inline-error" role="alert">
          {mutation.error.message}
        </p>
      )}
      <div className="detail-tabs" role="tablist" aria-label="PR sections">
        {[
          ['overview', 'Overview'],
          ['discussion', `Discussion${ownThreads.length ? ` ${ownThreads.length}` : ''}`],
          ['files', 'Files'],
          ['notes', 'Notes'],
        ].map(([value, label]) => (
          <button
            key={value}
            id={`tab-${value}`}
            role="tab"
            aria-selected={tab === value}
            aria-controls="detail-content"
            tabIndex={tab === value ? 0 : -1}
            onClick={() => setTab(value)}
            onKeyDown={(event) => {
              const values = ['overview', 'discussion', 'files', 'notes'];
              const index = values.indexOf(value);

              if (
                event.key === 'ArrowRight' ||
                event.key === 'ArrowLeft' ||
                event.key === 'Home' ||
                event.key === 'End'
              ) {
                event.preventDefault();
                const next =
                  event.key === 'Home'
                    ? values[0]
                    : event.key === 'End'
                      ? values[3]
                      : values[(index + (event.key === 'ArrowRight' ? 1 : 3)) % 4];

                setTab(next);
                document.getElementById(`tab-${next}`)?.focus();
              }
            }}
          >
            {label}
            {value === 'notes' && triage.note && <span className="note-dot" />}
          </button>
        ))}
      </div>
      <div
        className="detail-content"
        id="detail-content"
        role="tabpanel"
        aria-labelledby={`tab-${tab}`}
      >
        {tab === 'overview' && (
          <>
            <section className="review-section">
              <div className="section-heading">
                <h3>Your latest review</h3>
                {latest && (
                  <time title={dateTime(latest.submittedAt)}>
                    {relativeTime(latest.submittedAt)}
                  </time>
                )}
              </div>
              {latest ? (
                <>
                  <div className={`review-state review-${latest.state.toLowerCase()}`}>
                    <span className="review-state-dot" />
                    {reviewLabels[latest.state]}
                    <code>{latest.commitOid?.slice(0, 7) ?? 'unknown SHA'}</code>
                  </div>
                  {latest.body && <Content>{latest.body}</Content>}
                  {latest.commitOid !== pr.headOid && (
                    <p className="change-explanation">
                      <GitCommitHorizontal size={16} />
                      The branch head has changed since this review, including any rebases or force
                      pushes.
                    </p>
                  )}
                </>
              ) : (
                <p className="muted">You haven’t submitted a review on this PR yet.</p>
              )}
            </section>
            <div className="pr-metrics">
              <div>
                <span>Files changed</span>
                <strong>
                  {pr.changedFiles}
                  <FileCode2 size={15} />
                </strong>
              </div>
              <div>
                <span>Lines changed</span>
                <strong className="diff">
                  <em>+{pr.additions.toLocaleString()}</em> <i>−{pr.deletions.toLocaleString()}</i>
                </strong>
              </div>
              <div>
                <span>Open threads</span>
                <strong>
                  {item.unresolvedThreads}
                  <MessageSquare size={15} />
                </strong>
              </div>
            </div>
            <section>
              <div className="section-heading">
                <h3>Pull request summary</h3>
                <a
                  href={pr.url}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="Open PR summary on GitHub"
                >
                  <ExternalLink size={13} />
                </a>
              </div>
              {pr.body ? (
                <Content>{pr.body}</Content>
              ) : (
                <p className="muted">No description provided.</p>
              )}
            </section>
            <section className="branch-section">
              <div>
                <GitBranch size={15} />
                <code title={pr.headRefName}>{pr.headRefName}</code>
              </div>
              <span>into</span>
              <div>
                <GitBranch size={15} />
                <code title={pr.baseRefName}>{pr.baseRefName}</code>
              </div>
            </section>
            <section>
              <div className="section-heading">
                <h3>Checks & merge status</h3>
                <CiBadge state={pr.ci} />
              </div>
              <p className="muted">
                {pr.mergeable === 'CONFLICTING'
                  ? 'This branch has merge conflicts.'
                  : pr.mergeable === 'MERGEABLE'
                    ? 'No merge conflicts detected.'
                    : 'GitHub is calculating mergeability.'}
              </p>
              {pr.checks.length ? (
                <div className="checks-list">
                  {pr.checks.map((check, index) => (
                    <div key={`${check.name}-${index}`}>
                      <CiBadge state={check.state} iconOnly />
                      {check.url ? (
                        <a href={check.url} target="_blank" rel="noreferrer">
                          {check.name}
                          <ArrowUpRight size={12} />
                        </a>
                      ) : (
                        <span>{check.name}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="muted">No checks reported for this head commit.</p>
              )}
            </section>
            <details className="history">
              <summary>
                Your review history <span>{pr.reviews.length}</span>
              </summary>
              {[...pr.reviews].reverse().map((review) => (
                <div className="history-entry" key={review.id}>
                  <span className={`badge review-${review.state.toLowerCase()}`}>
                    {reviewLabels[review.state]}
                  </span>
                  <a href={review.url} target="_blank" rel="noreferrer">
                    {dateTime(review.submittedAt)}
                    <ArrowUpRight size={12} />
                  </a>
                  <code>{review.commitOid?.slice(0, 7)}</code>
                  {review.body && <Content>{review.body}</Content>}
                </div>
              ))}
            </details>
            <div className="tracking-note">
              <CheckCheck size={15} />
              <span>
                Tracked because{' '}
                {pr.sources
                  .map((source) =>
                    source === 'reviewed'
                      ? 'you reviewed it'
                      : source === 'assigned'
                        ? 'you’re assigned'
                        : 'your review was requested',
                  )
                  .join(', ')}
                .
                {item.requestedVia.length > 0 && ` Requested via: ${item.requestedVia.join(', ')}.`}
              </span>
            </div>
          </>
        )}
        {tab === 'discussion' && (
          <>
            <div className="section-heading">
              <h3>Your review conversations</h3>
              <button
                className="button small"
                disabled={!item.unreadReplyKeys.length || mutation.isPending}
                onClick={() => mutation.mutate({ seenReplyKeys: item.unreadReplyKeys })}
              >
                <CheckCheck size={14} />
                Mark seen
              </button>
            </div>
            <p className="muted">
              Threads you started or joined, including resolved conversations. Marking seen keeps
              pending reviews visible.
            </p>
            {!ownThreads.length && (
              <div className="tab-empty">
                <MessageSquare size={25} />
                <h3>No review conversations yet</h3>
                <p>Your inline review threads will appear here.</p>
              </div>
            )}
            {ownThreads.map((thread) => (
              <article className="thread" key={thread.id}>
                <div className="thread-heading">
                  <code>
                    {thread.path}
                    {thread.line ? `:${thread.line}` : ''}
                  </code>
                  <span className={`badge ${thread.isResolved ? 'success' : 'neutral'}`}>
                    {thread.isResolved ? 'Resolved' : 'Open'}
                  </span>
                  {thread.isOutdated && <span className="badge neutral">Outdated</span>}
                </div>
                {thread.comments.map((comment) => {
                  const unread = item.unreadReplyKeys.includes(
                    `${comment.id}:${comment.updatedAt}`,
                  );

                  return (
                    <div className={`comment ${unread ? 'unread' : ''}`} key={comment.id}>
                      <div className="comment-heading">
                        <strong>{comment.author.login}</strong>
                        {comment.author.login.toLowerCase() === account.toLowerCase() && (
                          <span className="you-label">you</span>
                        )}
                        {unread && <span className="new-label">NEW REPLY</span>}
                        <a
                          title={dateTime(comment.createdAt)}
                          href={comment.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {relativeTime(comment.createdAt)}
                          <ArrowUpRight size={11} />
                        </a>
                      </div>
                      <Content>{comment.body}</Content>
                    </div>
                  );
                })}
              </article>
            ))}
          </>
        )}
        {tab === 'files' && (
          <>
            <div className="section-heading">
              <h3>{pr.changedFiles} changed files</h3>
              <a href={`${pr.url}/files`} target="_blank" rel="noreferrer">
                View diff <ArrowUpRight size={13} />
              </a>
            </div>
            <p className="muted">Changes in the complete PR. Open GitHub to review the code.</p>
            <div className="files-list">
              {pr.files.map((file) => (
                <div key={file.path}>
                  <FileCode2 size={15} />
                  <code>{file.path}</code>
                  <span className="diff">
                    <em>+{file.additions}</em>
                    <i>−{file.deletions}</i>
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
        {tab === 'notes' && (
          <Notes
            key={`${account}:${id}`}
            detail={query.data}
            onSave={(update) => mutation.mutate(update)}
            saving={mutation.isPending}
          />
        )}
        <p className="detail-cache">Cached {dateTime(pr.fetchedAt)} · GitHub access is read-only</p>
      </div>
    </aside>
  );
}
