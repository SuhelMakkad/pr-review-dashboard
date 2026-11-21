/** The HTTP methods the forges' CLIs send. */
export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

/**
 * An HTTP response as `gh api --include` and `glab api --include` print it: the status line, the
 * headers, then the body. Null when the output does not start with a status line.
 */
export function parseIncludedResponse(
  output: string,
): { status: number; headers: Record<string, string>; body: string } | null {
  const match = /^HTTP\/[\d.]+ (\d{3})[^\n]*\r?\n/.exec(output);

  if (!match) return null;

  const separator = output.search(/\r?\n\r?\n/);
  const head = separator === -1 ? output : output.slice(0, separator);
  const body = separator === -1 ? '' : output.slice(separator).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};

  for (const line of head.split(/\r?\n/).slice(1)) {
    const index = line.indexOf(':');

    if (index > 0)
      headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }

  return { status: Number(match[1]), headers, body };
}
