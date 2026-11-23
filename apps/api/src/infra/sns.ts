/**
 * Amazon SNS message verification for SES bounce and complaint notifications.
 * https://docs.aws.amazon.com/sns/latest/dg/sns-verify-signature-of-message.html
 *
 * The signing certificate is only fetched from an `sns.<region>.amazonaws.com` HTTPS URL, and
 * only messages from configured topic ARNs are accepted.
 */
import { createPublicKey, verify } from 'node:crypto';

export interface SnsMessage {
  Type: 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  SubscribeURL?: string;
  Token?: string;
}

export interface SnsVerifier {
  /** Returns the PEM certificate (or public key) at a validated SNS URL. */
  fetchCert(url: string): Promise<string>;
  /** Confirms a subscription by visiting its validated SubscribeURL. */
  confirm(url: string): Promise<void>;
}

const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isSnsUrl(value: string, pem = false): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname) && (!pem || url.pathname.endsWith('.pem'));
  } catch {
    return false;
  }
}

export function stringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(m.Subject !== undefined ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join('');
}

export async function verifySnsMessage(m: SnsMessage, verifier: SnsVerifier): Promise<boolean> {
  if (!['1', '2'].includes(m.SignatureVersion) || !isSnsUrl(m.SigningCertURL, true)) return false;
  const pem = await verifier.fetchCert(m.SigningCertURL);
  const key = createPublicKey(pem);
  return verify(m.SignatureVersion === '1' ? 'RSA-SHA1' : 'RSA-SHA256', Buffer.from(stringToSign(m)), key, Buffer.from(m.Signature, 'base64'));
}

export function createSnsVerifier(): SnsVerifier {
  const cache = new Map<string, string>();
  return {
    async fetchCert(url) {
      const hit = cache.get(url);
      if (hit) return hit;
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Certificate fetch failed: ${res.status}`);
      const pem = await res.text();
      cache.set(url, pem);
      return pem;
    },
    async confirm(url) {
      const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`Subscription confirmation failed: ${res.status}`);
    },
  };
}
