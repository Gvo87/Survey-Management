// Verify a Survey Platform webhook (Node.js 18+). Use the raw request body, exactly as received,
// not a re-serialised JSON object. The integration tests run this file against real deliveries.
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * @param {string} secret   The endpoint's signing secret (whsec_…).
 * @param {Record<string, string | string[] | undefined>} headers  Request headers, lower-case names.
 * @param {string} rawBody  The body as received.
 * @param {number} [toleranceSec]  Reject deliveries older than this (replay protection).
 * @returns {boolean}
 */
export function verifyWebhook(secret, headers, rawBody, toleranceSec = 300) {
  const timestamp = Number(headers['survey-webhook-timestamp']);
  const signatures = String(headers['survey-webhook-signature'] ?? '');
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > toleranceSec) return false;
  const expected = Buffer.from(createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex'));
  // After a secret rotation there are two `v1=` values for 24 hours: accept either.
  return signatures.split(' ').some((part) => {
    const given = Buffer.from(part.replace(/^v1=/, ''));
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
