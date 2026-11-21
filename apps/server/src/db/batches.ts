/** Rows per multi-row INSERT, well under SQLite's limit on bound parameters. */
const BATCH_SIZE = 200;

export function* batches<T>(rows: T[]): Generator<T[]> {
  for (let start = 0; start < rows.length; start += BATCH_SIZE) {
    yield rows.slice(start, start + BATCH_SIZE);
  }
}
