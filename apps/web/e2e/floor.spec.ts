/**
 * The whole shop-floor story in a real browser with real passkeys:
 * admin bootstraps, invites a storekeeper and a technician, the technician
 * scans and checks out a tool on a phone, the storekeeper receives it back
 * damaged, quarantines it, recalibrates it, and access is revoked.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import postgres from 'postgres';
import writeXlsxFile from 'write-excel-file/node';
import { DB_URL, MQTT_PORT } from '../playwright.config';
import {
  acceptInvite,
  connectStation,
  expectAccessible,
  personWithPasskey,
  runNightlyModel,
  shot,
  SHOTS,
  state,
} from './helpers';

test.describe.configure({ mode: 'serial' });

let admin: { context: BrowserContext; page: Page };
let storekeeper: { context: BrowserContext; page: Page };
let tech: { context: BrowserContext; page: Page };

async function invite(page: Page, email: string, role: string): Promise<string> {
  await page.goto('/people');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Role', { exact: true }).selectOption(role);
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

let station: Awaited<ReturnType<typeof connectStation>>;

test('admin sets up a station and gives the technician a badge', async () => {
  const { page } = admin;
  await page.goto('/stations');
  await page.getByLabel('Station name').fill('Crib Station 1');
  await page.getByRole('button', { name: 'Add station' }).click();
  const config = await page.getByLabel('Firmware settings').textContent();
  const id = config!.match(/STATION_ID "([^"]+)"/)![1]!;
  const key = config!.match(/STATION_KEY_HEX "([0-9a-f]{64})"/)![1]!;
  await expect(page.getByLabel('Simulator command')).toContainText(`--id ${id} --key ${key}`);
  await page.getByRole('button', { name: "I've saved it" }).click();
  station = await connectStation(id, key, MQTT_PORT);

  await page.goto('/people');
  const row = page.getByRole('listitem').filter({ hasText: 'Asha Verma' });
  await row.getByRole('button', { name: 'Assign badge' }).click();
  await row.getByLabel('Badge ID').fill('c0 ff ee 99');
  await row.getByRole('button', { name: 'Save' }).click();
  await expect(row.getByText('C0:FF:EE:99')).toBeVisible();
});

test('a badge and a tool tapped at the station appear live on the storekeeper board', async () => {
  const { page } = storekeeper;
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Live updates: live' }).first()).toBeVisible();
  const slot = page.getByRole('link', { name: /^TW-0101 / });
  await expect(slot).toHaveAccessibleName(/in the crib/);

  expect(await station.tap('11223344')).toMatchObject({ ok: false, l1: 'Tap your badge' });
  expect(await station.tap('C0FFEE99')).toMatchObject({ ok: true, l1: 'Hi Asha' });
  expect(await station.tap('11223344')).toMatchObject({ ok: true, l1: 'TW-0101 is yours' });

  // No reload: the board and a notice update by themselves.
  await expect(page.getByText('Asha Verma checked out TW-0101 at Crib Station 1')).toBeVisible();
  await expect(slot).toHaveAccessibleName(/checked out to Asha Verma/);

  expect(await station.tap('AABBCCDD')).toMatchObject({ ok: false, l1: 'LOCKED' });
  expect(await station.tap('11223344')).toMatchObject({ ok: true, l1: 'TW-0101 returned' });
  await expect(slot).toHaveAccessibleName(/in the crib/);
});

test('a check-out made in one browser appears live in another', async () => {
  await storekeeper.page.goto('/');
  const slot = storekeeper.page.getByRole('link', { name: /^VC-0301 / });
  await expect(slot).toHaveAccessibleName(/in the crib/);
  await tech.page.goto('/t/VC-0301');
  await tech.page.getByRole('button', { name: 'Check out VC-0301' }).click();
  await expect(storekeeper.page.getByText('Asha Verma checked out VC-0301')).toBeVisible();
  await expect(slot).toHaveAccessibleName(/checked out to Asha Verma/);
});

test('forged station messages are rejected and shown in the activity log', async () => {
  expect(await station.forge('11223344')).toBeNull(); // no reply to a forgery
  const { page } = admin;
  await page.goto('/stations');
  await expect(page.getByText('Forged or altered message rejected')).toBeVisible();
  await expect(page.getByText('Asha Verma took TW-0101')).toBeVisible();
  await expect(page.getByText(/TW-0103 refused: calibration expired/)).toBeVisible();
  await shot(page, 'stations');
  await expectAccessible(page);
  await station.close();
});

test('the audit trail shows who did what and proves nothing was altered', async () => {
  const { page } = admin;
  await page.goto('/audit');
  await expect(page.getByRole('heading', { name: 'Audit trail' })).toBeVisible();
  await expect(page.getByText(/forged or altered message rejected/).first()).toBeVisible();
  await expect(page.getByText('Asha Verma at Crib Station 1').first()).toBeVisible();
  await expect(page.getByText('Invited asha@tooltrace.example as Technician')).toBeVisible();
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/Chain intact: \d+ entries checked/)).toBeVisible();
  const anchor = await page.getByLabel('Anchor', { exact: true }).innerText();
  expect(anchor).toMatch(/^\d+:[0-9a-f]{64}$/);

  // A garbled anchor is refused politely; a correct one is confirmed.
  await page.getByLabel('Saved anchor (optional)').fill('not-an-anchor');
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/An anchor looks like/)).toBeVisible();
  await page.getByLabel('Saved anchor (optional)').fill(anchor);
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText('Your saved anchor matches.')).toBeVisible();

  await page.getByLabel('Show').selectOption('auth.');
  await expect(page.getByText('Priya Nair signed in').first()).toBeVisible();
  await expect(page.getByText(/checked out$/)).toHaveCount(0);
  await page.getByLabel('Show').selectOption('');
  await expectAccessible(page);
  await page.getByLabel('Saved anchor (optional)').fill('');
  await page.getByRole('button', { name: 'Verify integrity' }).click();
  await expect(page.getByText(/Chain intact/)).toBeVisible();
  await shot(page, 'audit');
});

test('a technician with no signal checks tools out, and they sync when the signal returns', async () => {
  const { page, context } = tech;
  await page.goto('/scan');
  // The signal drops after the page has loaded (not while it is still checking the sign-in).
  await expect(page.getByLabel('Or type the asset tag')).toBeVisible();
  await context.setOffline(true);
  await expect(page.getByText("You're offline.")).toBeVisible();

  for (const tag of ['IW-0701', 'CR-0501']) {
    await page.getByLabel('Or type the asset tag').fill(tag);
    await page.getByRole('button', { name: 'Find' }).click();
    await expect(page.getByRole('heading', { name: 'No connection' })).toBeVisible();
    await page.getByRole('button', { name: `Check out ${tag} when back online` }).click();
    await expect(page.getByRole('status').filter({ hasText: `Check out ${tag}` }).first()).toBeVisible();
  }
  await expect(page.getByText("2 actions will be sent as soon as you're back online.")).toBeVisible();
  await shot(page, 'mobile-offline', { offline: true });

  // Meanwhile, at the crib (online), the storekeeper takes CR-0501.
  await storekeeper.page.goto('/t/CR-0501');
  await storekeeper.page.getByRole('button', { name: 'Check out CR-0501' }).click();
  await expect(storekeeper.page.getByRole('status').filter({ hasText: 'Checked out CR-0501' })).toBeVisible();

  await context.setOffline(false);
  await expect(page.getByText('Synced: IW-0701 checked out')).toBeVisible({ timeout: 20_000 });
  // The phone never decides: the server refused CR-0501, and the technician is told why.
  const failed = page.getByRole('region', { name: /couldn.t be completed/ });
  await expect(failed).toContainText(/Check out CR-0501:.*not available/);
  await page.getByRole('button', { name: 'Dismiss: Check out CR-0501' }).click();
  await expect(failed).toHaveCount(0);

  await storekeeper.page.goto('/');
  await expect(storekeeper.page.getByRole('link', { name: /^IW-0701 .* checked out to Asha Verma/ })).toBeVisible();
});

test('the nightly model scores what is out and flags unusual check-outs for review', async () => {
  const out = runNightlyModel(DB_URL);
  expect(out).toMatch(/trained on \d+ check-outs/);

  const { page } = storekeeper;
  await page.goto('/');
  await page.getByRole('link', { name: /See insights/ }).click();
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  await expect(page.getByText(/learned from [\d,]+ past check-outs/)).toBeVisible();

  const tools = page.getByRole('region', { name: 'Tools out now' });
  const iw = tools.getByRole('listitem').filter({ hasText: 'IW-0701' });
  await expect(iw).toContainText('Asha Verma');
  await expect(iw).toContainText('checked out offline');
  await expect(iw).toContainText(/On track|Likely late|Loss risk|Overdue/);

  const flag = page.getByRole('article', { name: /Unusual check-out of/ }).first();
  await expect(flag).toContainText(/Checked out at|Planned for|First time with|Rarely uses/);
  await flag.getByLabel('Note (optional)').fill('Night maintenance job, approved by the shift lead');
  await flag.getByRole('button', { name: 'Looks fine' }).click();
  await expect(page.getByText(/Marked as fine by Ravi Kumar.*Night maintenance job/).first()).toBeVisible();
  await expectAccessible(page);
  await shot(page, 'insights', { fullPage: true });
});

test('a technician confirms the tool a storekeeper issued to them', async () => {
  const { page } = tech;
  await page.goto('/');
  const pending = page.getByRole('region', { name: 'Please confirm what you were issued' });
  const item = pending.getByRole('listitem').filter({ hasText: 'MM-0201' });
  await expect(item).toContainText('Issued by Ravi Kumar');
  await expectAccessible(page);
  await item.getByRole('button', { name: 'I have it' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Thanks, confirmed' })).toBeVisible();
  await expect(item).toHaveCount(0);
});

test('a tool goes to the calibration lab, the lab enters the result through its link, and the tool comes back', async ({ browser }) => {
  const sql = postgres(DB_URL, { max: 1, onnotice: () => {} });
  const [tool] = await sql<{ id: string }[]>`SELECT id FROM tools WHERE asset_tag = 'TW-0102'`;
  await sql.end();

  const { page } = storekeeper;
  await page.goto(`/tools/${tool!.id}`);
  await page.getByRole('button', { name: 'Send for calibration' }).click();
  await page.getByLabel('Calibration lab').fill('Precision Calibration Labs');
  await page.getByRole('button', { name: 'Send TW-0102 for calibration' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'TW-0102 is off the board' })).toBeVisible();
  const link = await page.getByLabel('Lab link').inputValue();
  expect(link).toMatch(/\/lab#token=[\w-]{40,}$/);
  await expectAccessible(page);

  // The lab has no account: a fresh browser with nothing but the link.
  const labContext = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const lab = await labContext.newPage();
  await lab.goto(link);
  await expect(lab.getByRole('heading', { name: 'Calibration result' })).toBeVisible();
  await expect(lab).toHaveURL(/\/lab$/); // the token is wiped from the address bar
  await expect(lab.getByText(/TW-0102.*Torque Wrench 60-340 Nm, sent to Precision Calibration Labs/)).toBeVisible();
  await expectAccessible(lab);
  await shot(lab, 'lab-link');
  await lab.getByLabel('Calibrated by').fill('S. Iyer');
  await lab.getByLabel('Certificate number').fill('PCL-2026-0917');
  await lab.getByLabel('Certificate file').setInputFiles({
    name: 'PCL-2026-0917.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n'),
  });
  await lab.getByRole('button', { name: 'Send the result' }).click();
  await expect(lab.getByRole('heading', { name: 'Thank you' })).toBeVisible();
  // Single use: opening the link again (a fresh page load, as from the email) is refused.
  const again = await labContext.newPage();
  await again.goto(link);
  await expect(again.getByText(/already been used/)).toBeVisible();
  await labContext.close();

  await page.reload();
  await page.getByRole('button', { name: 'Received: back in service' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'TW-0102 is back on the board' })).toBeVisible();
  await expect(page.getByText(/Cert PCL-2026-0917/)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Certificate' }).first()).toBeVisible();

  await page.goto('/notifications');
  await expect(page.getByText('Precision Calibration Labs calibrated TW-0102')).toBeVisible();
  await expectAccessible(page);
});

test('PPE is stocked, issued to a technician, and confirmed by them', async () => {
  const { page } = storekeeper;
  await page.goto('/stock?add=1');
  await page.getByLabel('Code', { exact: true }).fill('PPE-GLV-01');
  await page.getByLabel('Name', { exact: true }).fill('Cut-resistant gloves');
  await page.getByLabel('Category', { exact: true }).fill('Hand protection');
  await page.getByLabel('Counted in').fill('pairs');
  await page.getByLabel('On the shelf now').fill('20');
  await page.getByLabel('Reorder at').fill('5');
  await page.getByLabel('Unit price (optional)').fill('180');
  await page.getByRole('button', { name: 'Add item' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Added PPE-GLV-01' })).toBeVisible();

  const dialog = page.getByRole('dialog', { name: 'Stock item' });
  await dialog.getByLabel('Issue to').selectOption({ label: 'Asha Verma' });
  await dialog.getByLabel('Quantity (pairs)').fill('3');
  await dialog.getByRole('button', { name: 'Issue', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'PPE-GLV-01: 17 pairs left' })).toBeVisible();
  await expect(dialog.getByText('Issued 3 pairs to Asha Verma')).toBeVisible();
  await expectAccessible(page);

  // More than is on the shelf is refused.
  await dialog.getByLabel('Issue to').selectOption({ label: 'Asha Verma' });
  await dialog.getByLabel('Quantity (pairs)').fill('50');
  await dialog.getByRole('button', { name: 'Issue', exact: true }).click();
  await expect(dialog.getByText(/only 17|not enough|in stock/i).first()).toBeVisible();

  await tech.page.goto('/stock');
  const mine = tech.page.getByRole('region', { name: 'Issued to you' });
  await expect(mine).toContainText('3 pairs Cut-resistant gloves');
  await mine.getByRole('button', { name: 'I have it' }).click();
  await expect(tech.page.getByRole('status').filter({ hasText: 'Thanks, confirmed' })).toBeVisible();
  await expectAccessible(tech.page);
});

test('a replacement request is reviewed by the storekeeper and approved by the admin', async () => {
  await tech.page.goto('/requests?new=1');
  await tech.page.getByRole('button', { name: 'Replacement' }).click();
  await tech.page.getByLabel('Tool to replace (asset tag)').fill('CR-0501');
  await tech.page.getByLabel('Reason').selectOption('damaged');
  await tech.page.getByLabel('What is needed').fill('Hydraulic Crimping Tool');
  await tech.page.getByLabel('Details (optional)').fill('Die set cracked');
  await tech.page.getByRole('button', { name: 'Send request' }).click();
  await expect(tech.page.getByRole('status').filter({ hasText: /Request REQ-\d{4} sent for review/ })).toBeVisible();

  const sk = storekeeper.page;
  await sk.goto('/requests');
  await sk.getByRole('button', { name: /Hydraulic Crimping Tool/ }).click();
  await expect(sk.getByText('Die set cracked')).toBeVisible();
  await expectAccessible(sk);
  await sk.getByRole('button', { name: 'Pass on for approval' }).click();
  await expect(sk.getByRole('status').filter({ hasText: 'Passed on for approval' })).toBeVisible();

  const ad = admin.page;
  await ad.goto('/requests');
  await ad.getByRole('button', { name: /Hydraulic Crimping Tool/ }).click();
  await expect(ad.getByText('Ravi Kumar reviewed it and passed it on for approval')).toBeVisible();
  await ad.getByLabel('Note (optional)').fill('Order from the usual supplier');
  await ad.getByRole('button', { name: 'Approve' }).click();
  await expect(ad.getByRole('status').filter({ hasText: 'Approved' })).toBeVisible();
  await expect(ad.getByText('“Order from the usual supplier”')).toBeVisible();
});

test('a kit goes out with one scan and comes back checked piece by piece', async () => {
  const { page } = storekeeper;
  await page.goto('/kits?add=1');
  await page.getByLabel('Kit tag').fill('KIT-0001');
  await page.getByLabel('Name', { exact: true }).fill('Inspection kit');
  await page.getByLabel('Tools in it (asset tags)').fill('DFT-0401, BS-0601');
  await page.getByRole('button', { name: 'Make the kit' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kit KIT-0001 made with 2 tools' })).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel('Issue to').selectOption({ label: 'Asha Verma' });
  await page.getByRole('button', { name: 'Check out KIT-0001' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kit KIT-0001 checked out (2 tools)' })).toBeVisible();

  await page.getByRole('button', { name: 'All back, good' }).click();
  await page.getByRole('button', { name: 'Receive KIT-0001' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Kit KIT-0001 is back' })).toBeVisible();
  await expectAccessible(page);
});

test('reports show what the crib is worth, download as Excel, and print the calibration register', async () => {
  const { page } = admin;
  await page.goto('/reports');
  await expect(page.getByRole('heading', { name: 'Reports' })).toBeVisible();
  await expect(page.getByText('Tools in service', { exact: true })).toBeVisible();
  await expectAccessible(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Tool register' }).click();
  expect((await download).suggestedFilename()).toMatch(/^tooltrace-tools-\d{4}-\d{2}-\d{2}\.xlsx$/);
  await shot(page, 'reports', { fullPage: true });

  await page.getByRole('link', { name: 'Calibration register' }).click();
  await expect(page.getByRole('heading', { name: 'Calibration register' })).toBeVisible();
  const row = page.getByRole('row').filter({ hasText: 'TW-0102' });
  await expect(row).toContainText('PCL-2026-0917');
  await expect(row.getByRole('link', { name: 'Certificate' })).toBeVisible();
  await expectAccessible(page);

  await page.goto('/audit');
  await page.getByLabel('Show').selectOption({ label: 'Calibrations and lab' });
  await expect(page.getByText(/TW-0102.*sent to Precision Calibration Labs/).first()).toBeVisible();
  await expect(page.getByText(/Certificate PCL-2026-0917\.pdf added/).first()).toBeVisible();
});

test('technicians cannot reach admin-only screens', async () => {
  const { page } = tech;
  await page.goto('/people');
  await expect(page.getByText('Only admins and auditors can see this page.')).toBeVisible();
  await page.goto('/audit');
  await expect(page.getByText('Only admins and auditors can see the audit trail.')).toBeVisible();
  await page.goto('/insights');
  await expect(page.getByText('Only crib staff and auditors can see insights.')).toBeVisible();
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
  expect(h['cross-origin-opener-policy']).toBe('same-origin');
  expect(h['cross-origin-resource-policy']).toBe('same-origin');
  expect(h['cross-origin-embedder-policy']).toBe('require-corp');
  expect(h['x-powered-by']).toBeUndefined();
});

test('the app is installable', async ({ request }) => {
  const manifest = await (await request.get('/manifest.webmanifest')).json();
  expect(manifest.display).toBe('standalone');
  expect(manifest.icons.some((i: { sizes: string }) => i.sizes === '512x512')).toBe(true);
  expect((await request.get('/sw.js')).ok()).toBe(true);
  expect((await request.get('/offline')).ok()).toBe(true);
});

test('admin imports tools from an Excel workbook, checking it first', async ({}, testInfo) => {
  test.setTimeout(120_000);
  const { page } = admin;
  const file = testInfo.outputPath('plant-tools.xlsx');
  const day = (s: string) => new Date(`${s}T00:00:00Z`);
  await writeXlsxFile(
    [
      ['Tool No', 'Description', 'Type', 'Store', 'Cal Interval', 'Last Cal Date'],
      ['TW-0301', 'Torque Wrench 2-10 Nm', 'Torque', 'Assembly Bay 3', 180, day(new Date(Date.now() - 20 * 864e5).toISOString().slice(0, 10))],
      ['GG-0302', 'Feeler Gauge Set', 'Measuring', 'Assembly Bay 3', null, null],
      ['bad tag', 'Broken row', 'Misc', null, null, null],
    ],
    { dateFormat: 'dd/mm/yyyy' },
  ).toFile(file);

  await page.goto('/data');
  await expect(page.getByRole('heading', { name: 'Data sources' })).toBeVisible();
  await page.getByRole('button', { name: /Excel workbook.*Connect existing/ }).click();
  await page.getByLabel('Spreadsheet file').setInputFiles(file);
  await expect(page.getByText(/plant-tools.xlsx · 3 rows/)).toBeVisible();
  await expectAccessible(page);
  await page.getByRole('button', { name: 'Check 3 rows' }).click();
  const check = page.getByRole('region', { name: 'Check results' });
  await expect(check).toContainText('Checked 3 rows. Nothing has changed yet.');
  await expect(check).toContainText(/Asset tag "bad tag" must be/);
  await shot(page, 'data-sources-check', { fullPage: true });
  await page.getByRole('button', { name: 'Import 2 tools' }).click();
  await expect(page.getByRole('region', { name: 'Import results' })).toBeVisible();

  await page.goto('/t/TW-0301');
  await expect(page.getByRole('heading', { name: 'Torque Wrench 2-10 Nm' })).toBeVisible();
  await expect(page.getByText(/kept at Assembly Bay 3/)).toBeVisible();
});

test('admin imports from a PostgreSQL table, then keeps a copy of the tools in one', async () => {
  test.setTimeout(150_000); // two connections, a check, an import and a copy: slow on shared CI runners
  const { page } = admin;
  const server = new URL(DB_URL);
  server.pathname = '/postgres';
  const root = postgres(server.toString(), { max: 1, onnotice: () => {} });
  await root.unsafe('DROP DATABASE IF EXISTS tooltrace_e2e_source WITH (FORCE)');
  await root.unsafe('CREATE DATABASE tooltrace_e2e_source');
  const srcUrl = new URL(DB_URL);
  srcUrl.pathname = '/tooltrace_e2e_source';
  const src = postgres(srcUrl.toString(), { max: 1, onnotice: () => {} });
  await src.unsafe(`CREATE TABLE "Tool Master" ("Asset No" text, "Tool Name" text, "Category" text)`);
  await src.unsafe(`INSERT INTO "Tool Master" VALUES ('HM-0401', 'Rubber Mallet', 'Hand Tools'), ('HM-0402', 'Dead Blow Hammer', 'Hand Tools')`);

  const connect = async () => {
    await page.getByLabel('Server', { exact: true }).fill(server.hostname);
    await page.getByLabel('Port', { exact: true }).fill(server.port || '5432');
    await page.getByLabel('Database', { exact: true }).fill('tooltrace_e2e_source');
    await page.getByLabel('User name', { exact: true }).fill(decodeURIComponent(server.username));
    await page.getByLabel('Password', { exact: true }).fill(decodeURIComponent(server.password));
    await page.getByLabel('Encryption', { exact: true }).selectOption('off');
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(page.getByText(/Connected to tooltrace_e2e_source/)).toBeVisible();
  };

  // Collected so that a failure on CI says what the browser saw.
  const browserErrors: string[] = [];
  page.on('pageerror', (e) => browserErrors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && browserErrors.push(`console: ${m.text()}`));
  try {
    await page.goto('/data');
    await page.getByRole('button', { name: /PostgreSQL.*Connect existing/ }).click();
    await connect();
    await page.getByLabel('Table', { exact: true }).selectOption('Tool Master');
    await expect(page.getByRole('table')).toContainText('Dead Blow Hammer');
    await page.getByRole('button', { name: 'Check the table' }).click();
    await expect(page.getByRole('region', { name: 'Check results' })).toContainText('Checked 2 rows');
    await page.getByRole('button', { name: 'Save and import' }).click();
    await expect(page.getByRole('region', { name: 'Import from PostgreSQL' }).getByText(/^2 added, 0 updated, 0 unchanged$/)).toBeVisible();

    await page.getByRole('tab', { name: /Create a new data source/ }).click();
    await expect(page.getByRole('tab', { name: /Create a new data source/ }))
      .toHaveAttribute('aria-selected', 'true')
      .catch(async () => {
        throw new Error(`Tab missing at ${page.url()}. Errors: ${browserErrors.join(' | ').slice(0, 1500)}\nScreen:\n${(await page.locator('body').ariaSnapshot()).slice(0, 3000)}`);
      });
    const createTile = page.getByRole('tabpanel', { name: 'Create a new data source' }).getByRole('button', { name: /PostgreSQL/ });
    // If this ever fails on CI, say what was on the screen instead (CI artifacts aren't always at hand).
    await createTile.waitFor({ timeout: 15_000 }).catch(async () => {
      throw new Error(`No PostgreSQL tile. The page showed:\n${(await page.locator('main').ariaSnapshot()).slice(0, 4000)}`);
    });
    await createTile.click();
    await connect();
    await page.getByRole('button', { name: 'Create table and copy tools' }).click();
    await expect(page.getByRole('region', { name: 'Create a ToolTrace table in PostgreSQL' }).getByText(/^Copied \d+ tools to tooltrace_tools$/)).toBeVisible();
    const [copy] = await src<{ n: number }[]>`SELECT count(*)::int AS n FROM tooltrace_tools WHERE asset_tag IN ('HM-0401', 'TW-0301', 'TW-0101')`;
    expect(copy?.n).toBe(3);

    const saved = page.getByRole('region', { name: 'Database connections' }).getByRole('listitem');
    await expect(saved).toHaveCount(2);
    await expectAccessible(page);
    await shot(page, 'data-sources', { fullPage: true });
  } finally {
    await src.end();
    await root.unsafe('DROP DATABASE IF EXISTS tooltrace_e2e_source WITH (FORCE)');
    await root.end();
  }
});
