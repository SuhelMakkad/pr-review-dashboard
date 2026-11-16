# Using Codex and Claude Code CLIs with subscriptions

A standalone guide for adding Codex or Claude Code to a local application, script, or developer tool using the user's existing subscription login. No particular application, repository, or framework is required.

Last verified: **14 November 2026**. Command syntax was checked with Codex CLI `0.167.0` and Claude Code `2.1.236`. Shell examples use Bash/Zsh on macOS or Linux; the JavaScript example needs Node.js 22 or newer.

## 1. Understand what subscription access means

Both official CLIs support subscription authentication. Your application launches the CLI as a child process; the CLI uses its saved account login and handles provider communication. You do not need an API key for this path. See [Codex authentication](https://learn.chatgpt.com/docs/auth) and [Claude subscription access](https://support.claude.com/en/articles/11145838-use-claude-code-with-your-pro-max-or-ultra-plan).

| Connection | What pays for requests |
| --- | --- |
| Codex signed in with ChatGPT | The selected ChatGPT account's applicable allowance or credits. |
| Claude Code signed in with a Claude subscription | The selected Claude account's applicable allowance or paid continuation. |
| An API key, gateway, or cloud-provider credential | The billing arrangement for that credential/provider. |

**Subscription access still consumes the plan's included allowance.** Avoiding additional charges requires both the correct login and control of paid continuation. A wrapper, JSON output, or read-only mode does not create free usage or disable billing. Team/enterprise seats may be billed differently; confirm that the selected seat actually includes an allowance.

The integration should report a limit and wait when included usage is exhausted. It should never silently switch to an API key or another paid provider.

## 2. Install and sign in

Install the official CLIs on the machine that will run your application. These are the native installers for macOS/Linux:

```bash
curl -fsSL https://chatgpt.com/codex/install.sh | sh
curl -fsSL https://claude.ai/install.sh | bash

codex --version
claude --version
```

Installation alternatives and Windows instructions are in the [Codex CLI guide](https://learn.chatgpt.com/docs/codex/cli) and [Claude Code quickstart](https://code.claude.com/docs/en/quickstart).

### Codex: use ChatGPT authentication

Define this helper in your terminal. It removes alternate credentials only inside the helper's subshell, preserving the parent shell's environment:

```bash
codex_plan() (
  unset OPENAI_API_KEY CODEX_API_KEY OPENAI_BASE_URL CODEX_ACCESS_TOKEN

  codex -c 'model_provider="openai"' -c 'forced_login_method="chatgpt"' "$@"
)

codex_plan login
codex_plan login status
```

Complete the browser login with the intended ChatGPT account. Status should identify ChatGPT authentication. To switch an existing login, use `codex logout`, then sign in again. On a machine where the browser callback cannot work, use `codex_plan login --device-auth`.

For applications that launch plain `codex`, the equivalent persistent settings are below. Merge them as top-level settings in `~/.codex/config.toml`, or your existing Codex home, before any `[table]` sections:

```toml
model_provider = "openai"
forced_login_method = "chatgpt"
```

Check active profiles and custom provider definitions too: selecting the provider name does not undo a custom endpoint configured under that name. `forced_login_method` restricts sign-in; it does **not** prohibit spending purchased ChatGPT credits.

### Claude Code: use the Claude subscription login

This helper removes alternate credential/provider selections and skips user/project/local settings for a predictable local integration:

```bash
claude_plan() (
  unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY
  unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_PROFILE

  claude --setting-sources '' "$@"
)

claude_plan auth login --claudeai
claude_plan auth status --text
```

Select the account that owns the intended Claude plan. `--claudeai` selects Claude subscription login; `--console` selects Console/API billing. Clearing `CLAUDE_CODE_OAUTH_TOKEN` chooses the saved browser login rather than a separately supplied token.

Managed settings and enterprise gateways may still apply. Verify the effective account instead of assuming that removing environment variables is enough. If you choose to load user settings, inspect their `env`, `apiKeyHelper`, and provider configuration. In noninteractive `-p` mode, an available `ANTHROPIC_API_KEY` can be used without the interactive key-approval prompt. See [Claude authentication precedence](https://code.claude.com/docs/en/authentication#authentication-precedence).

**Do not add `--bare` to a subscription-based Claude invocation.** In the verified behavior, bare mode skips OAuth/keychain authentication and expects API credentials or another provider. Use explicit settings/tool options when you need a predictable subscription-backed process. See [Claude's bare-mode behavior](https://code.claude.com/docs/en/headless#start-faster-with-bare-mode).

### Preserve the login location

Run authentication and the application as the same operating-system user. Preserve the intended `CODEX_HOME` and `CLAUDE_CONFIG_DIR` if you already use them. Do not give every request a fresh home directory: it will not contain the saved login. A temporary working directory is separate from the CLI's authentication directory.

Let the CLI manage its credential storage and token refresh. An application does not need to extract or copy credential files. A server started before an environment change must be restarted to inherit it.

## 3. Configure paid continuation

Do this before running unattended tasks:

| Provider | Setting/action | Important distinction |
| --- | --- | --- |
| Native Codex with ChatGPT login | Inspect current allowance and credits in ChatGPT Usage; use `/status` inside Codex. Stop or wait at the limit. | Available credits may be consumed after included usage runs out. Disabling automatic purchases only prevents new purchases. |
| Claude Code with a personal subscription | In Claude Settings → Usage, disable **Usage credits**, called **Extra usage** in older versions. Turn off auto-reload if enabled. | Disabling paid continuation restricts usage to the included allowance; auto-reload alone is not that control. |
| Team/enterprise accounts | Check the seat's billing model and administrator spending permissions. | A subscription or organization login does not necessarily mean every request has an included allowance. |

A prompt such as “ask before spending credits” is not a billing approval mechanism. Client-side usage checks also cannot guarantee zero spending: reporting may lag, and other sessions can consume the same allowance. See [OpenAI usage credits](https://help.openai.com/en/articles/12642688-using-credits-for-flexible-usage-in-chatgpt-personal-plans) and [Claude paid-continuation controls](https://support.claude.com/en/articles/12429409-manage-usage-credits-for-paid-claude-plans).

## 4. Start with a noninteractive CLI call

For a one-shot request, invoke the official CLI directly. These examples use the shell helpers defined above:

```bash
codex_plan exec --json --sandbox read-only "Explain this repository without changing files."
```

```bash
printf '%s\n' 'Explain this TypeScript: const double = (n: number) => n * 2;' |
  claude_plan -p --output-format json --tools '' --no-session-persistence
```

Codex can inspect the working repository. The Claude example disables tools, so provide the relevant text in its input. Grant specific tools separately when your workflow needs file access or editing; permissions are independent of authentication and billing.

| CLI | Input/output contract |
| --- | --- |
| `codex exec --json -` | Reads the prompt from stdin and emits one JSON event per line. Look for a completed turn and the final `agent_message` item. |
| `claude -p --output-format json` | Reads piped text and returns a JSON result. Check `is_error` and extract `result`. |
| `claude -p --output-format stream-json --verbose` | Emits one JSON event per line for progress; the final `result` event contains completion/error information. |

Request output with a specific schema using Codex's `--output-schema <file>` or Claude's `--json-schema '<schema JSON>'` when another application needs structured data. Parse and validate the result before saving it or acting on it. The formats are documented in [Codex noninteractive mode](https://learn.chatgpt.com/docs/non-interactive-mode) and [Claude programmatic usage](https://code.claude.com/docs/en/headless).

## 5. A reusable Node.js runner

Save the following as `run-agent.mjs` in any project. It has no npm dependencies, removes alternate credentials from the child environment, forces Codex's ChatGPT login, and rejects Claude authentication that is not a recognized Claude subscription login. It passes prompts through stdin and prints the final answer.

**This example selects authentication; it does not enforce an included-usage cutoff.** Configure paid continuation as described above. Use the app-server approach in the next section when an application needs Codex account/quota checks before starting a turn.

```javascript
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const credentialOverrides = {
  codex: ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'],
  claude: [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_PROFILE',
  ],
};

function subscriptionEnvironment(provider) {
  const env = { ...process.env };

  for (const name of credentialOverrides[provider]) {
    delete env[name];
  }

  return env;
}

function runCli(command, args, options, input = '') {
  return new Promise((resolveOutput, reject) => {
    const child = execFile(
      command,
      args,
      {
        ...options,
        timeout: 10 * 60_000,
        maxBuffer: 8 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `${command} failed (${error.code ?? error.signal ?? 'process error'}). Check its login and usage status.`,
            ),
          );
          return;
        }

        resolveOutput(stdout);
      },
    );

    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}

async function runCodex(prompt, options) {
  const output = await runCli(
    'codex',
    [
      'exec',
      '--json',
      '--ephemeral',
      '--sandbox',
      'read-only',
      '--ignore-user-config',
      '-c',
      'model_provider="openai"',
      '-c',
      'forced_login_method="chatgpt"',
      '-',
    ],
    options,
    prompt,
  );

  const events = output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const completed = events.some((event) => event.type === 'turn.completed');
  const failed = events.some((event) => event.type === 'turn.failed' || event.type === 'error');

  if (!completed || failed) {
    throw new Error('Codex did not complete successfully.');
  }

  const answer = events
    .filter((event) => event.type === 'item.completed' && event.item?.type === 'agent_message')
    .at(-1)?.item.text;

  if (typeof answer !== 'string') throw new Error('Codex returned no final answer.');

  return answer;
}

async function runClaude(prompt, options) {
  const settings = ['--setting-sources', '', '--settings', '{"disableAllHooks":true}'];
  const status = JSON.parse(
    await runCli('claude', [...settings, 'auth', 'status', '--json'], options),
  );

  const knownPlans = new Set(['pro', 'max', 'ultra', 'team', 'enterprise']);
  const subscription =
    status.loggedIn === true &&
    status.authMethod === 'claude.ai' &&
    status.apiProvider === 'firstParty' &&
    knownPlans.has(status.subscriptionType);

  if (!subscription) {
    throw new Error(
      'Claude subscription authentication is absent or unrecognized. Run claude auth login --claudeai and verify the account.',
    );
  }

  const output = await runCli(
    'claude',
    [
      ...settings,
      '-p',
      '--output-format',
      'json',
      '--no-session-persistence',
      '--tools',
      '',
      '--permission-mode',
      'dontAsk',
      '--strict-mcp-config',
      '--mcp-config',
      '{"mcpServers":{}}',
    ],
    options,
    prompt,
  );

  const result = JSON.parse(output);

  if (result.is_error || result.type !== 'result' || typeof result.result !== 'string') {
    throw new Error('Claude did not return a successful text result.');
  }

  return result.result;
}

const [provider, directory = '.'] = process.argv.slice(2);

if (provider !== 'codex' && provider !== 'claude') {
  throw new Error('Usage: node run-agent.mjs <codex|claude> [project-directory] < prompt.txt');
}

const prompt = readFileSync(0, 'utf8');

if (!prompt.trim()) throw new Error('Provide a prompt through stdin.');

const options = { cwd: resolve(directory), env: subscriptionEnvironment(provider) };
const answer =
  provider === 'codex' ? await runCodex(prompt, options) : await runClaude(prompt, options);

process.stdout.write(`${answer}\n`);
```

Run it from a project directory:

```bash
printf '%s\n' 'Explain this repository without changing files.' | node run-agent.mjs codex .

printf '%s\n' 'Explain this TypeScript: const double = (n: number) => n * 2;' |
  node run-agent.mjs claude .
```

The runner's Codex invocation ignores user configuration while retaining the CLI's authentication home. Review project configuration and any nondefault credential-store requirements when adapting it. Claude's user/project/local settings are excluded, but managed settings still apply; the auth preflight uses the same settings and environment as the request. Unknown Claude auth fields or plan labels are rejected, so review compatibility when upgrading the CLI.

This small runner buffers output and applies a child-process timeout. A long-lived service should stream events and terminate the entire agent process tree when a job is cancelled or times out. Do not retry failed work with API credentials. Because the examples disable session persistence, later calls start new tasks; enable persistence and save session IDs if you need resumable conversations.

## 6. Use Codex app-server for account and usage checks

Use `codex exec` for simple requests. Use `codex app-server` when you need account inspection, quota checks, progress events, cancellation, or persistent conversations through one process. Both can use the saved ChatGPT login.

Start it with the same cleaned environment and provider selection as the shell helper:

```bash
codex_plan app-server --listen stdio://
```

Communicate using one JSON object per line over stdin/stdout. Keep stderr separate. Messages use the CLI's JSON-RPC-style envelope without a `jsonrpc` field. **Wait for each response and apply the checks before sending dependent requests.**

First initialize the connection:

<!-- prettier-ignore -->
```jsonl
{"id":1,"method":"initialize","params":{"clientInfo":{"name":"my_local_tool","title":"My Local Tool","version":"1.0.0"},"capabilities":null}}
```

After initialization succeeds, send `initialized`, read the account, then read its usage. Use the account result to require `account.type === "chatgpt"` before proceeding:

<!-- prettier-ignore -->
```jsonl
{"method":"initialized"}
{"id":2,"method":"account/read","params":{"refreshToken":false}}
{"id":3,"method":"account/rateLimits/read","params":null}
```

Here is a strict, reusable check for the **full result** of `account/rateLimits/read`:

```javascript
export function assertIncludedUsage(response) {
  if (response?.ordinaryUsageAllowed !== true) {
    throw new Error('Included usage is exhausted or could not be confirmed.');
  }

  const snapshot = response.rateLimitsByLimitId?.codex ?? response.rateLimits;
  const windows = [snapshot?.primary, snapshot?.secondary].filter(Boolean);

  if (!snapshot || windows.length === 0) {
    throw new Error('Codex usage windows are unavailable.');
  }

  const exhausted = windows.some(
    (window) =>
      !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent >= 100,
  );

  if (exhausted || snapshot.spendControlReached || snapshot.rateLimitReachedType) {
    throw new Error('The account has reached a usage or spending limit.');
  }
}
```

This policy deliberately refuses `false`, `null`, and missing `ordinaryUsageAllowed`. Older CLIs/backends that do not provide it need an explicit compatibility decision; do not turn an unknown result into permission to spend. Percentage changes or a passed reset timestamp alone do not establish recovery.

Once checks pass, list models. Choose an identifier returned by the account's model catalog:

<!-- prettier-ignore -->
```jsonl
{"id":4,"method":"model/list","params":{"cursor":null}}
```

Start a thread, replacing the model and working directory below. After receiving its ID, use that ID in `turn/start`:

<!-- prettier-ignore -->
```jsonl
{"id":5,"method":"thread/start","params":{"model":"<available-model-id>","cwd":"/absolute/path/to/project","sandbox":"read-only","approvalPolicy":"never","serviceTier":null}}
{"id":6,"method":"turn/start","params":{"threadId":"<returned-thread-id>","input":[{"type":"text","text":"Explain this repository without changing files.","text_elements":[]}],"serviceTierForTurn":"default"}}
```

`serviceTierForTurn: "default"` selects Standard speed for that turn. Permissions and service speed do not select the billing account. A listed model still needs to be accepted by the backend for the request.

Consume answer/progress notifications and require a successful `turn/completed` status. Monitor `account/rateLimits/updated`; interrupt the active turn if reported limits become exhausted, and re-read full usage before the next turn. Notifications may be sparse, so do not replace a complete snapshot with an incomplete event or assume another limit bucket describes Codex.

<!-- prettier-ignore -->
```jsonl
{"id":7,"method":"turn/interrupt","params":{"threadId":"<returned-thread-id>","turnId":"<active-turn-id>"}}
```

An app-server client must also match response IDs to pending requests, handle process exit and deadlines, and refuse or deliberately handle server-initiated approval requests. Save thread IDs for `thread/resume`. Client identity identifies your application; it is not a billing bypass.

These checks reduce accidental continuation but cannot provide a provider-enforced zero-credit guarantee. The protocol can evolve; verify fields against your installed CLI with `codex app-server generate-json-schema --out ./codex-schemas`. The [official app-server reference](https://learn.chatgpt.com/docs/app-server) documents transport and lifecycle details.

## 7. Keep local CLI login separate from application-managed sign-in

Reusing the official CLI's login does not require implementing an OAuth flow in your application. If you instead want your own **Sign in with ChatGPT** connection, that is a separate integration with consent, token storage/renewal, host identity, and app-specific usage controls. An authorized ChatGPT-plan OAuth token can use the Responses endpoint without being an API-key-billed request. See [OpenAI's application-managed plan integration](https://developers.openai.com/siwc/token-sharing-open-source).

For supported personal-account sharing connections, keep the permission allowing apps to use credits off when you only want included usage. These sharing controls do not automatically govern native CLI sessions. See [app usage and credit controls](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites).

For Claude, distinguish a user's own CLI session from a product routing requests on behalf of multiple users. Follow the current [Claude credential-use rules](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use) for product/hosted integrations. A personal subscription is not a general-purpose Claude API key or a shared service credential.

## 8. Troubleshoot the effective connection

| Symptom | What to inspect |
| --- | --- |
| Codex reports API-key authentication | Child-process credentials, selected provider/profile, saved login, and the authentication restriction. |
| Claude still uses an API key | Effective auth status, inherited environment, `apiKeyHelper`, managed settings, and gateway configuration. |
| Claude asks for an API key after adding `--bare` | Remove bare mode for the subscription-login path. |
| A signed-in subscription account spends extra credits | Included allowance, paid-continuation settings, other active sessions, and the account's seat/billing model. |
| CLI usage shows a dollar estimate | Compare it with actual provider billing/usage-credit activity; an estimated cost field is not a receipt. |
| The app cannot find the login | Executable path, OS user, authentication directory, credential-store access, and the server's inherited environment. |
| A task or app limit is reached | Wait for the relevant reset; reconnecting or switching wrappers does not replenish allowance. |

Use status commands and provider usage pages for diagnosis. Never log credential files or tokens. Confirm a small request's account and usage behavior before enabling scheduled or parallel jobs.
