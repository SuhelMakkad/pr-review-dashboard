#!/usr/bin/env node
// Stand-in for `codex app-server`: answers JSON-RPC on stdio and replays a captured turn.
// Scenarios come from the environment:
//   FAKE_CODEX_ACCOUNT  chatgpt (default) | apiKey | none
//   FAKE_CODEX_LIMIT    ok (default) | reached | midrun | afteranswer
//   FAKE_CODEX_MCP      off (default) | stuck
//   FAKE_CODEX_STALL    1 to go silent once the turn starts
//   FAKE_CODEX_SOL      1 to also offer gpt-6.1-sol
//   FAKE_CODEX_CREDITS  balance after the run (default: unchanged)
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const scenario = {
  account: process.env.FAKE_CODEX_ACCOUNT ?? 'chatgpt',
  limit: process.env.FAKE_CODEX_LIMIT ?? 'ok',
  mcp: process.env.FAKE_CODEX_MCP ?? 'off',
  creditsAfter: process.env.FAKE_CODEX_CREDITS ?? null,
};
const seen = { clientInfo: null, thread: null, turn: null, declined: false, interrupted: false };
let limitReads = 0;
const historyPath = join(process.cwd(), '.fake-codex-history.json');
let history = null;

const saveHistory = () => {
  if (history && !history.options.ephemeral) writeFileSync(historyPath, JSON.stringify(history));
};

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const notify = (method, params) => send({ method, params });

const snapshot = (usedPercent, balance) => ({
  limitId: 'codex',
  limitName: null,
  primary: { usedPercent, windowDurationMins: 300, resetsAt: 1_900_000_000 },
  secondary: { usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_900_500_000 },
  credits: { hasCredits: true, unlimited: false, balance },
  individualLimit: null,
  spendControlReached: false,
  planType: 'plus',
  rateLimitReachedType: usedPercent >= 100 ? 'rate_limit_reached' : null,
});

const answer = () => ({
  summary: 'Fake codex answer',
  risk: 'low',
  riskReasons: [],
  focusFiles: [],
  questions: [
    `GH_TOKEN=${process.env.GH_TOKEN ?? 'unset'}`,
    `CODEX_API_KEY=${process.env.CODEX_API_KEY ?? 'unset'}`,
    `OPENAI_API_KEY=${process.env.OPENAI_API_KEY ?? 'unset'}`,
    `args=${args.join(' ')}`,
    `client=${seen.clientInfo?.name}`,
    `thread=${JSON.stringify(seen.thread)}`,
    `turn=${JSON.stringify({ ...seen.turn, input: undefined })}`,
    `declined=${seen.declined}`,
    `originator=${process.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE}`,
  ],
});

/** Replays the captured turn, with this scenario's answer and limits. */
function playTurn() {
  const lines = readFileSync(join(here, 'codex-app-server.jsonl'), 'utf8').split('\n');

  for (const line of lines.filter(Boolean)) {
    const message = JSON.parse(line);

    if (message.method === 'thread/started' || message.method === 'turn/completed') continue;

    if (message.method === 'account/rateLimits/updated') {
      // This run used the last of the plan: the finished answer still counts.
      if (scenario.limit === 'afteranswer') {
        notify('account/rateLimits/updated', { rateLimits: snapshot(100, '100.0') });
        continue;
      }

      continue;
    }

    // The plan runs out while Codex is still reading code: the run must stop and interrupt the
    // turn, which then never answers.
    if (
      scenario.limit === 'midrun' &&
      message.method === 'item/completed' &&
      message.params.item.type === 'commandExecution'
    ) {
      notify('account/rateLimits/updated', { rateLimits: snapshot(100, '100.0') });

      return;
    }

    if (message.method === 'item/completed' && message.params.item.type === 'agentMessage') {
      // A recorded answer, replayed as given; else the known one.
      message.params.item.text = process.env.FAKE_CODEX_ANSWER
        ? readFileSync(process.env.FAKE_CODEX_ANSWER, 'utf8')
        : JSON.stringify(answer());
      history.turn.items.push(message.params.item);
    }

    send(message);
  }

  history.turn.status = 'completed';
  saveHistory();
  notify('turn/completed', {
    threadId: 'thread-1',
    turn: { id: 'turn-1', items: [], status: 'completed', error: null },
  });
}

const handlers = {
  initialize: (params) => {
    seen.clientInfo = params.clientInfo;

    return { userAgent: 'fake', codexHome: '/fake', platformFamily: 'unix', platformOs: 'macos' };
  },
  'account/read': () => ({
    account:
      scenario.account === 'none'
        ? null
        : scenario.account === 'apiKey'
          ? { type: 'apiKey' }
          : { type: 'chatgpt', email: null, planType: 'plus' },
    requiresOpenaiAuth: true,
  }),
  'account/rateLimits/read': () => {
    limitReads += 1;

    const balance = limitReads > 1 && scenario.creditsAfter ? scenario.creditsAfter : '100.0';
    const codex = snapshot(scenario.limit === 'reached' ? 100 : 40, balance);

    return {
      rateLimits: codex,
      rateLimitsByLimitId: { codex },
      rateLimitResetCredits: null,
      accountId: null,
      rateLimitUpsell: null,
    };
  },
  'config/read': () => ({
    config: { model: 'pinned-model', mcp_servers: { linear: { command: 'linear-mcp' } } },
    origins: {},
    layers: null,
  }),
  'model/list': () => ({
    data: [
      { model: 'gpt-fake', displayName: 'GPT-Fake', hidden: false, isDefault: true },
      { model: 'gpt-fake-mini', displayName: 'GPT-Fake Mini', hidden: false, isDefault: false },
      { model: 'gpt-secret', displayName: 'Secret', hidden: true, isDefault: false },
      ...(process.env.FAKE_CODEX_SOL
        ? [{ model: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false, isDefault: false }]
        : []),
    ],
    nextCursor: null,
  }),
  'thread/start': (params) => {
    seen.thread = params;
    history = { options: params, turn: null, turnStarts: 0 };
    saveHistory();

    if (scenario.mcp === 'stuck') {
      setTimeout(() =>
        notify('mcpServer/startupStatus/updated', {
          threadId: 'thread-1',
          name: 'linear',
          status: 'starting',
          error: null,
          failureReason: null,
        }),
      );
    }

    return { thread: { id: 'thread-1' }, model: params.model ?? 'pinned-model' };
  },
  'thread/resume': (params) => {
    if (!existsSync(historyPath) || process.env.FAKE_CODEX_RESUME_FAIL)
      throw new Error('Saved thread not found.');

    history = JSON.parse(readFileSync(historyPath, 'utf8'));
    seen.thread = { ...params, resumed: true };

    return {
      thread: { id: 'thread-1', status: { type: 'idle' } },
      model: params.model ?? history.options.model,
    };
  },
  'thread/turns/list': () => ({ data: history?.turn ? [history.turn] : [], nextCursor: null }),
  'turn/start': (params) => {
    seen.turn = params;
    history.turn = { id: 'turn-1', status: 'inProgress', items: [], input: params.input };
    history.turnStarts += 1;
    saveHistory();
    writeFileSync(join(process.cwd(), '.fake-turn-started'), 'yes');

    // An approval request must be declined (runs are unattended); the turn plays once it is. The
    // MCP tripwire must stop the run before anything else happens.
    if (scenario.mcp !== 'stuck' && !process.env.FAKE_CODEX_STALL) {
      send({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: {} });
    }

    return { turn: { id: 'turn-1', items: [], status: 'inProgress', error: null } };
  },
  'turn/interrupt': () => {
    seen.interrupted = true;
    if (history?.turn) history.turn.status = 'interrupted';
    saveHistory();
    // Visible to the test: the run's working directory is this process's cwd.
    writeFileSync(join(process.cwd(), 'interrupted'), 'yes');
    notify('turn/completed', {
      threadId: 'thread-1',
      turn: { id: 'turn-1', items: [], status: 'interrupted', error: null },
    });

    return {};
  },
};

createInterface({ input: process.stdin }).on('line', (line) => {
  const message = JSON.parse(line);

  // Replies to requests this server sent.
  if (message.method === undefined) {
    if (message.id === 'approval-1') {
      seen.declined = Boolean(message.error);
      playTurn();
    }

    return;
  }

  if (message.id === undefined) return; // Client notifications such as `initialized`.

  const handler = handlers[message.method];

  if (!handler) {
    send({ id: message.id, error: { code: -32601, message: `Unknown method ${message.method}` } });

    return;
  }

  try {
    send({ id: message.id, result: handler(message.params) });
  } catch (error) {
    send({ id: message.id, error: { code: -32000, message: error.message } });
  }
});
