# Review Desk

A keyboard-first, local workspace for your GitHub code reviews. It shows what needs you, lets you review the change (including exactly what changed since your last review, across rebases and force pushes), and posts comments, replies and reviews through your own GitHub CLI login. Optional AI help runs through the Codex or Claude Code CLI on your machine. Everything runs on `127.0.0.1`; there is no hosted service and no GitHub App.

## Start

Requires Node.js 24, pnpm 10 and the GitHub CLI (`gh`) logged in. Codex, Claude Code and a Linear key are optional.

```bash
cd pr-review-dashboard
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

Open **http://127.0.0.1:4317**. Keep the process running; it syncs in the background. In Chrome or Edge, use _Install Review Desk_ in the address bar to get a dock icon with a badge and desktop notifications.

`pnpm demo` runs the same app on **http://127.0.0.1:4319** against a fictional scenario (no GitHub, no AI quota, nothing posted anywhere). `pnpm dev` and `pnpm dev:demo` run Vite with hot reload (UI on 4317 / 4319, API on 4318 / 4320).

## What it does

**Inbox.** Pull requests that need you, grouped into follow-ups (new commits since your review, review re-requested, replies in your threads, @mentions, dismissed reviews) and first reviews. _Waiting on author_, _Caught up_ and _Snoozed_ hold the rest. `E` marks a PR done until something new happens; `S` snoozes it (presets, or type "fri 2pm"); new activity always brings a PR back. The URL holds the queue, filters and selected PR, so views are linkable and Back works.

**Review workspace.** `Enter` opens the diff: a file tree with viewed state (synced with GitHub), one file at a time with syntax highlighting, unified or split, and review threads inline under their lines. When the branch moved after your review, it opens _Since your review_ automatically: an exact diff for new commits, or a file-by-file comparison of what you reviewed against what is there now after a rebase or force push. Select lines and press `C` to comment; comments stay as local drafts until you finish the review. `R` replies to a thread and `Shift+R` resolves it; both post immediately and say so. `⌘⇧↵` opens the Finish sheet: pick Comment, Approve or Request changes, add a summary, and submit. It warns when new commits arrived while you were reviewing, re-anchors your draft comments to the new code, and flags any that sit on changed lines.

**My PRs.** Your own open PRs grouped by whose move it is (needs you, waiting on reviewers, ready to merge, drafts), each with a checklist of what blocks it and the next step, including re-requesting a review in place. Waits longer than a day are flagged.

**Full review.** Open a PR in the dashboard and click _Run review_. The server downloads repository snapshots at the PR's merge base and exact head, and Codex inspects the complete change, surrounding code and relevant tests in read-only mode. The report stays on the PR with its findings and review coverage; running a review never posts to GitHub. Select the findings you want to include, click _Prepare GitHub review_, edit the summary and choose Comment, Approve or Request changes in the Finish sheet, then submit explicitly. Prepared reviews contain the summary and selected findings, with concise evidence of what was checked and why the code looks correct even when no changes are needed; detailed review coverage stays in the dashboard. Existing drafts are preserved, and an out-of-date report must be regenerated before preparing a review. Repository downloads are limited to 100 MB per compressed snapshot; symlinks, submodules and files beyond the extraction limit are unavailable and reported to Codex as coverage gaps. Codex does not execute repository code or tests.

**AI assist.** `B` writes a brief (summary, risk, files to read closely, questions); on PRs you already reviewed it also judges whether each of your threads was addressed. `Shift+B` in the workspace suggests review comments anchored to real lines; you accept them one at a time into your draft, and nothing is ever posted for you. The Finish sheet can draft your review summary using the diff, pending comments and any completed full review of the current head. Codex is the default; pick Claude Code per run or per task in Settings, along with how much effort each task uses. Full reviews always use Codex, with high effort by default. Up to two AI tasks, including two full reviews, can run in parallel; additional tasks wait in order until a slot is free. Results are cached per commit and marked out of date when the branch moves.

**Saved reviews and summaries.** Preparation and summary generation continue when you navigate away. Return to see progress, reopen the prepared review with your edits, use a saved generated summary, or generate a new one. Preparing another run or changing the selected findings replaces the previously prepared summary and findings while keeping independent comments and surrounding summary text. Edited prepared content requires confirmation; a copy of the current draft stays available under _Saved drafts before replacement_ in the Finish sheet. Results show their generation time, commit and freshness. New commits, base changes or review discussion make a review out of date; summaries also need regeneration after verdict or draft comment changes, or a newer full review. Reuse checks live GitHub before applying a saved result. Failed or stopped replacements keep the previous completed result available, and summaries replace your text only when you explicitly choose to use them.

**Pause and recovery.** Codex reviews and summaries save their thread and exact inputs locally. _Pause_ preserves the investigation; _Resume_ continues the same run and thread after checking that the PR and task inputs are still current. Server shutdowns save running and queued Codex tasks, and startup resumes them automatically after GitHub reconnects, within the same two-task limit. User-paused tasks stay paused. A missing workspace is rebuilt at the saved commits; a completed answer already in the thread is recovered without another model turn. Changed PRs or review instructions require a new generation. _Stop_ discards the checkpoint. Paused and recoverable failed runs retain their workspace; completed and discarded runs remove it. Claude and older runs created without checkpoints still require a new run after interruption. Recovery restores persisted conversation history; work interrupted before it was saved can be repeated.

**Linear.** Ticket ids in branches (`fix/APP-123/...`), titles (`fix(APP-123): ...`) and Linear links show as chips, and the PR view shows each issue's state, priority and owner.

**Notifications and badge.** New review requests, pushes after your review, replies, mentions, and approvals or failing checks on your own PRs. You get a toast while you are looking at the app and a desktop notification otherwise, with per-kind toggles and quiet hours. Optional native macOS notifications cover the time no window is open. The badge shows how many PRs need you.

**Insights.** Median and 90th-percentile time to review, reviews per day or week, how many waited past your target, your queue over time, your verdict mix, per-repository numbers, and how long your own PRs wait for a first review. History is read from GitHub for the last 90 days, then recorded as you work.

## Keyboard

Press `?` anywhere for the shortcuts available on that screen, or `⌘K` for the command palette (it also opens pasted GitHub PR links). The essentials:

| Where | Keys |
| --- | --- |
| Anywhere | `⌘K` palette · `?` shortcuts · `g i` inbox · `g m` my PRs · `g t` insights · `g s` settings · `z` undo |
| Lists | `j`/`k` move · `Enter` review · `o` open on GitHub · `e` done · `s` snooze · `m` mark replies seen · `n` note · `/` filter · `b` AI brief |
| Workspace | `n`/`p` files · `j`/`k` scroll · `c` comment · `v` viewed and next · `u` next unresolved thread · `r` reply · `Shift+R` resolve · `d` full diff vs since review · `Shift+D` split view · `t` go to file · `Shift+B` suggest comments · `⌘⇧↵` finish review |

Replacing `github.com` with `127.0.0.1:4317` in any PR URL opens that PR here.

## Setup for the optional parts

**AI.** Install and log in to the Codex CLI (`codex`) and/or Claude Code (`claude`). Settings shows which are found. Agents run headless in a private scratch folder with no GitHub credentials; full reviews include repository snapshots that are removed when the run finishes or is stopped. Codex runs through `codex app-server`, the way Codex's IDE extension does, on your ChatGPT sign-in, so it uses your ChatGPT plan. A Codex signed in with an API key is refused. Runs are paused while the plan's limit is used up, and a run that reaches the limit midway is stopped, so the dashboard never falls back to credits; Settings → AI shows the plan, its usage and when it resets. A run also says so if your Codex credit balance fell while it ran. Codex runs read-only, with its connectors, plugins, browser, web search, notify hook and your MCP servers turned off, at standard speed even if your Codex config asks for Fast mode. Each task can pick a model your account offers (a model it stops offering falls back to the default). The default is the first of GPT-6.1-Sol, GPT-6-Astra, GPT-5.6-Sol and GPT-5.6-Terra your account offers to Review Desk, else your account's own default, never the model pinned in your Codex config. OpenAI offers GPT-6.1-Sol only to Codex CLI 0.159.0 and later, so run `codex update` if Settings does not list it. Claude runs with no tools, no MCP servers and your user settings only. PR content is sent to the agent's own service under your subscription.

**Linear.** In Settings → Linear, click _Connect Linear_ and approve read-only access in Linear. This signs in through Linear's MCP server (OAuth with PKCE), so it works in workspaces where personal API keys are turned off. The sign-in is kept in your macOS Keychain (item `review-desk.linear-oauth`), refreshes itself, and _Disconnect_ removes it. Where personal API keys are allowed (Linear Settings → Security & access → Personal API keys) you can use one instead; store it in the Keychain from a terminal so the key never passes through the app:

```bash
security add-generic-password -U -s review-desk.linear -a api-key -w
```

**Notifications.** In Settings → Notifications, click _Allow notifications_. Native macOS notifications for when no window is open are opt-in; clicking one opens Script Editor rather than the PR.

## GitHub account and safety

The server calls `gh api` with your existing login; no token is extracted, stored or sent to the browser. Every write is an explicit action in the UI and states who it posts as. GitHub actions are saved in a durable SQLite outbox before the editor closes. Open **Activity** in the status bar or command palette to inspect progress, saved content, GitHub links, and recovery options. Queued reviews are read-only across tabs; other PRs remain editable. Inbox reviews advance after queue acceptance, while standalone PR pages stay open.

The worker rechecks the live account before each mutation, paces writes, honors rate-limit cooldowns, and validates the reviewed commit before submission. Confirmed steps are checkpointed so recovery resumes the remaining work. If a request may have reached GitHub without a response, Activity checks what it can verify and leaves ambiguous results **Unconfirmed** instead of automatically repeating them. Cancellation is available until sending starts. Cleanup of a partial pending review requires confirmation and saves its GitHub content before restoring the local draft.

Actions continue when the browser closes while the local server remains running. After a server restart, unsent actions resume automatically; interrupted mutations are checked first. Replies attached to an existing GitHub pending review are labeled as pending rather than posted. Viewed-file updates sync quietly and report failures in Activity.

The app binds to `127.0.0.1` only, rejects unexpected hosts and origins, and requires a per-launch session token on every write. Pages cannot be framed, user Markdown renders without raw HTML or remote images, and errors are scrubbed of tokens and keys. To switch account, run `gh auth switch --hostname github.com --user LOGIN`; each account keeps separate data.

## Data, backup and recovery

Everything lives in `.data/` (SQLite: cached PRs, notes, drafts, queued GitHub actions and receipts, triage, AI results, history). Schema upgrades back up the previous database first (`.data/backup-before-<migration>.sqlite`, or `.data/backup-v<N>.sqlite` for databases from before Drizzle). To back up, stop the app and copy `.data/`. To start fresh, stop the app and rename `.data/`. Notes and drafts are stored locally but not encrypted, so protect the folder like other work data.

Syncing is incremental: a cheap fingerprint per PR decides when a full refresh is needed, with a full check every 30 minutes and on opening a PR. Search failures never drop a PR, and a PR leaves the list only once GitHub confirms it was closed or merged.

## Development

The repository is a pnpm workspace with one lockfile. `apps/web` (`@review-desk/web`) contains the React, TypeScript and Vite frontend (TanStack Router and Query, Tailwind CSS, Radix primitives, `@pierre/diffs`). `apps/server` (`@review-desk/server`) contains Fastify, Drizzle ORM over Node's built-in SQLite, GitHub, sync, reviews, AI, Linear, notifications and insights. `packages/shared` (`@review-desk/shared`) contains browser-safe contracts and pure rules for attention, author blockers, diffs, tickets and insights.

Each workspace has its own dependencies, TypeScript configuration and unit or component tests under `tests/`. End-to-end tests, common test fixtures and the GitHub GraphQL schema stay in the root `tests/` directory. The root commands run the complete app and test suite:

```bash
pnpm test          # unit and component tests (Vitest)
pnpm e2e           # builds, then Playwright against demo mode in light and dark, with axe scans and visual baselines
pnpm typecheck
pnpm format:check
```

Within a workspace, `@/` points to that workspace's `src/` directory. For example, the web app imports `@/ui/button`, and the server imports `@/db/store.js`. Node ESM imports in the server and shared package retain their `.js` extension; their builds rewrite aliases to relative JavaScript imports so production runs with plain Node. Imports between workspaces use package names such as `@review-desk/shared/ai`, declared with `workspace:*` dependencies. Tests use `@test/fixtures` for the common root fixtures. Vite and Vitest resolve aliases from the importing workspace; TypeScript and tsx use that workspace's configuration.

`pnpm dev` builds shared code, then watches the shared package, API and web app together. `pnpm build` typechecks all workspaces and tests before building their production outputs. `pnpm start` serves `apps/web/dist` from the built server at `apps/server/dist/index.js`. Existing `.data/` and `.data-demo/` directories remain at the repository root, including when commands run from a workspace directory.

To run a package's tests alone, use `pnpm --filter @review-desk/web test`, `pnpm --filter @review-desk/server test` or `pnpm --filter @review-desk/shared test`. After shared code has been built, `pnpm --filter <package> typecheck` checks that workspace and its tests.

To change the database schema, edit `apps/server/src/db/schema.ts`, run `pnpm db:generate --name <change>` and commit the new folder under `apps/server/drizzle/`. The app applies pending migrations on start. Never edit a migration that has already been released; generate a new one instead.

Every GraphQL document is validated against GitHub's published schema (`tests/schema/github.graphql`). Demo mode (`apps/server/src/demo/`) models commit graphs, force pushes, GitHub writes with a write log and failure injection, Linear issues, AI answers and review history, so end-to-end tests never touch GitHub or spend AI quota.
