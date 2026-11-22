// A stand-in patch worker for the pool's tests: answers after `delay:<ms>` in the old text, and
// crashes on `crash`.
import { parentPort } from 'node:worker_threads';

parentPort.on('message', ({ oldText, newText }) => {
  if (oldText === 'crash') throw new Error('The worker crashed.');

  const delay = Number(/^delay:(\d+)/.exec(oldText)?.[1] ?? 0);

  setTimeout(
    () => parentPort.postMessage({ patch: `${oldText} -> ${newText}`, additions: 1, deletions: 1 }),
    delay,
  );
});
