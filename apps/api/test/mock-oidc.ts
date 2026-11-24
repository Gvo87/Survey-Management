/**
 * A minimal OpenID Connect provider for tests (integration and end to end): discovery, JWKS, an authorize
 * endpoint that signs in `user` straight away, and a token endpoint that checks the client secret, the
 * redirect URI and PKCE, then returns an RS256-signed ID token. Node built-ins only, so the Playwright
 * suite can use it too. Stands in for Google, Okta or Entra ID; a check against a real provider needs an
 * account there.
 */
import { createHash, createSign, generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockOidcUser {
  sub: string;
  email: string;
  name?: string;
  emailVerified?: boolean;
}

const b64url = (input: Buffer | string) => Buffer.from(input).toString('base64url');

export async function startMockOidc(options: { clientId: string; clientSecret: string; host?: string }) {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...(publicKey.export({ format: 'jwk' }) as Record<string, string>), kid: 'mock-key-1', use: 'sig', alg: 'RS256' };
  const state = {
    user: { sub: 'user-1', email: 'someone@example.com', name: 'Some One' } as MockOidcUser,
    codes: new Map<string, { clientId: string; redirectUri: string; nonce: string; challenge: string; user: MockOidcUser }>(),
    tokenRequests: 0,
    authorizeRequests: [] as URLSearchParams[],
  };
  let issuer = '';

  const signJwt = (payload: Record<string, unknown>) => {
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: jwk.kid }));
    const body = b64url(JSON.stringify(payload));
    const signature = createSign('RSA-SHA256').update(`${header}.${body}`).sign(privateKey);
    return `${header}.${body}.${b64url(signature)}`;
  };

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === '/.well-known/openid-configuration')
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
      });
    if (url.pathname === '/jwks') return json(200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      state.authorizeRequests.push(url.searchParams);
      const redirectUri = url.searchParams.get('redirect_uri') ?? '';
      if (url.searchParams.get('client_id') !== options.clientId || url.searchParams.get('code_challenge_method') !== 'S256')
        return json(400, { error: 'invalid_request' });
      const code = randomBytes(16).toString('hex');
      state.codes.set(code, {
        clientId: options.clientId,
        redirectUri,
        nonce: url.searchParams.get('nonce') ?? '',
        challenge: url.searchParams.get('code_challenge') ?? '',
        user: state.user,
      });
      const back = new URL(redirectUri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state') ?? '');
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (chunk: Buffer) => (raw += chunk.toString('utf8')));
      req.on('end', () => {
        state.tokenRequests++;
        const form = new URLSearchParams(raw);
        const basic = /^Basic (.+)$/.exec(req.headers.authorization ?? '')?.[1];
        const [id, secret] = basic
          ? Buffer.from(basic, 'base64').toString('utf8').split(':').map(decodeURIComponent)
          : [form.get('client_id'), form.get('client_secret')];
        if (id !== options.clientId || secret !== options.clientSecret) return json(401, { error: 'invalid_client' });
        const grant = state.codes.get(form.get('code') ?? '');
        state.codes.delete(form.get('code') ?? '');
        const verifier = form.get('code_verifier') ?? '';
        if (!grant || grant.redirectUri !== form.get('redirect_uri') || b64url(createHash('sha256').update(verifier).digest()) !== grant.challenge)
          return json(400, { error: 'invalid_grant' });
        const now = Math.floor(Date.now() / 1000);
        return json(200, {
          access_token: randomBytes(16).toString('hex'),
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signJwt({
            iss: issuer,
            aud: options.clientId,
            sub: grant.user.sub,
            email: grant.user.email,
            email_verified: grant.user.emailVerified ?? true,
            name: grant.user.name,
            nonce: grant.nonce,
            iat: now,
            exp: now + 300,
          }),
        });
      });
      return;
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, options.host ?? '127.0.0.1', resolve));
  issuer = `http://${options.host ?? '127.0.0.1'}:${(server.address() as AddressInfo).port}`;
  return {
    issuer,
    state,
    setUser(user: MockOidcUser) {
      state.user = user;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
