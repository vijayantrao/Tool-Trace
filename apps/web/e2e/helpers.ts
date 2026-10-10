import { readFileSync } from 'node:fs';
import AxeBuilder from '@axe-core/playwright';
import { expect, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';
import path from 'node:path';

const STATE_FILE = path.join(import.meta.dirname, '.state.json');

export const state = () => JSON.parse(readFileSync(STATE_FILE, 'utf8')) as { adminInviteUrl: string };

export const SHOTS = process.env.SCREENSHOTS ? '../../docs/screenshots' : null;

export async function shot(page: Page, name: string, opts: { fullPage?: boolean; mask?: Locator[] } = {}) {
  if (!SHOTS) return;
  await page.waitForLoadState('networkidle');
  const size = page.viewportSize()!;
  if (opts.fullPage) {
    // Grow the viewport instead of using fullPage, so the sticky side rail spans the whole image.
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    await page.setViewportSize({ width: size.width, height });
  }
  await page.screenshot({ path: `${SHOTS}/${name}.png`, mask: opts.mask, maskColor: '#c6cfc9' });
  if (opts.fullPage) await page.setViewportSize(size);
}

/**
 * Each person gets their own browser context with a virtual platform
 * authenticator (like a phone's fingerprint sensor) that auto-approves.
 */
export async function personWithPasskey(
  browser: Browser,
  opts: { mobile?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext(
    opts.mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1360, height: 900 } },
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { context, page };
}

export async function acceptInvite(page: Page, inviteUrl: string, name: string) {
  await page.goto(inviteUrl);
  await expect(page.getByRole('heading', { name: 'Set up your passkey' })).toBeVisible();
  // The token must be wiped from the address bar once read.
  await expect(page).toHaveURL(/\/accept-invite$/);
  await page.getByLabel('Your name').fill(name);
  await page.getByRole('button', { name: 'Create passkey and sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Tool board' })).toBeVisible();
}

export async function expectAccessible(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  const summary = results.violations.map((v) => `${v.id}: ${v.help} (${v.nodes.length}) -> ${v.nodes[0]?.target}`);
  expect(summary, summary.join('\n')).toEqual([]);
}
