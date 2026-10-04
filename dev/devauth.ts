// Local-only stand-in for Cloudflare Access: an RSA key pair that signs Access-format
// JWTs, so development and tests exercise the exact production verification path.
import type { Jwk, JwksProvider } from '../src/server/auth/access';
import { b64url } from '../src/server/util';

export interface DevSigner {
  jwks: JwksProvider;
  sign(claims: Record<string, unknown>): Promise<string>;
  issue(email: string, opts?: { ttlSec?: number; aud?: string; iss?: string; now?: Date }): Promise<string>;
}

export const DEV_TEAM = 'dev-team.cloudflareaccess.com';
export const DEV_AUD = 'dev-audience-tag';

export async function createDevSigner(kid = 'dev-key-1'): Promise<DevSigner> {
  const pair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const jwk: Jwk = { kid, kty: 'RSA', n: pub.n!, e: pub.e!, alg: 'RS256' };
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const sign = async (claims: Record<string, unknown>) => {
    const head = enc({ alg: 'RS256', kid, typ: 'JWT' });
    const body = enc(claims);
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${head}.${body}`)));
    return `${head}.${body}.${b64url(sig)}`;
  };
  return {
    jwks: async () => [jwk],
    sign,
    issue: (email, o = {}) => {
      const now = Math.floor((o.now ?? new Date()).getTime() / 1000);
      return sign({ email, sub: `sub-${email}`, aud: [o.aud ?? DEV_AUD], iss: o.iss ?? `https://${DEV_TEAM}`, iat: now, nbf: now, exp: now + (o.ttlSec ?? 12 * 3600), type: 'app' });
    },
  };
}
