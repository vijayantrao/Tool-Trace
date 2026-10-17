import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: '.', workers: 1, retries: 0, timeout: 1_800_000, outputDir: './results', reporter: 'line', use: { launchOptions: { executablePath: '/opt/pw-browsers/chromium' } } });
