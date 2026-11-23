import { AppError } from './errors';

/** Coarse device class from a User-Agent. Nothing finer is stored. */
export function deviceType(userAgent: string | undefined): 'mobile' | 'tablet' | 'desktop' {
  const ua = userAgent ?? '';
  if (/iPad|Tablet|PlayBook|Silk|(Android(?!.*Mobile))/i.test(ua)) return 'tablet';
  if (/Mobi|iPhone|iPod|Android|BlackBerry|Opera Mini|IEMobile/i.test(ua)) return 'mobile';
  return 'desktop';
}

/** Truncate a timestamp to the hour (anonymous surveys). */
export function toHour(date: Date): Date {
  const d = new Date(date);
  d.setUTCMinutes(0, 0, 0);
  return d;
}

/** Keyset pagination cursor: opaque base64url of the sort values. */
export function encodeCursor(values: (string | number)[]): string {
  return Buffer.from(JSON.stringify(values)).toString('base64url');
}

export function decodeCursor(cursor: string | undefined, length: number): (string | number)[] | null {
  if (!cursor) return null;
  try {
    const values = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (Array.isArray(values) && values.length === length) return values as (string | number)[];
  } catch {
    // fall through
  }
  throw new AppError(400, 'invalid_cursor', 'The pagination cursor is invalid.');
}

export function slugify(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'org'
  );
}

export const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
