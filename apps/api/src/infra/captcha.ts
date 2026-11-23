/**
 * CAPTCHA verification (Cloudflare Turnstile). Optional per survey. The respondent's IP is not
 * sent to Cloudflare (the `remoteip` parameter is optional), to keep what leaves us to a minimum.
 */
export interface CaptchaVerifier {
  siteKey: string | null;
  verify(token: string): Promise<boolean>;
}

export function createTurnstileVerifier(siteKey: string | null, secret: string | null): CaptchaVerifier {
  return {
    siteKey,
    async verify(token) {
      if (!secret || !token || token.length > 2048) return false;
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ secret, response: token }),
        signal: AbortSignal.timeout(5000),
      }).catch(() => null);
      if (!res?.ok) return false;
      const data = (await res.json().catch(() => null)) as { success?: boolean } | null;
      return data?.success === true;
    },
  };
}

/** Test double: accepts the token "pass". */
export const fakeCaptcha: CaptchaVerifier = { siteKey: 'test-site-key', verify: async (token) => token === 'pass' };
