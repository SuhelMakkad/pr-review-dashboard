# Review Desk

A private, local dashboard for your GitHub review workload. It brings together open PRs requesting your review, assigned to you, and previously reviewed by you across every repository your current GitHub CLI account can access.

## Start

Requires Node.js **24.x**, pnpm **10**, and the GitHub CLI (`gh`) on your PATH. The installed dependencies and first production build are already prepared in this checkout.

```bash
cd pr-review-dashboard
pnpm start
```

Open **http://127.0.0.1:4317**. Keep the process running while using the dashboard; press Ctrl-C to stop it. It syncs at startup and every 60 seconds while the server runs, even when the browser is closed. There is no cloud deployment, separate database service, Docker requirement, or GitHub app registration.

For a fresh installation or after changing dependencies/source:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

For development, `pnpm dev` starts Vite on loopback port 4317 and the API on loopback port 4318. Stop the production server before using development mode; the UI port is intentionally fixed. On narrower screens the detail panel moves below the horizontally scrollable table.

## GitHub account and access

The backend executes read-only `gh api` queries using the CLI’s existing authentication. It never extracts, stores, or sends a token to the browser. The sidebar identifies the account returned by GitHub. Switching the CLI account is detected on the next sync; each account has separate cached PRs and notes.

```bash
gh auth status
gh api user --jq .login
gh auth login --hostname github.com
```

To select another existing login, use `gh auth switch --hostname github.com --user YOUR_LOGIN`, then click **Sync now**. Private repository access and team requests depend on your account’s GitHub permissions and organisation SSO authorisation. Existing `GH_TOKEN`/`GITHUB_TOKEN` environment overrides behave as they do in `gh` itself. No credentials belong in this project.

## Review workflow

- **Needs attention:** first reviews, changes since your review, re-requests (including requests at an unchanged head), new replies in threads you joined, and dismissed reviews.
- **Waiting on author:** your latest effective review requests changes, with no new follow-up signal.
- **Caught up:** reviewed PRs without a fresh signal. CI failures and unresolved threads remain visible as context without automatically creating a review task.
- **Snoozed:** paused until the selected time; a new relevant signal wakes the PR early. “Tomorrow” means 09:00 in your browser’s local timezone.
- **All tracked:** every tracked open PR, including drafts. Drafts stay out of the default attention queue.

Follow-ups sort ahead of first reviews, then by oldest pending activity. Search titles, repository names, authors, or PR numbers; filter by repository, author, attention reason, checks, and drafts. Use Cmd/Ctrl-K to focus search, Escape to close details, and arrow keys to move between detail tabs.

Select a PR for its description, your review history, current CI jobs, branch information, files, and review conversations. Discussion includes inline review threads you started or participated in, including resolved threads. Use **Review on GitHub** or **View diff** to inspect code or submit feedback; the dashboard never submits a review, comment, merge, or thread resolution.

**Mark seen** acknowledges only the reply versions displayed when clicked. New replies or edits remain unread, and code changes/review requests remain pending. Your own reply or a later submitted review also updates the discussion baseline. On first launch, replies are reconstructed relative to your latest review and last comment in each thread; subsequent acknowledgements are persisted locally.

Head SHA differences are deliberately treated as changes, including rebases and force pushes. On first sync, the activity age uses GitHub’s commit/update time as an approximation; later head changes use the time first observed locally. “Dismissed” describes the state of your review, not who dismissed it.

Notes save only when you click **Save note**. Unsaved drafts survive PR/tab switching within the current browser tab through session storage. Save notes before closing that tab. Theme defaults to your OS preference and supports a saved light/dark override.

## Local storage and recovery

The backend stores cached GitHub content, notes, acknowledgements, and snoozes in `.data/review-desk.sqlite` using Node’s built-in SQLite. The private directory is created with owner-only directory permissions and is ignored by Git alongside build output. Notes are local, but are not encrypted; protect this directory as you would other local work data.

For a backup, **stop the app**, then copy the entire `.data/` directory to a private local backup location. Restore by stopping the app and replacing `.data/` with that backup. To reset without losing your current state, stop the app and rename `.data/` to `.data.backup/`; the next start creates a fresh cache. The reset also resets local notes and triage state in the new database. Restore the original directory to recover them. Do not commit or upload either directory.

GitHub errors retain cached records and show a stale/coverage banner with the last successful sync. Retry runs automatically; rate-limit responses impose a five-minute minimum cooldown. Search and nested connections are paginated, and searches above GitHub’s 1,000-result cap are partitioned by creation time. Failed partitions, missing permissions, or unavailable PRs are reported as incomplete coverage rather than silently disappearing. A cached PR leaves the list only after its closed/merged state is confirmed. GitHub search indexing can briefly lag live changes.

Both servers bind to `127.0.0.1`. The local API rejects unexpected Host/Origin values and requires an application-specific header for writes. GitHub Markdown renders without raw HTML or remote images. No telemetry, external fonts, desktop notifications, or background system service is installed.

## Implementation and checks

React/TypeScript/Vite render the UI; Fastify serves the local API and production assets. Shared types and pure attention rules live in `shared/`; GitHub retrieval, sync, and SQLite persistence live in `server/`. This is a standalone project.

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm format:check
```

Tests use synthetic fixtures and temporary databases, with no GitHub writes. They cover attention classification, re-requests, force pushes, resolved-thread replies, snoozes, restart persistence, account isolation, pagination/search partitioning, rate limits, partial failures, merged PRs, local API validation, filters, keyboard tabs, themes, and saving notes. Live GitHub smoke verification is read-only.

The local API exposes `GET /api/status`, `GET /api/pulls`, `GET /api/pulls/:id`, `POST /api/sync`, and `PATCH /api/pulls/:id/triage`. POST/PATCH requests use JSON and `X-Review-Desk: 1`; triage updates include the expected account to prevent writes after an account switch.
