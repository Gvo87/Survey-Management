/**
 * Login-required surveys (Phase 3B, open question Q5: org members only).
 *
 * The respondent app runs on another origin than the admin app, so the admin session cookie never reaches
 * it (and shouldn't: that would need cross-site cookies and CORS with credentials). Instead:
 *
 * 1. The respondent app sends the member to the admin app (`/respond/{publicId}`), where they sign in with
 *    a password or SSO as usual.
 * 2. The admin app asks the API for a **handoff token**: signed, bound to the survey and user, valid for two
 *    minutes and usable once. It travels back in the URL fragment, which browsers never send to servers,
 *    logs or referrers, and the respondent app removes it from the address bar straight away.
 * 3. The respondent app exchanges it for a **respondent token** (12 hours, kept in sessionStorage) and the
 *    member's response key, which is derived from the survey and user: the same member resumes the same
 *    response on any device, and can't start a second one.
 *
 * Tokens are stateless HMACs; membership is checked again on every use, so removing a member stops them.
 */
import { randomBytes } from 'node:crypto';
import { hmac, safeEqual } from './security';

export const HANDOFF_TTL_S = 120;
export const RESPONDENT_TOKEN_TTL_S = 12 * 3600;

interface Payload {
  s: string; // survey id
  u: string; // user id
  e: number; // expiry, seconds since the epoch
  n?: string; // nonce (handoff only)
}

function sign(secret: string, purpose: string, payload: Payload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${hmac(secret, `${purpose}:${body}`)}`;
}

function verify(secret: string, purpose: string, token: string | undefined): Payload | null {
  if (typeof token !== 'string' || token.length > 1000) return null;
  const [body, signature, extra] = token.split('.');
  if (!body || !signature || extra !== undefined || !safeEqual(signature, hmac(secret, `${purpose}:${body}`))) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (typeof payload.s !== 'string' || typeof payload.u !== 'string' || typeof payload.e !== 'number') return null;
    return payload.e * 1000 > Date.now() ? payload : null;
  } catch {
    return null;
  }
}

const now = () => Math.floor(Date.now() / 1000);

export const signHandoff = (secret: string, surveyId: string, userId: string) =>
  sign(secret, 'respondent-handoff', { s: surveyId, u: userId, e: now() + HANDOFF_TTL_S, n: randomBytes(12).toString('base64url') });

export function verifyHandoff(secret: string, token: string | undefined) {
  const p = verify(secret, 'respondent-handoff', token);
  return p?.n ? { surveyId: p.s, userId: p.u, nonce: p.n, expiresAt: p.e } : null;
}

export const signRespondentToken = (secret: string, surveyId: string, userId: string) =>
  sign(secret, 'respondent', { s: surveyId, u: userId, e: now() + RESPONDENT_TOKEN_TTL_S });

export function verifyRespondentToken(secret: string, token: string | undefined, surveyId: string): string | null {
  const p = verify(secret, 'respondent', token);
  return p && p.s === surveyId ? p.u : null;
}

/** The member's response key for a survey: the same on every device, unknown to anyone else. */
export const memberResponseKey = (secret: string, surveyId: string, userId: string) => hmac(secret, `member-response:${surveyId}:${userId}`);
