// A server stand-in that starts an agent for a run and waits to be killed. The agent starts a
// helper in its own process group that ignores SIGTERM, and both stay up.
import { tmpdir } from 'node:os';
import { spawnAgentProcess } from '@/ai/provider.js';

const helper =
  "const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); console.log(helper.pid); setInterval(() => {}, 1000);";

const agent = spawnAgentProcess(process.execPath, ['-e', helper], {
  cwd: tmpdir(),
  env: process.env,
  lockFor: process.env.REVIEW_AGENT_WORKDIR,
  signal: new AbortController().signal,
  timeoutMs: 600_000,
  onLine: (line) => process.stdout.write(`helper ${line}\n`),
});

agent.done.catch(() => {});
setInterval(() => {}, 60_000);
