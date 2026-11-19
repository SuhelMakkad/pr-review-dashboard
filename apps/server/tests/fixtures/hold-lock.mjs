// Holds the data directory lock in a separate process until it is killed.
import { lockDataDirectory } from '@/db/lock.js';

lockDataDirectory(process.env.REVIEW_LOCK_DIRECTORY);
process.stdout.write('held\n');
setInterval(() => {}, 60_000);
