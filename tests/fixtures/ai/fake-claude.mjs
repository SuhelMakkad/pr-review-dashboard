#!/usr/bin/env node
// Stand-in for `claude -p --output-format stream-json`: replays captured events with a known answer.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

process.stdin.resume();
process.stdin.on('end', () => {
  const lines = readFileSync(join(here, 'claude-stream.jsonl'), 'utf8').split('\n').filter(Boolean);

  for (const line of lines) {
    const event = JSON.parse(line);

    // A recorded answer, replayed as given; else the known one.
    if (event.type === 'result' && process.env.FAKE_CLAUDE_ANSWER) {
      event.structured_output = JSON.parse(readFileSync(process.env.FAKE_CLAUDE_ANSWER, 'utf8'));
    } else if (event.type === 'result') {
      event.structured_output = {
        summary: 'Fake claude answer',
        risk: 'medium',
        riskReasons: [`tools=${args[args.indexOf('--tools') + 1] === '' ? 'none' : 'some'}`],
        focusFiles: [],
        questions: [`GH_CONFIG_DIR set: ${Boolean(process.env.GH_CONFIG_DIR)}`],
      };
    }

    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
});
