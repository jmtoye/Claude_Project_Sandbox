// Verifies Cloudflare Access identity tokens (RS256 JWTs) on every request.
// Docs: https://developers.cloudflare.com/cloudflare-one/identity/authorization-cookie/validating-json/
import { b64urlDecode } from '../util';

export interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}
export type JwksProvider = (forceRefresh?: boolean) => Promise<Jwk[]>;

export function remoteJwks(url: string, fetchFn: typeof fetch, ttlMs = 3_600_000): JwksProvider {
  let cache: { keys: Jwk[]; at: number } | null = null;
  return async (force = false) => {
    if (!url) throw new Error('Access signing-key URL is not configured');
    // Forced refreshes (unknown key id) are rate-limited so junk tokens cannot trigger a fetch per request.
    if (cache && Date.now() - cache.at < (force ? 60_000 : ttlMs)) return cache.keys;
    const res = await fetchFn(url, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Fetching Access signing keys failed: HTTP ${res.status}`);
    const body = (await res.json()) as { keys?: Jwk[] };
    cache = { keys: body.keys ?? [], at: Date.now() };
    return cache.keys;
  };
}

export interface AccessIdentity {
  email: string | null;
  sub: string;
  /** Service-token logins carry no email. */
  service: boolean;
}

export interface VerifyOptions {
  aud: string;
  issuer: string;
  jwks: JwksProvider;
  now: Date;
}

const keyCache = new Map<string, CryptoKey>();

async function importKey(jwk: Jwk): Promise<CryptoKey> {
  const cacheKey = `${jwk.kid}:${jwk.n.slice(0, 32)}`;
  const hit = keyCache.get(cacheKey);
  if (hit) return hit;
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  keyCache.set(cacheKey, key);
  return key;
}

function decodeJson(part: string): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(part)));
}

/** Returns the verified identity, or null for any invalid, expired or foreign token. */
export async function verifyAccessJwt(token: string, opts: VerifyOptions): Promise<AccessIdentity | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  let header: Record<string, unknown>;
  let payload: Record<string, unknown>;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;

  let keys = await opts.jwks();
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await opts.jwks(true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) return null;

  let ok = false;
  try {
    ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await importKey(jwk), b64urlDecode(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  } catch {
    return null; // malformed signature encoding
  }
  if (!ok) return null;

  const nowSec = Math.floor(opts.now.getTime() / 1000);
  const leeway = 60;
  const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!aud.includes(opts.aud)) return null;
  if (payload.iss !== opts.issuer) return null;
  if (typeof payload.exp !== 'number' || payload.exp + leeway < nowSec) return null;
  if (typeof payload.nbf === 'number' && payload.nbf - leeway > nowSec) return null;

  const email = typeof payload.email === 'string' && payload.email ? payload.email.toLowerCase() : null;
  return { email, sub: String(payload.sub ?? ''), service: !email };
}

export function readAccessToken(req: Request): string | null {
  const header = req.headers.get('cf-access-jwt-assertion');
  if (header) return header;
  const cookie = req.headers.get('cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  if (!m) return null;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return null;
  }
}
