const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Compact relative age: "now", "5m", "3h", "2d", "3w". */
export function shortAge(value: string | number, now = Date.now()): string {
  const elapsed = Math.max(0, now - (typeof value === 'number' ? value : Date.parse(value)));

  if (elapsed < MINUTE) return 'now';
  if (elapsed < HOUR) return `${Math.floor(elapsed / MINUTE)}m`;
  if (elapsed < DAY) return `${Math.floor(elapsed / HOUR)}h`;
  if (elapsed < 14 * DAY) return `${Math.floor(elapsed / DAY)}d`;

  return `${Math.floor(elapsed / (7 * DAY))}w`;
}

const relativeFormat = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** Natural relative phrase: "5 minutes ago", "yesterday", "in 2 hours". */
export function relativePhrase(value: string, now = Date.now()): string {
  const delta = Date.parse(value) - now;
  const abs = Math.abs(delta);

  if (abs < MINUTE) return 'just now';
  if (abs < HOUR) return relativeFormat.format(Math.round(delta / MINUTE), 'minute');
  if (abs < DAY) return relativeFormat.format(Math.round(delta / HOUR), 'hour');
  if (abs < 30 * DAY) return relativeFormat.format(Math.round(delta / DAY), 'day');

  return relativeFormat.format(Math.round(delta / (30 * DAY)), 'month');
}

export function dateTime(value: string): string {
  return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function shortDateTime(value: string, now = Date.now()): string {
  const date = new Date(value);
  const sameDay = new Date(now).toDateString() === date.toDateString();
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

  if (sameDay) return `today ${time}`;
  if (new Date(now + DAY).toDateString() === date.toDateString()) return `tomorrow ${time}`;

  return `${date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} ${time}`;
}

function at(base: Date, hours: number, minutes = 0): Date {
  const date = new Date(base);

  date.setHours(hours, minutes, 0, 0);

  return date;
}

function addDays(base: Date, days: number): Date {
  const date = new Date(base);

  date.setDate(date.getDate() + days);

  return date;
}

export interface SnoozeOption {
  key: string;
  label: string;
  until: Date;
}

/** Quick snooze presets, numbered 1–4 in the snooze menu. */
export function snoozePresets(now = new Date()): SnoozeOption[] {
  const today = new Date(now);
  const afternoon = at(today, 14);
  const evening = at(today, 18);
  const later =
    afternoon.getTime() - now.getTime() > HOUR
      ? { key: 'afternoon', label: 'This afternoon', until: afternoon }
      : evening.getTime() - now.getTime() > HOUR
        ? { key: 'evening', label: 'This evening', until: evening }
        : {
            key: 'tomorrow-afternoon',
            label: 'Tomorrow afternoon',
            until: at(addDays(today, 1), 14),
          };
  const daysToMonday = (8 - today.getDay()) % 7 || 7;

  return [
    { key: 'hour', label: 'In 1 hour', until: new Date(now.getTime() + HOUR) },
    later,
    { key: 'tomorrow', label: 'Tomorrow morning', until: at(addDays(today, 1), 9) },
    {
      key: 'monday',
      label: daysToMonday <= 2 ? 'Monday morning' : 'Next week',
      until: at(addDays(today, daysToMonday), 9),
    },
  ];
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

function parseClock(text: string): { hours: number; minutes: number } | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text.trim());

  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] ?? 0);
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;
  if (!meridiem && !match[2] && hours < 7) hours += 12;
  if (hours > 23 || minutes > 59) return null;

  return { hours, minutes };
}

/**
 * Parses snooze phrases such as "2h", "in 30 min", "tomorrow", "tomorrow 2pm", "fri", "fri 14:00",
 * "next week", "tonight" or "4pm". Returns null when the text is not understood or is not in the
 * future.
 */
export function parseSnooze(input: string, now = new Date()): Date | null {
  const text = input
    .trim()
    .toLowerCase()
    .replace(/^in\s+/, '')
    .replace(/\s+/g, ' ');

  if (!text) return null;

  const duration =
    /^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days|w|wk|week|weeks)$/.exec(
      text,
    );

  if (duration) {
    const amount = Number(duration[1]);
    const unit = duration[2][0];
    const size = unit === 'm' ? MINUTE : unit === 'h' ? HOUR : unit === 'd' ? DAY : 7 * DAY;
    const until = new Date(now.getTime() + amount * size);

    return amount > 0 ? until : null;
  }

  const [head, ...rest] = text.split(' ');
  const clock = rest.length ? parseClock(rest.join(' ')) : null;

  if (rest.length && !clock && head !== 'next') return null;

  const withClock = (date: Date, fallbackHours = 9) =>
    at(date, clock?.hours ?? fallbackHours, clock?.minutes ?? 0);

  let result: Date | null = null;

  if (head === 'tomorrow' || head === 'tmr' || head === 'tmrw') result = withClock(addDays(now, 1));
  else if (head === 'tonight' || head === 'evening') result = withClock(now, 18);
  else if (head === 'afternoon') result = withClock(now, 14);
  else if (head === 'today') result = withClock(now, 17);
  else if (text === 'next week') result = at(addDays(now, (8 - now.getDay()) % 7 || 7), 9);
  else {
    const weekday = WEEKDAYS.findIndex((day) => day.startsWith(head) && head.length >= 3);

    if (weekday >= 0) {
      const days = (weekday - now.getDay() + 7) % 7 || 7;

      result = withClock(addDays(now, days));
    } else {
      const only = parseClock(text);

      if (only) {
        const today = at(now, only.hours, only.minutes);

        result = today.getTime() > now.getTime() ? today : addDays(today, 1);
      }
    }
  }

  return result && result.getTime() > now.getTime() ? result : null;
}
