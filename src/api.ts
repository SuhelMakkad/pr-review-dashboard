export async function api<T>(path: string, body?: unknown, method = 'POST'): Promise<T> {
  const response = await fetch(
    path,
    body === undefined
      ? {}
      : {
          method,
          headers: { 'Content-Type': 'application/json', 'X-Review-Desk': '1' },
          body: JSON.stringify(body),
        },
  );
  const result = await response.json();

  if (!response.ok)
    throw new Error(result.error ?? 'The local server could not complete this request.');

  return result as T;
}

export function relativeTime(value: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - Date.parse(value)) / 60_000));

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`;

  return `${Math.floor(minutes / 1440)}d ago`;
}

export function dateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function tomorrowMorning(): string {
  const next = new Date();

  next.setDate(next.getDate() + 1);
  next.setHours(9, 0, 0, 0);

  return next.toISOString();
}
