// Makes the phone's fake camera feed: the real printed label of BS-0601 on a workbench.
import { test } from '@playwright/test';
const OUT = '/tmp/claude-0/-home-claude/57bf162b-39a4-54d4-88b0-f2c4d9661201/scratchpad/ex';
test('label', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3200', viewport: { width: 1280, height: 900 }, deviceScaleFactor: 3 });
  const page = await ctx.newPage();
  await page.goto('/login');
  await page.getByRole('button', { name: 'Sign in as the demo storekeeper' }).click();
  await page.getByRole('heading', { name: 'Tool board' }).waitFor();
  await page.goto('/labels');
  const img = page.getByAltText('QR code for BS-0601');
  await img.waitFor();
  await img.locator('xpath=..').screenshot({ path: `${OUT}/label-BS-0601.png` });
});
