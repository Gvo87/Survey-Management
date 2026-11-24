/**
 * Single sign-on protocols (Phase 3B).
 *
 * - **OIDC**: authorization code flow with PKCE, `state` and `nonce` (openid-client). Discovery, keys and
 *   token calls go through the SSRF guard, because the issuer URL is chosen by an org admin.
 * - **SAML 2.0**: SP-initiated login over HTTP-Redirect, response over HTTP-POST (@node-saml/node-saml).
 *   Assertions must be signed by the configured certificate, answer a request we sent (InResponseTo, kept
 *   in Redis), be for our audience, and can be used once.
 *
 * Both return the same identity (subject, email, name); modules/sso.ts decides who that is.
 */
import { X509Certificate } from 'node:crypto';
import { generateServiceProviderMetadata, SAML, ValidateInResponseTo, type CacheProvider, type Profile } from '@node-saml/node-saml';
import * as oidc from 'openid-client';
import type { Redis } from 'ioredis';
import type { Deps } from '../deps';
import { guardedFetch } from '../lib/outbound';

export interface OidcConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
}
export interface SamlConfigStored {
  entryPoint: string;
  idpIssuer: string;
  idpCert: string;
}

export interface SsoIdentity {
  subject: string;
  email: string;
  /** False only when the identity provider says the address isn't verified. */
  emailVerified: boolean;
  name: string | null;
}

export class SsoError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const ssoUrls = (appUrl: string, connectionId: string) => ({
  oidcRedirectUri: `${appUrl}/api/v1/auth/sso/oidc/callback`,
  samlAcsUrl: `${appUrl}/api/v1/auth/sso/saml/acs`,
  /** The SP entity ID is also the metadata URL. */
  samlEntityId: `${appUrl}/api/v1/auth/sso/saml/${connectionId}/metadata`,
  loginUrl: `${appUrl}/api/v1/auth/sso/${connectionId}/start`,
});

// ── OIDC ─────────────────────────────────────────────────────────────────
const discovered = new Map<string, { at: number; config: oidc.Configuration }>();

async function oidcConfiguration(deps: Deps, cacheKey: string, stored: OidcConfig): Promise<oidc.Configuration> {
  const hit = discovered.get(cacheKey);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.config;
  const fetchImpl: oidc.CustomFetch = (url, options) =>
    guardedFetch(url, { method: options.method, headers: options.headers, body: options.body, signal: options.signal }, deps.config.allowPrivateUrls);
  let config: oidc.Configuration;
  try {
    config = await oidc.discovery(new URL(stored.issuer), stored.clientId, stored.clientSecret, undefined, {
      [oidc.customFetch]: fetchImpl,
      // Plain http only where private addresses are allowed (local development and tests).
      execute: deps.config.allowPrivateUrls && stored.issuer.startsWith('http:') ? [oidc.allowInsecureRequests] : [],
      timeout: 10,
    });
  } catch (error) {
    throw new SsoError('discovery_failed', `Couldn't read the identity provider's configuration at ${stored.issuer}: ${(error as Error).message}`.slice(0, 300));
  }
  config[oidc.customFetch] = fetchImpl;
  if (!cacheKey.startsWith('check:')) discovered.set(cacheKey, { at: Date.now(), config });
  return config;
}

/** Check an issuer when a connection is saved, so a typo shows up straight away. */
export async function checkOidcIssuer(deps: Deps, stored: OidcConfig): Promise<void> {
  await oidcConfiguration(deps, `check:${stored.issuer}:${Date.now()}`, stored);
}

export async function oidcAuthorizationUrl(deps: Deps, cacheKey: string, stored: OidcConfig, redirectUri: string, state: string) {
  const config = await oidcConfiguration(deps, cacheKey, stored);
  const codeVerifier = oidc.randomPKCECodeVerifier();
  const nonce = oidc.randomNonce();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri,
    scope: 'openid email profile',
    code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
    code_challenge_method: 'S256',
    state,
    nonce,
  });
  return { url: url.href, codeVerifier, nonce };
}

export async function oidcIdentity(
  deps: Deps,
  cacheKey: string,
  stored: OidcConfig,
  callbackUrl: URL,
  checks: { state: string; nonce: string; codeVerifier: string; redirectUri: string },
): Promise<SsoIdentity> {
  const config = await oidcConfiguration(deps, cacheKey, stored);
  let claims: oidc.IDToken | undefined;
  try {
    const tokens = await oidc.authorizationCodeGrant(
      config,
      callbackUrl,
      { pkceCodeVerifier: checks.codeVerifier, expectedState: checks.state, expectedNonce: checks.nonce, idTokenExpected: true },
    );
    claims = tokens.claims();
  } catch (error) {
    throw new SsoError('oidc_failed', `The identity provider's answer couldn't be verified: ${(error as Error).message}`.slice(0, 300));
  }
  const email = typeof claims?.email === 'string' ? claims.email : null;
  if (!claims || !email) throw new SsoError('no_email', "The identity provider didn't send an email address. Ask your IT team to include the email claim.");
  return {
    subject: claims.sub,
    email,
    emailVerified: claims.email_verified !== false,
    name: typeof claims.name === 'string' ? claims.name : null,
  };
}

// ── SAML ─────────────────────────────────────────────────────────────────
/** Request ids and assertion ids live in Redis, so every API instance accepts each response once. */
function redisCache(redis: Redis, prefix: string): CacheProvider {
  const key = (k: string) => `${prefix}${k}`;
  return {
    async saveAsync(k, value) {
      await redis.set(key(k), value, 'EX', 600);
      return { value, createdAt: Date.now() };
    },
    getAsync: (k) => redis.get(key(k)),
    removeAsync: async (k) => (k ? redis.getdel(key(k)) : null),
    consumeAsync: (k) => redis.getdel(key(k)),
    async saveIfAbsentAsync(k, value, expiresAtMs) {
      return (await redis.set(key(k), value, 'PX', Math.max(1000, expiresAtMs - Date.now()), 'NX')) === 'OK';
    },
  };
}

/** Accept PEM or bare base64 (as IdPs show it), and check it really is a certificate. */
export function normalizeCertificate(raw: string): string {
  const base64 = raw
    .replace(/-----(BEGIN|END) CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
  const pem = `-----BEGIN CERTIFICATE-----\n${base64.match(/.{1,64}/g)?.join('\n') ?? ''}\n-----END CERTIFICATE-----\n`;
  try {
    new X509Certificate(pem);
  } catch {
    throw new SsoError('invalid_certificate', "That isn't a valid X.509 certificate. Paste the identity provider's signing certificate (PEM or base64).");
  }
  return pem;
}

function samlClient(deps: Deps, connectionId: string, stored: SamlConfigStored): SAML {
  const urls = ssoUrls(deps.config.appUrl, connectionId);
  return new SAML({
    callbackUrl: urls.samlAcsUrl,
    entryPoint: stored.entryPoint,
    issuer: urls.samlEntityId,
    audience: urls.samlEntityId,
    idpIssuer: stored.idpIssuer,
    idpCert: stored.idpCert,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    validateInResponseTo: ValidateInResponseTo.always,
    requestIdExpirationPeriodMs: 10 * 60_000,
    rejectReplayedAssertions: true,
    cacheProvider: redisCache(deps.redis, `saml:${connectionId}:`),
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 5000,
  });
}

export const samlAuthorizationUrl = (deps: Deps, connectionId: string, stored: SamlConfigStored, relayState: string) =>
  samlClient(deps, connectionId, stored).getAuthorizeUrlAsync(relayState, {});

export function samlMetadata(deps: Deps, connectionId: string): string {
  const urls = ssoUrls(deps.config.appUrl, connectionId);
  return generateServiceProviderMetadata({
    issuer: urls.samlEntityId,
    callbackUrl: urls.samlAcsUrl,
    identifierFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
    wantAssertionsSigned: true,
  });
}

const firstString = (...values: unknown[]) => values.find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? null;

export async function samlIdentity(deps: Deps, connectionId: string, stored: SamlConfigStored, body: Record<string, string>): Promise<SsoIdentity> {
  let profile: Profile | null;
  try {
    ({ profile } = await samlClient(deps, connectionId, stored).validatePostResponseAsync(body));
  } catch (error) {
    throw new SsoError('saml_failed', `The identity provider's answer couldn't be verified: ${(error as Error).message}`.slice(0, 300));
  }
  if (!profile) throw new SsoError('saml_failed', 'The identity provider sent no login.');
  const claims = 'http://schemas.xmlsoap.org/ws/2005/05/identity/claims/';
  const email = firstString(
    profile.email,
    profile.mail,
    profile['urn:oid:0.9.2342.19200300.100.1.3'],
    profile[`${claims}emailaddress`],
    /@/.test(profile.nameID ?? '') ? profile.nameID : null,
  );
  if (!email) throw new SsoError('no_email', "The identity provider didn't send an email address. Ask your IT team to send it as the NameID or an email attribute.");
  const given = firstString(profile.givenName, profile[`${claims}givenname`]);
  const family = firstString(profile.surname, profile.sn, profile[`${claims}surname`]);
  return {
    subject: profile.nameID,
    email,
    emailVerified: true,
    name: firstString(profile.displayName, profile['http://schemas.microsoft.com/identity/claims/displayname'], profile[`${claims}name`]) ?? (given ? [given, family].filter(Boolean).join(' ') : null),
  };
}
