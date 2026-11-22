import { parentPort } from 'node:worker_threads';
import { textPatch } from './patch.js';

/** A patch worker (see `PatchPool`): one pair of texts in, its patch out. */
parentPort!.on('message', (message: { oldText: string; newText: string }) => {
  parentPort!.postMessage(textPatch(message.oldText, message.newText));
});
