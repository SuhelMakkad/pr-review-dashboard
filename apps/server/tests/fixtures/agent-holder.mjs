// A server stand-in that starts an agent, records it like the AI runner does, and waits to be
// killed. The agent starts a helper in its own process group that ignores SIGTERM, and both stay up.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { settingsJournal, spawnAgentProcess, useAgentGroupJournal } from '@/ai/provider.js';
import { Store } from '@/db/store.js';

const store = new Store(join(process.env.REVIEW_AGENT_DATA, 'state.sqlite'));
const helper =
  "const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); console.log(helper.pid); setInterval(() => {}, 1000);";

useAgentGroupJournal(settingsJournal(store));

const agent = spawnAgentProcess(process.execPath, ['-e', helper], {
  cwd: tmpdir(),
  env: process.env,
  signal: new AbortController().signal,
  timeoutMs: 600_000,
  onLine: (line) => process.stdout.write(`helper ${line}\n`),
});

agent.done.catch(() => {});
setInterval(() => {}, 60_000);
