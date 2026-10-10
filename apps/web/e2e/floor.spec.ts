/**
 * The whole shop-floor story in a real browser with real passkeys:
 * admin bootstraps, invites a storekeeper and a technician, the technician
 * scans and checks out a tool on a phone, the storekeeper receives it back
 * damaged, quarantines it, recalibrates it, and access is revoked.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { acceptInvite, expectAccessible, personWithPasskey, shot, SHOTS, state } from './helpers';

test.describe.configure({ mode: 'serial' });

let admin: { context: BrowserContext; page: Page };
let storekeeper: { context: BrowserContext; page: Page };
let tech: { context: BrowserContext; page: Page };

async function invite(page: Page, email: string, role: string): Promise<string> {
  await page.goto('/people');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Role').selectOption(role);
  await page.getByRole('button', { name: 'Create invite' }).click();
  const link = page.getByLabel('Invite link');
  await expect(link).toHaveValue(/\/accept-invite#token=/);
  return link.inputValue();
}

test('admin accepts the bootstrap invite and sees the demo board', async ({ browser }) => {
  admin = await personWithPasskey(browser);
  await acceptInvite(admin.page, state().adminInviteUrl, 'Priya Nair');
  await expect(admin.page.getByText('TW-0101')).toBeVisible();
  await expect(admin.page.getByText(/0 of 9 tools are out/)).toBeVisible();
  await expectAccessible(admin.page);
});

test('the same invite link cannot be used twice', async ({ browser }) => {
  const intruder = await personWithPasskey(browser);
  await intruder.page.goto(state().adminInviteUrl);
  await intruder.page.getByLabel('Your name').fill('Someone Else');
  await intruder.page.getByRole('button', { name: 'Create passkey and sign in' }).click();
  await expect(intruder.page.getByText(/invite link is invalid, used, or expired/)).toBeVisible();
  await intruder.context.close();
});

test('admin invites a storekeeper and a technician', async ({ browser }) => {
  const skUrl = await invite(admin.page, 'ravi@tooltrace.example', 'storekeeper');
  await expect(admin.page.getByAltText(/QR code of the invite link/)).toBeVisible();
  await expectAccessible(admin.page);
  const techUrl = await invite(admin.page, 'asha@tooltrace.example', 'technician');
  await shot(admin.page, 'people', { mask: [admin.page.getByLabel('Invite link'), admin.page.getByAltText(/QR code of the invite link/)] });

  storekeeper = await personWithPasskey(browser);
  await acceptInvite(storekeeper.page, skUrl, 'Ravi Kumar');

  tech = await personWithPasskey(browser, { mobile: true });
  await acceptInvite(tech.page, techUrl, 'Asha Verma');
});

test('technician finds a tool by tag on a phone and checks it out', async () => {
  const { page } = tech;
  await page.getByRole('link', { name: 'Scan a tool' }).click();
  await expect(page.getByRole('heading', { name: 'Scan a tool' })).toBeVisible();
  await page.getByLabel('Or type the asset tag').fill('tw-0101');
  await page.getByRole('button', { name: 'Find' }).click();

  await expect(page.getByRole('heading', { name: /Torque Wrench 20-100 Nm/ })).toBeVisible();
  await expect(page.getByLabel('Issue to')).toHaveCount(0); // technicians can only take tools themselves
  await page.getByRole('button', { name: 'Tomorrow' }).click();
  await shot(page, 'mobile-checkout');
  await page.getByRole('button', { name: 'Check out TW-0101' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Checked out TW-0101 to you' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'You have this tool' })).toBeVisible();

  await page.getByRole('link', { name: 'Board' }).first().click();
  await expect(page.getByRole('heading', { name: 'You have 1 tool out' })).toBeVisible();
  await expect(page.getByRole('link', { name: /TW-0101 .* checked out to Asha Verma/ })).toBeVisible();
  if (SHOTS) await page.waitForTimeout(4600); // let the confirmation toast fade before the screenshot
  await shot(page, 'mobile-board');
  await expectAccessible(page);
});

test('a tool with expired calibration is locked', async () => {
  const { page } = tech;
  await page.goto('/scan');
  await page.getByLabel('Or type the asset tag').fill('TW-0103');
  await page.getByRole('button', { name: 'Find' }).click();
  await expect(page.getByRole('heading', { name: 'Locked: calibration expired' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Check out/ })).toHaveCount(0);
});

test('unknown tags and foreign QR codes are handled clearly', async () => {
  const { page } = tech;
  await page.goto('/t/NOPE-123');
  await expect(page.getByRole('heading', { name: 'No tool tagged NOPE-123' })).toBeVisible();
});

test('storekeeper sees who has the tool and receives it back damaged', async () => {
  const { page } = storekeeper;
  await page.goto('/');
  await expect(page.getByText(/1 of 9 tools are out/)).toBeVisible();
  await shot(page, 'board', { fullPage: true });
  await page.getByRole('link', { name: /TW-0101 .* checked out to Asha Verma/ }).click();
  await expect(page.getByRole('heading', { name: 'With Asha Verma' })).toBeVisible();
  await page.getByText('Damaged', { exact: true }).click();
  await page.getByLabel('Notes (optional)').fill('Ratchet slipping under load');
  await page.getByRole('button', { name: 'Receive TW-0101' }).click();
  await expect(page.getByRole('heading', { name: 'Quarantined', exact: true })).toBeVisible();
});

test('recording a calibration releases the quarantined tool', async () => {
  const { page } = storekeeper;
  await page.getByRole('button', { name: 'Record calibration' }).click();
  await page.getByLabel('Calibrated by').fill('External Calibration Lab');
  await page.getByLabel('Certificate number (optional)').fill('CAL-2026-0142');
  await page.getByRole('button', { name: 'Save calibration' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Calibration recorded' })).toBeVisible();
  await expect(page.getByText('In the crib').first()).toBeVisible();
  await expect(page.getByText(/Cert CAL-2026-0142/)).toBeVisible();
  await shot(page, 'tool-detail');
  await expectAccessible(page);
});

test('storekeeper issues a tool to someone else', async () => {
  const { page } = storekeeper;
  await page.goto('/t/MM-0201');
  await page.getByLabel('Issue to').selectOption({ label: 'Asha Verma' });
  await page.getByRole('button', { name: 'Check out MM-0201' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Checked out MM-0201 to Asha Verma' })).toBeVisible();
  await page.goto('/checkouts');
  await expect(page.getByRole('link', { name: /MM-0201/ })).toBeVisible();
  await expectAccessible(page);
});

test('tools page searches and filters', async () => {
  const { page } = storekeeper;
  await page.goto('/tools');
  await page.getByLabel('Calibration').selectOption('expired');
  await expect(page.getByRole('link', { name: /TW-0103/ })).toBeVisible();
  await expect(page.getByRole('link', { name: /TW-0101/ })).toHaveCount(0);
  await page.getByLabel('Calibration').selectOption('');
  await page.getByPlaceholder('Search by asset tag or name').fill('borescope');
  await expect(page.getByRole('link', { name: /BS-0601/ })).toBeVisible();
  await shot(page, 'tools');
  await expectAccessible(page);
});

test('storekeeper adds a tool and prints its QR label', async () => {
  const { page } = storekeeper;
  await page.goto('/tools?add=1');
  const dialog = page.getByRole('dialog', { name: 'Add a tool' });
  await dialog.getByLabel('Asset tag').fill('tw-0199');
  await dialog.getByLabel('Category').fill('Torque');
  await dialog.getByLabel('Name').fill('Torque Wrench 10-50 Nm');
  await dialog.getByLabel('Last calibrated').fill(new Date().toISOString().slice(0, 10));
  await dialog.getByRole('button', { name: 'Add to the board' }).click();
  await expect(page.getByRole('heading', { name: 'Torque Wrench 10-50 Nm' })).toBeVisible();
  await page.getByRole('link', { name: 'Print QR label' }).click();
  await expect(page.getByAltText('QR code for TW-0199')).toBeVisible();
  await expect(page.getByAltText(/QR code for/)).toHaveCount(1);
});

test('technicians cannot reach admin-only screens', async () => {
  const { page } = tech;
  await page.goto('/people');
  await expect(page.getByText('Only admins and auditors can see this page.')).toBeVisible();
});

test('deactivating someone signs them out everywhere', async () => {
  await admin.page.goto('/people');
  await admin.page
    .getByRole('listitem')
    .filter({ hasText: 'Asha Verma' })
    .getByRole('button', { name: 'Deactivate' })
    .click();
  await expect(admin.page.getByText('Asha Verma deactivated and signed out')).toBeVisible();

  await tech.page.goto('/');
  await expect(tech.page).toHaveURL(/\/login/);
});

test('signing out and back in with the passkey', async () => {
  const { page } = admin;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await shot(page, 'login');
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Sign in with passkey' }).click();
  await expect(page.getByRole('heading', { name: 'Tool board' })).toBeVisible();
});

test('pages are served with strict security headers', async ({ request }) => {
  const res = await request.get('/login');
  const h = res.headers();
  expect(h['content-security-policy']).toContain("frame-ancestors 'none'");
  expect(h['x-frame-options']).toBe('DENY');
  expect(h['x-content-type-options']).toBe('nosniff');
  expect(h['permissions-policy']).toContain('camera=(self)');
  expect(h['x-powered-by']).toBeUndefined();
});

test('the app is installable', async ({ request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
  expect((await request.get('/sw.js')).ok()).toBe(true);
  expect((await request.get('/offline')).ok()).toBe(true);
});
