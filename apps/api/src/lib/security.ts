import { createHmac, timingSafeEqual } from 'node:crypto';

export function hmac(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('base64url');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** CSRF token bound to the session (synchronizer token, nothing stored). */
export const csrfTokenFor = (secret: string, sessionToken: string) => hmac(secret, `csrf:${sessionToken}`);

/** Token that marks responses from the builder's "test link" as test data. */
export const testTokenFor = (secret: string, surveyId: string) =>
  hmac(secret, `test:${surveyId}`).slice(0, 32);

/**
 * Salted, daily-rotating IP hash for rate limiting. Raw IPs of respondents are never stored;
 * these hashes only live in Redis with a short TTL.
 */
export function ipHash(secret: string, ip: string, now = new Date()): string {
  const day = now.toISOString().slice(0, 10);
  return hmac(secret, `ip:${day}:${ip}`).slice(0, 22);
}
