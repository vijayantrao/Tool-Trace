/**
 * Records the product tour video against the stack configured like the public
 * demo: demo mode, the API behind the web proxy with a shared secret, a year of
 * synthetic history and a model run.
 *
 *   npm run tour -w apps/web      -> docs/demo/tooltrace-tour.mp4 (see scripts/make-demo-video.sh)
 */
import { defineConfig } from '@playwright/test';

export const TOUR_WEB_PORT = 3200;
export const TOUR_API_PORT = 8190;
export const TOUR_MQTT_PORT = 18834;
const WEB_URL = `http://localhost:${TOUR_WEB_PORT}`;
export const TOUR_DB_URL = process.env.TOUR_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/tooltrace_tour';
const PROXY_SECRET = 'tour-only-proxy-secret-0123456789abcdef';

export default defineConfig({
  testDir: './tour',
  workers: 1,
  retries: 0,
  reporter: 'list',
  timeout: 300_000,
  outputDir: './tour-results',
  use: {
    baseURL: WEB_URL,
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    launchOptions: process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {},
  },
  webServer: [
    {
      command: 'npx tsx ../web/tour/prepare.ts && npx tsx src/index.ts',
      cwd: '../api',
      url: `http://localhost:${TOUR_API_PORT}/healthz`,
      env: {
        NODE_ENV: 'development',
        PORT: String(TOUR_API_PORT),
        DATABASE_URL: TOUR_DB_URL,
        APP_URL: WEB_URL,
        RP_ID: 'localhost',
        RP_ORIGINS: WEB_URL,
        COOKIE_SECURE: 'false',
        DEMO_MODE: 'true',
        PROXY_SECRET,
        STATION_MASTER_KEY: 'b2'.repeat(32),
        DEV_MQTT_BROKER_PORT: String(TOUR_MQTT_PORT),
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `npx next start -p ${TOUR_WEB_PORT}`,
      url: `${WEB_URL}/login`,
      env: { API_URL: `http://localhost:${TOUR_API_PORT}`, API_PROXY_SECRET: PROXY_SECRET, NEXT_TELEMETRY_DISABLED: '1' },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
