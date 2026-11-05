#!/usr/bin/env node
// Stand-in for `codex exec`: replays captured events and writes the structured answer to -o.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const output = args[args.indexOf('-o') + 1];
const here = dirname(fileURLToPath(import.meta.url));
const answer = {
  summary: 'Fake codex answer',
  risk: 'low',
  riskReasons: [],
  focusFiles: [],
  questions: [],
};

process.stdin.resume();
process.stdin.on('end', () => {
  for (const line of readFileSync(join(here, 'codex-exec.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)) {
    process.stdout.write(`${line}\n`);
  }

  writeFileSync(
    output,
    JSON.stringify({
      ...answer,
      questions: [`GH_TOKEN=${process.env.GH_TOKEN ?? 'unset'}`, `args=${args.join(' ')}`],
    }),
  );
});
