// Cloudflare Worker entry point: HTTP requests + the hourly Cron Trigger.
import { createApp } from './app';
import { remoteJwks, type JwksProvider } from './auth/access';
import { loadConfig, type Deps, type EnvVars } from './config';
import { D1Db, type D1DatabaseLike } from './db';
import { runScheduled } from './summary';
import { ClaudeLlm } from './updater/llm';

interface WorkerEnv extends EnvVars {
  DB: D1DatabaseLike;
  ASSETS: { fetch(req: Request): Promise<Response> };
}
interface ExecutionContextLike {
  waitUntil(p: Promise<unknown>): void;
}

let jwks: { url: string; provider: JwksProvider } | null = null;

function makeDeps(env: WorkerEnv): Deps {
  const config = loadConfig(env);
  const f = fetch.bind(globalThis);
  if (!jwks || jwks.url !== config.accessJwksUrl) jwks = { url: config.accessJwksUrl, provider: remoteJwks(config.accessJwksUrl, f) };
  return {
    db: new D1Db(env.DB),
    config,
    now: () => new Date(),
    fetch: f,
    jwks: jwks.provider,
    llm: config.anthropicKey ? new ClaudeLlm(config.anthropicKey, config.anthropicModel, f) : null,
  };
}

const app = createApp((c) => makeDeps(c.env as WorkerEnv), {
  assets: async (req, c) => {
    const res = await (c.env as WorkerEnv).ASSETS.fetch(req);
    const out = new Response(res.body, res); // mutable copy so security headers can be added
    out.headers.set('cache-control', /\/assets\//.test(new URL(req.url).pathname) ? 'private, max-age=31536000, immutable' : 'no-store');
    return out;
  },
});

export default {
  fetch: (req: Request, env: WorkerEnv, ctx: ExecutionContextLike) => app.fetch(req, env, ctx as never),
  async scheduled(_controller: unknown, env: WorkerEnv, ctx: ExecutionContextLike) {
    const run = runScheduled(makeDeps(env)).then((r) => console.log('scheduled', JSON.stringify(r)));
    ctx.waitUntil(run);
    await run;
  },
};
