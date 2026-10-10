import { defineConfig, devices } from '@playwright/test';

export const WEB_PORT = 3100;
export const API_PORT = 8090;
export const WEB_URL = `http://localhost:${WEB_PORT}`;
const DB_URL = process.env.E2E_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tooltrace_e2e';

const apiEnv = {
  NODE_ENV: 'test',
  PORT: String(API_PORT),
  DATABASE_URL: DB_URL,
  APP_URL: WEB_URL,
  RP_ID: 'localhost',
  RP_ORIGINS: WEB_URL,
  COOKIE_SECURE: 'false',
  AUTH_RATE_LIMIT_PER_MINUTE: '500',
};

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  timeout: 60_000,
  use: {
    baseURL: WEB_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      // Reset the e2e database first, then start the API.
      command: 'npx tsx ../web/e2e/prepare.ts && npx tsx src/index.ts',
      cwd: '../api',
      url: `http://localhost:${API_PORT}/healthz`,
      env: apiEnv,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npx next start -p ${WEB_PORT}`,
      url: `${WEB_URL}/login`,
      env: { API_URL: `http://localhost:${API_PORT}`, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});

export { apiEnv, DB_URL };
