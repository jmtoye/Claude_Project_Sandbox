import { defineConfig } from '@playwright/test';
import { existsSync } from 'node:fs';

const PORT = 8790;
const exe = process.env.CHROMIUM_PATH ?? (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    launchOptions: exe ? { executablePath: exe } : {},
  },
  webServer: {
    // Synthetic projects in a throwaway local database — never the live dashboard.
    command: `rm -f .local/e2e.sqlite* && mkdir -p .local && npm run build && DEV_LOGIN=1 DB_PATH=.local/e2e.sqlite SEED=synthetic CRON=0 PORT=${PORT} npx tsx dev/node-server.ts`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 120_000,
  },
});
