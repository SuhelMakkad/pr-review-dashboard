// A server stand-in that starts an agent for a run and waits to be killed. The agent starts a
// helper in its own process group that ignores SIGTERM, and both stay up.
import { mkdirSync } from 'node:fs';
import { spawnAgentProcess } from '@/ai/provider.js';

// The run's workspace, as a provider's would be: the agent works, and holds its lock, there.
const workDir = process.env.REVIEW_AGENT_WORKDIR;

mkdirSync(workDir, { recursive: true });

const helper =
  "const helper = require('child_process').spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { stdio: 'ignore' }); console.log(helper.pid); setInterval(() => {}, 1000);";

const agent = spawnAgentProcess(process.execPath, ['-e', helper], {
  cwd: workDir,
  env: process.env,
  lockFor: workDir,
  signal: new AbortController().signal,
  timeoutMs: 600_000,
  onLine: (line) => process.stdout.write(`helper ${line}\n`),
});

agent.done.catch(() => {});
setInterval(() => {}, 60_000);
