import type { Db } from './db';
import type { JwksProvider } from './auth/access';
import type { Llm } from './updater/llm';

/** Raw environment bindings (Cloudflare `env` or process.env in Node). */
export interface EnvVars {
  OWNER_EMAIL?: string;
  PERSONAL_ALLOWED_EMAILS?: string;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
  /** Test/dev only: override where Access signing keys are fetched from. */
  ACCESS_JWKS_URL?: string;
  APP_URL?: string;
  ANTHROPIC_API_KEY?: string;
  ANTHROPIC_MODEL?: string;
  RESEND_API_KEY?: string;
  SUMMARY_FROM_EMAIL?: string;
  GITHUB_TOKEN?: string;
  NOTION_TOKEN?: string;
  REFRESH_SOURCE_BUDGET?: string;
}

export interface Config {
  ownerEmail: string;
  personalAllowed: Set<string>;
  accessTeamDomain: string;
  accessAud: string;
  accessJwksUrl: string;
  appUrl: string;
  anthropicKey: string;
  anthropicModel: string;
  resendKey: string;
  summaryFrom: string;
  githubToken: string;
  notionToken: string;
  sourceBudget: number;
}

const placeholder = (v: string) => !v || v.includes('REPLACE');

export function loadConfig(env: EnvVars): Config {
  const s = (v: string | undefined) => (v ?? '').trim();
  const team = s(env.ACCESS_TEAM_DOMAIN).replace(/^https?:\/\//, '').replace(/\/$/, '');
  return {
    ownerEmail: placeholder(s(env.OWNER_EMAIL)) ? '' : s(env.OWNER_EMAIL).toLowerCase(),
    personalAllowed: new Set(
      s(env.PERSONAL_ALLOWED_EMAILS)
        .split(',')
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean),
    ),
    accessTeamDomain: placeholder(team) ? '' : team,
    accessAud: placeholder(s(env.ACCESS_AUD)) ? '' : s(env.ACCESS_AUD),
    accessJwksUrl: s(env.ACCESS_JWKS_URL) || (team && !placeholder(team) ? `https://${team}/cdn-cgi/access/certs` : ''),
    appUrl: placeholder(s(env.APP_URL)) ? '' : s(env.APP_URL).replace(/\/$/, ''),
    anthropicKey: s(env.ANTHROPIC_API_KEY),
    anthropicModel: s(env.ANTHROPIC_MODEL) || 'claude-opus-5-5',
    resendKey: s(env.RESEND_API_KEY),
    summaryFrom: s(env.SUMMARY_FROM_EMAIL),
    githubToken: s(env.GITHUB_TOKEN),
    notionToken: s(env.NOTION_TOKEN),
    sourceBudget: Math.max(1, Number(env.REFRESH_SOURCE_BUDGET) || 40),
  };
}

export function authConfigured(c: Config): boolean {
  return Boolean(c.ownerEmail && c.accessTeamDomain && c.accessAud && c.accessJwksUrl);
}

export function emailConfigured(c: Config): boolean {
  return Boolean(c.resendKey && c.summaryFrom);
}

/** Everything a request or scheduled run needs. Injected so tests can control time, network and the LLM. */
export interface Deps {
  db: Db;
  config: Config;
  now: () => Date;
  fetch: typeof fetch;
  jwks: JwksProvider;
  llm: Llm | null;
}
