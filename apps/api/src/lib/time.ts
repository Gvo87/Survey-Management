/**
 * Time zone arithmetic with Intl only (no tz library): campaigns send "at 9:00 in the creator's time
 * zone" and scheduled reports run at a local hour, across DST changes.
 */

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Wall-clock parts of an instant in a time zone. weekday: 1 (Monday) to 7. */
export function zonedParts(date: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')),
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(get('weekday')) + 1,
  };
}

/** How far the zone's wall clock is ahead of UTC at this instant, in ms. */
function offsetMs(date: Date, tz: string): number {
  const p = zonedParts(date, tz);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(date.getTime() / 1000) * 1000;
}

/** The instant when the wall clock in `tz` shows this date and time. */
export function zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): Date {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const first = wall - offsetMs(new Date(wall), tz);
  // Re-check with the offset at the candidate instant (correct across a DST change).
  return new Date(wall - offsetMs(new Date(first), tz));
}

/** Parse "YYYY-MM-DDTHH:mm" as local time in `tz`. */
export function localDateTimeToUtc(local: string, tz: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error('Invalid local date-time');
  return zonedTimeToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), tz);
}

export interface Recurrence {
  frequency: 'daily' | 'weekly' | 'monthly';
  /** weekly: 1 (Monday) to 7; monthly: 1 to 28. */
  day: number | null;
  hour: number;
  timezone: string;
}

/** The first run strictly after `after`. */
export function nextRun(r: Recurrence, after: Date): Date {
  const start = zonedParts(after, r.timezone);
  for (let i = 0; i < 70; i++) {
    // Walk calendar days in the zone (noon UTC of the local date avoids DST edge cases).
    const date = new Date(Date.UTC(start.year, start.month - 1, start.day + i, 12));
    const y = date.getUTCFullYear();
    const mo = date.getUTCMonth() + 1;
    const d = date.getUTCDate();
    const weekday = ((date.getUTCDay() + 6) % 7) + 1;
    if (r.frequency === 'weekly' && weekday !== r.day) continue;
    if (r.frequency === 'monthly' && d !== r.day) continue;
    const candidate = zonedTimeToUtc(y, mo, d, r.hour, 0, r.timezone);
    if (candidate.getTime() > after.getTime()) return candidate;
  }
  throw new Error('No next run found');
}
