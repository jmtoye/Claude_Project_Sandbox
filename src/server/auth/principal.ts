// Identity resolution and the permission model. Every data query that touches
// projects must use `projectScope()` so restricted projects never leave the server.
import type { Space } from '../../shared/types';
import { SPACES } from '../../shared/types';
import type { Deps } from '../config';
import { authConfigured } from '../config';
import { HttpError, forbidden, newId, sha256Hex } from '../util';
import { readAccessToken, verifyAccessJwt } from './access';

export interface Principal {
  userId: string;
  email: string;
  name: string;
  isOwner: boolean;
  grants: Partial<Record<Space, { canEdit: boolean }>>;
  via: 'access' | 'token' | 'dev';
  /** Set when authenticated by a personal access token. */
  tokenScope?: 'read' | 'write';
  summaryEmail: boolean;
}

/** A synthetic principal for scheduled jobs (sees everything, never exposed to a client). */
export function systemPrincipal(ownerId = 'system'): Principal {
  return { userId: ownerId, email: '', name: 'Automatic update', isOwner: true, grants: {}, via: 'dev', summaryEmail: false };
}

export function canView(p: Principal, space: Space): boolean {
  return p.isOwner || Boolean(p.grants[space]);
}

export function canEdit(p: Principal, space: Space): boolean {
  if (p.tokenScope === 'read') return false;
  return p.isOwner || Boolean(p.grants[space]?.canEdit);
}

export function canOwnerWrite(p: Principal): boolean {
  return p.isOwner && p.tokenScope !== 'read';
}

export function visibleSpaces(p: Principal): Space[] {
  return SPACES.filter((s) => canView(p, s));
}

/**
 * SQL predicate restricting projects to those this principal may see.
 * Non-owners never see "Only me" projects, nor spaces they were not granted.
 */
export function projectScope(p: Principal, alias = 'p'): { sql: string; params: unknown[] } {
  if (p.isOwner) return { sql: '1 = 1', params: [] };
  const spaces = visibleSpaces(p);
  if (spaces.length === 0) return { sql: '0 = 1', params: [] };
  return {
    sql: `${alias}.only_me = 0 AND ${alias}.space IN (${spaces.map(() => '?').join(', ')})`,
    params: spaces,
  };
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  is_owner: number;
  status: string;
  summary_email: number;
  last_seen_at: string | null;
}

async function loadPrincipal(deps: Deps, user: UserRow, via: Principal['via'], tokenScope?: 'read' | 'write'): Promise<Principal> {
  const isOwner = user.email === deps.config.ownerEmail;
  const grants: Principal['grants'] = {};
  if (!isOwner) {
    const rows = await deps.db.all<{ space: Space; can_edit: number }>(
      'SELECT space, can_edit FROM grants WHERE user_id = ?',
      [user.id],
    );
    for (const r of rows) {
      // Defence in depth: Personal access is only honoured for allow-listed emails.
      if (r.space === 'personal' && !deps.config.personalAllowed.has(user.email)) continue;
      grants[r.space] = { canEdit: r.can_edit === 1 };
    }
  }
  const now = deps.now();
  if (!user.last_seen_at || now.getTime() - Date.parse(user.last_seen_at) > 5 * 60_000) {
    await deps.db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', [now.toISOString(), user.id]);
  }
  return {
    userId: user.id,
    email: user.email,
    name: user.name || user.email.split('@')[0],
    isOwner,
    grants,
    via,
    tokenScope,
    summaryEmail: user.summary_email === 1,
  };
}

/** Finds the user for a verified email, creating the owner record on first sign-in. */
export async function principalForEmail(deps: Deps, email: string, via: Principal['via']): Promise<Principal> {
  const lower = email.toLowerCase();
  let user = await deps.db.first<UserRow>('SELECT * FROM users WHERE email = ?', [lower]);
  if (!user && lower === deps.config.ownerEmail) {
    const now = deps.now().toISOString();
    await deps.db.run(
      `INSERT INTO users (id, email, name, is_owner, status, summary_email, created_at)
       VALUES (?, ?, ?, 1, 'active', 1, ?) ON CONFLICT(email) DO NOTHING`,
      [newId('u_'), lower, '', now],
    );
    user = await deps.db.first<UserRow>('SELECT * FROM users WHERE email = ?', [lower]);
  }
  if (!user || user.status !== 'active') {
    throw new HttpError(403, `${lower} has not been invited to this dashboard.`, 'not_invited');
  }
  if (lower === deps.config.ownerEmail && user.is_owner !== 1) {
    await deps.db.batch([
      { sql: 'UPDATE users SET is_owner = 0 WHERE is_owner = 1 AND id <> ?', params: [user.id] },
      { sql: 'UPDATE users SET is_owner = 1 WHERE id = ?', params: [user.id] },
    ]);
  }
  return loadPrincipal(deps, user, via);
}

export const TOKEN_PREFIX = 'pd_';

export async function principalForToken(deps: Deps, token: string): Promise<Principal> {
  const hash = await sha256Hex(token);
  const row = await deps.db.first<UserRow & { token_id: string; scope: 'read' | 'write' }>(
    `SELECT u.*, t.id AS token_id, t.scope AS scope FROM api_tokens t JOIN users u ON u.id = t.user_id
     WHERE t.token_hash = ? AND t.revoked_at IS NULL`,
    [hash],
  );
  if (!row || row.status !== 'active') throw new HttpError(401, 'Invalid or revoked access token.', 'unauthenticated');
  await deps.db.run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', [deps.now().toISOString(), row.token_id]);
  return loadPrincipal(deps, row, 'token', row.scope);
}

/**
 * Authenticates a request. Order: personal access token (Authorization: Bearer pd_…),
 * then Cloudflare Access identity (header or CF_Authorization cookie). Fails closed.
 */
export async function authenticate(deps: Deps, req: Request): Promise<Principal> {
  const auth = req.headers.get('authorization') ?? '';
  const bearer = auth.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (bearer?.startsWith(TOKEN_PREFIX)) return principalForToken(deps, bearer);

  if (!authConfigured(deps.config)) {
    throw new HttpError(503, 'Sign-in is not configured on this deployment (see docs/SETUP.md).', 'auth_not_configured');
  }
  const jwt = readAccessToken(req);
  if (!jwt) throw new HttpError(401, 'Sign in required.', 'unauthenticated');
  const identity = await verifyAccessJwt(jwt, {
    aud: deps.config.accessAud,
    issuer: `https://${deps.config.accessTeamDomain}`,
    jwks: deps.jwks,
    now: deps.now(),
  });
  if (!identity) throw new HttpError(401, 'Your sign-in is invalid or has expired. Reload to sign in again.', 'unauthenticated');
  if (!identity.email) throw forbidden('Service-token requests must also present a personal access token.');
  return principalForEmail(deps, identity.email, 'access');
}
