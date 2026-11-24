/**
 * Outgoing HTTP calls to customer-chosen URLs (webhooks, Slack). Every call:
 * - resolves the host name and refuses private, loopback, link-local and other reserved addresses (SSRF),
 * - connects to the address it checked, so a DNS answer can't change between check and connect,
 * - never follows redirects, times out after 10 s and reads at most 4 KB of the response.
 */
import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP, type LookupFunction } from 'node:net';

const blocked = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8],
  ['169.254.0.0', 16], // link-local, including cloud metadata (169.254.169.254)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved and broadcast
] as const)
  blocked.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [
  ['::', 128],
  ['::1', 128],
  ['64:ff9b::', 96], // NAT64 can reach IPv4 private ranges
  ['100::', 64],
  ['2001:db8::', 32],
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
] as const)
  blocked.addSubnet(net, bits, 'ipv6');

/** True for addresses an outgoing call must never reach. IPv4-mapped IPv6 is checked as IPv4. */
export function isPrivateAddress(address: string): boolean {
  const mapped = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return blocked.check(mapped[1]!, 'ipv4');
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) return blocked.check(address, 'ipv6');
  return true;
}

export class OutboundError extends Error {
  constructor(
    message: string,
    readonly code: 'blocked_address' | 'invalid_url' | 'timeout' | 'network',
  ) {
    super(message);
  }
}

/** Quick check when a URL is saved: the scheme, no credentials, and no private IP literal. */
export function checkOutboundUrl(raw: string, allowPrivate: boolean): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Enter a valid URL.';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Use an http:// or https:// URL.';
  if (url.username || url.password) return "URLs can't contain a user name or password.";
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (
    !allowPrivate &&
    (host === 'localhost' || host.endsWith('.localhost') || (isIP(host) && isPrivateAddress(host)))
  )
    return "Private and local network addresses aren't allowed.";
  return null;
}

export interface OutboundResponse {
  status: number;
  /** The first 4 KB of the body. */
  body: string;
  durationMs: number;
}

export async function postJson(
  rawUrl: string,
  body: string,
  options: { headers?: Record<string, string>; allowPrivate: boolean; timeoutMs?: number },
): Promise<OutboundResponse> {
  const problem = checkOutboundUrl(rawUrl, options.allowPrivate);
  if (problem)
    throw new OutboundError(problem, problem.startsWith('Private') ? 'blocked_address' : 'invalid_url');
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');

  // Resolve once, check every address, then connect to the checked one.
  let address: { address: string; family: number };
  try {
    const all = isIP(host)
      ? [{ address: host, family: isIP(host) }]
      : await lookup(host, { all: true, verbatim: true });
    if (all.length === 0) throw new Error('no address');
    if (!options.allowPrivate && all.some((a) => isPrivateAddress(a.address)))
      throw new OutboundError(`${host} resolves to a private or reserved address.`, 'blocked_address');
    address = all[0]!;
  } catch (error) {
    if (error instanceof OutboundError) throw error;
    throw new OutboundError(`Couldn't resolve ${host}.`, 'network');
  }
  const pinned: LookupFunction = (_hostname, opts, callback) => {
    if (opts.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };

  const started = Date.now();
  const timeoutMs = options.timeoutMs ?? 10_000;
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<OutboundResponse>((resolve, reject) => {
    const req = send(
      url,
      {
        method: 'POST',
        lookup: pinned,
        headers: {
          'content-type': 'application/json',
          'content-length': String(Buffer.byteLength(body)),
          'user-agent': 'SurveyPlatform-Webhooks/1.0',
          ...options.headers,
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          if (size < 4096) chunks.push(chunk);
          size += chunk.length;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8').slice(0, 4096),
            durationMs: Date.now() - started,
          }),
        );
        res.on('error', () =>
          reject(new OutboundError('The connection broke while reading the response.', 'network')),
        );
      },
    );
    req.on('timeout', () =>
      req.destroy(new OutboundError(`No response within ${timeoutMs / 1000} s.`, 'timeout')),
    );
    req.on('error', (error) =>
      reject(
        error instanceof OutboundError
          ? error
          : new OutboundError(`Couldn't connect: ${error.message}`, 'network'),
      ),
    );
    req.end(body);
  });
}

/**
 * Phase 3B: a `fetch` for identity-provider calls (OIDC discovery, keys and tokens). The issuer URL is chosen
 * by an org admin, so it gets the same protection as webhooks: addresses are resolved and checked, the
 * connection goes to the checked address, redirects aren't followed, and the body is capped at 1 MB.
 */
export async function guardedFetch(
  rawUrl: string,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; signal?: AbortSignal | null },
  allowPrivate: boolean,
): Promise<Response> {
  const problem = checkOutboundUrl(rawUrl, allowPrivate);
  if (problem) throw new OutboundError(problem, problem.startsWith('Private') ? 'blocked_address' : 'invalid_url');
  const url = new URL(rawUrl);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const all = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }).catch(() => []);
  if (all.length === 0) throw new OutboundError(`Couldn't resolve ${host}.`, 'network');
  if (!allowPrivate && all.some((a) => isPrivateAddress(a.address)))
    throw new OutboundError(`${host} resolves to a private or reserved address.`, 'blocked_address');
  const address = all[0]!;
  const pinned: LookupFunction = (_hostname, opts, callback) => {
    if (opts.all) callback(null, [address]);
    else callback(null, address.address, address.family);
  };
  const body =
    init.body === undefined || init.body === null
      ? undefined
      : typeof init.body === 'string'
        ? init.body
        : init.body instanceof URLSearchParams
          ? init.body.toString()
          : Buffer.from(init.body as ArrayBuffer);
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise<Response>((resolve, reject) => {
    const req = send(
      url,
      {
        method: init.method ?? 'GET',
        lookup: pinned,
        headers: { 'user-agent': 'SurveyPlatform-SSO/1.0', ...init.headers, ...(body !== undefined ? { 'content-length': String(Buffer.byteLength(body)) } : {}) },
        timeout: 10_000,
        signal: init.signal ?? undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 1024 * 1024) return req.destroy(new OutboundError('The response is too large.', 'network'));
          chunks.push(chunk);
        });
        res.on('end', () => {
          const headers = new Headers();
          for (const [name, value] of Object.entries(res.headers))
            if (value !== undefined) for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
          const status = res.statusCode ?? 502;
          const nullBody = status === 204 || status === 304 || (status >= 100 && status < 200);
          resolve(new Response(nullBody ? null : Buffer.concat(chunks), { status, headers }));
        });
        res.on('error', () => reject(new OutboundError('The connection broke while reading the response.', 'network')));
      },
    );
    req.on('timeout', () => req.destroy(new OutboundError('No response within 10 s.', 'timeout')));
    req.on('error', (error) => reject(error instanceof OutboundError ? error : new OutboundError(`Couldn't connect: ${error.message}`, 'network')));
    req.end(body);
  });
}
