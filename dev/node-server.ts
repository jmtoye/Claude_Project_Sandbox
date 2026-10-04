// Local Node server for development, testing and screenshots.
//
//   npm run dev                       # dev mode: local sign-in page, SQLite in .local/
//   SEED=synthetic npm run dev        # + 20 synthetic Work tiles (local DB only)
//
// Dev mode signs Cloudflare-Access-format JWTs with a local key so the production
// verification code path is exercised. Set ACCESS_TEAM_DOMAIN/ACCESS_AUD (and leave
// DEV_LOGIN unset) to run behind a real Cloudflare Tunnel + Access instead.
import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { mkdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { createApp } from '../src/server/app';
import { remoteJwks } from '../src/server/auth/access';
import { loadConfig, type Deps } from '../src/server/config';
import { SqliteDb } from '../src/server/sqlite-db';
import { runScheduled } from '../src/server/summary';
import { ClaudeLlm } from '../src/server/updater/llm';
import { hkDate } from '../src/server/time';
import { importProjects } from '../src/server/admin';
import { systemPrincipal } from '../src/server/auth/principal';
import { syntheticProjects } from '../scripts/synthetic';
import { createDevSigner, DEV_AUD, DEV_TEAM } from './devauth';

const ROOT = resolve(import.meta.dirname, '..');
const PORT = Number(process.env.PORT ?? 8787);
const DEV = process.env.DEV_LOGIN !== '0' && !process.env.ACCESS_TEAM_DOMAIN;
const DB_PATH = process.env.DB_PATH ?? join(ROOT, '.local', 'dev.sqlite');

export const DEV_USERS = {
  owner: process.env.OWNER_EMAIL ?? 'owner@dev.test',
  renata: 'renata@dev.test',
  workViewer: 'colleague.viewer@dev.test',
  workEditor: 'colleague.editor@dev.test',
  outsider: 'stranger@dev.test',
};

async function main() {
  mkdirSync(join(ROOT, '.local'), { recursive: true });
  const db = new SqliteDb(DB_PATH);
  db.migrate(join(ROOT, 'migrations'));
  const signer = DEV ? await createDevSigner() : null;
  const env = {
    ...process.env,
    ...(DEV ? { OWNER_EMAIL: DEV_USERS.owner, PERSONAL_ALLOWED_EMAILS: DEV_USERS.renata, ACCESS_TEAM_DOMAIN: DEV_TEAM, ACCESS_AUD: DEV_AUD, APP_URL: `http://localhost:${PORT}` } : {}),
  };
  const config = loadConfig(env);
  const clockOffset = Number(process.env.CLOCK_OFFSET_MS ?? 0);
  const deps: Deps = {
    db,
    config,
    now: () => new Date(Date.now() + clockOffset),
    fetch,
    jwks: signer ? signer.jwks : remoteJwks(config.accessJwksUrl, fetch),
    llm: config.anthropicKey ? new ClaudeLlm(config.anthropicKey, config.anthropicModel) : null,
  };

  if (DEV) await seedDev(deps, process.env.SEED === 'synthetic');

  const dist = join(ROOT, 'dist', 'client');
  const types: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json' };
  const assets = async (req: Request) => {
    const path = decodeURIComponent(new URL(req.url).pathname);
    let file = join(dist, path);
    if (!file.startsWith(dist) || !existsSync(file) || statSync(file).isDirectory()) file = join(dist, 'index.html');
    if (!existsSync(file)) return new Response('UI not built — run npm run build', { status: 404 });
    return new Response(readFileSync(file), { headers: { 'content-type': types[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' } });
  };

  const root = new Hono();
  if (DEV && signer) {
    // Dev-only sign-in that stands in for the Cloudflare Access login page.
    root.get('/__dev/login', async (c) => {
      const email = c.req.query('email');
      if (!email) {
        const links = Object.entries(DEV_USERS)
          .map(([k, e]) => `<li><a style="color:#7fb0ff" href="/__dev/login?email=${encodeURIComponent(e)}">${k}</a> — ${e}</li>`)
          .join('');
        return c.html(`<body style="background:#16181d;color:#eee;font:16px system-ui;padding:40px"><h1>Local sign-in (development only)</h1><p>In production, Cloudflare Access handles sign-in.</p><ul>${links}</ul>`);
      }
      const jwt = await signer.issue(email);
      c.header('set-cookie', `CF_Authorization=${jwt}; Path=/; HttpOnly; SameSite=Lax`);
      return c.redirect(c.req.query('next') ?? '/');
    });
    root.get('/__dev/logout', (c) => {
      c.header('set-cookie', 'CF_Authorization=; Path=/; Max-Age=0');
      return c.redirect('/__dev/login');
    });
    root.post('/__dev/cron', async (c) => c.json(await runScheduled(deps)));
  }
  const app = createApp(() => deps, { assets });
  root.route('/', app);

  serve({ fetch: root.fetch, port: PORT, hostname: process.env.HOST ?? '127.0.0.1' });
  console.log(`Dashboard on http://localhost:${PORT}${DEV ? '  (dev sign-in: /__dev/login)' : ''}`);

  // Hourly schedule (the Worker uses a Cron Trigger instead).
  if (process.env.CRON !== '0') {
    const tick = async () => {
      try {
        console.log('scheduled', JSON.stringify(await runScheduled(deps)));
      } catch (e) {
        console.error('scheduled run failed', e);
      }
    };
    const msToHour = 3_600_000 - (Date.now() % 3_600_000);
    setTimeout(() => {
      void tick();
      setInterval(tick, 3_600_000);
    }, msToHour);
  }
}

async function seedDev(deps: Deps, synthetic: boolean) {
  const now = deps.now().toISOString();
  const users: [string, string, [string, number][]][] = [
    [DEV_USERS.renata, 'Renata', [['personal', 0]]],
    [DEV_USERS.workViewer, 'Work Viewer', [['work', 0]]],
    [DEV_USERS.workEditor, 'Work Editor', [['work', 1]]],
  ];
  for (const [email, name, grants] of users) {
    const id = `u_dev_${email.split('@')[0].replace(/\W/g, '')}`;
    await deps.db.run("INSERT INTO users (id, email, name, status, created_at) VALUES (?, ?, ?, 'active', ?) ON CONFLICT(email) DO NOTHING", [id, email, name, now]);
    for (const [space, edit] of grants) await deps.db.run('INSERT INTO grants (user_id, space, can_edit, granted_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING', [id, space, edit, now]);
  }
  const owner = { ...systemPrincipal(), name: 'Owner (dev)', userId: 'u_dev_owner' };
  await deps.db.run("INSERT INTO users (id, email, name, is_owner, status, created_at) VALUES (?, ?, 'Owner', 1, 'active', ?) ON CONFLICT(email) DO NOTHING", ['u_dev_owner', DEV_USERS.owner, now]);
  const count = await deps.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM projects');
  if (synthetic && !count?.n) {
    const { work, personal } = syntheticProjects(hkDate(deps.now()));
    await importProjects(deps, owner, { projects: [...work, ...personal] });
    console.log(`Seeded ${work.length + personal.length} SYNTHETIC projects into ${DB_PATH}`);
  }
}

void main();
