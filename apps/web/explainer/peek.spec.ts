import { test } from '@playwright/test';
const OUT = '/tmp/claude-0/-home-claude/57bf162b-39a4-54d4-88b0-f2c4d9661201/scratchpad/ex/peek';
test('peek2', async ({ browser }) => {
  const ctx = await browser.newContext({ baseURL: 'http://localhost:3200', viewport: { width: 1280, height: 720 } });
  const page = await ctx.newPage();
  await page.goto('/login'); await page.getByRole('button', { name: 'Sign in as the demo admin' }).click();
  await page.getByRole('heading', { name: 'Tool board' }).waitFor();
  for (const p of ['people', 'stations', 'audit']) { await page.goto(`/${p}`); await page.waitForTimeout(1500); await page.screenshot({ path: `${OUT}/05-${p}.png`, fullPage: true }); }
  const m = await browser.newContext({ baseURL: 'http://localhost:3200', viewport: { width: 400, height: 720 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  const mp = await m.newPage();
  await mp.goto('/login'); await mp.waitForTimeout(800); await mp.screenshot({ path: `${OUT}/06-m-login.png` });
  await mp.getByRole('button', { name: 'Sign in as the demo technician' }).click();
  await mp.getByRole('heading', { name: 'Tool board' }).waitFor(); await mp.waitForTimeout(800);
  await mp.screenshot({ path: `${OUT}/06-m-board.png` });
  await mp.goto('/scan'); await mp.waitForTimeout(1200); await mp.screenshot({ path: `${OUT}/06-m-scan.png` });
  await mp.goto('/t/CR-0501'); await mp.waitForTimeout(1200); await mp.screenshot({ path: `${OUT}/06-m-tool.png`, fullPage: true });
});
