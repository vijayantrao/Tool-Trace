/**
 * The product tour, recorded as a video. Every step is a real interaction with
 * the running stack (demo mode, behind the proxy), so the video can't drift
 * from what the app actually does.
 */
import { expect, test } from '@playwright/test';
import { connectStation } from '../e2e/helpers';
import { TOUR_MQTT_PORT } from '../playwright.tour.config';
import path from 'node:path';
import { card, glideClick, glideTo, hideCaption, installCursor, say, startRecording } from './overlay';

export const FRAMES_DIR = path.resolve(import.meta.dirname, '../tour-results/frames');

const hold = (page: import('@playwright/test').Page, s: number) => page.waitForTimeout(s * 1000);

test('ToolTrace product tour', async ({ page, context }) => {
  await installCursor(context);
  await page.goto('/login'); // also wakes the API before recording starts
  const rec = await startRecording(page, FRAMES_DIR);

  await card(
    page,
    'ToolTrace',
    [
      'Tool tracking and tool-crib management for factory floors',
      'Passkeys · ESP32 RFID stations · live updates · tamper-evident audit · nightly ML',
    ],
    5,
  );

  // 1. Sign in
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Try the demo' })).toBeVisible();
  await say(page, 'Real accounts sign in with <b>passkeys</b>: no passwords to steal or phish. The public demo adds one-click roles.', '1');
  await hold(page, 5);
  await glideClick(page, page.getByRole('button', { name: /Sign in as the demo admin/ }));

  // 2. The shadow board
  await expect(page.getByRole('heading', { name: 'Tool board' })).toBeVisible();
  await say(page, 'The <b>shadow board</b>: every tool has a place. An empty outline shows who has it and when it’s due.', '2');
  await hold(page, 3);
  await page.mouse.wheel(0, 380);
  await hold(page, 3);
  await page.mouse.wheel(0, -380);

  // 3. Calibration lockout
  await glideClick(page, page.getByRole('link', { name: /^TW-0103 / }));
  await expect(page.getByRole('heading', { name: /Torque Wrench 5-25/ })).toBeVisible();
  await say(page, 'Past its calibration date, a tool is <b>locked</b>. The API refuses it, and so does the database itself.', '3');
  await hold(page, 5);

  // 4. A smart station
  await page.goto('/stations');
  await say(page, 'An <b>ESP32 RFID station</b> at the crib window. Each gets its own key, derived on the server and shown once.', '4');
  await page.getByLabel('Station name').pressSequentially('Crib Station 1', { delay: 45 });
  await glideClick(page, page.getByRole('button', { name: 'Add station' }));
  const config = await page.getByLabel('Firmware settings').textContent();
  await hold(page, 4);
  const id = config!.match(/STATION_ID "([^"]+)"/)![1]!;
  const key = config!.match(/STATION_KEY_HEX "([0-9a-f]{64})"/)![1]!;
  await glideClick(page, page.getByRole('button', { name: "I've saved it" }));
  const station = await connectStation(id, key, TOUR_MQTT_PORT);

  // 5. Live updates from the station
  await page.goto('/');
  await expect(page.getByRole('status', { name: 'Live updates: live' }).first()).toBeVisible();
  rec.mark('liveStart');
  await say(page, 'Asha taps her badge, then a tool, at the station. Every message is <b>HMAC-signed</b>…', '5', 'top');
  await glideTo(page, page.getByRole('link', { name: /^TW-0101 / }));
  await hold(page, 3);
  await station.tap('C0FFEE99');
  await hold(page, 1);
  await station.tap('11223344');
  await expect(page.getByText('Asha Verma checked out TW-0101 at Crib Station 1')).toBeVisible();
  await say(page, '…and the board updates <b>live</b> on every screen. No reload.', '5', 'top');
  await hold(page, 5);
  rec.mark('liveEnd');

  // 6. A forgery
  await station.forge('11223344');
  await page.goto('/stations');
  await expect(page.getByText('Forged or altered message rejected')).toBeVisible();
  await page.getByRole('heading', { name: 'Station activity' }).scrollIntoViewIfNeeded();
  await say(page, 'A <b>forged message</b> gets no reply. It is rejected and logged, with replays and wrong clocks.', '6');
  await hold(page, 5);
  await station.close();

  // 7. Insights
  await page.goto('/insights');
  await expect(page.getByRole('heading', { name: 'Insights', exact: true })).toBeVisible();
  await say(page, 'Every night a <b>Python model</b> scores each tool that’s out for late and loss risk, with the reasons.', '7');
  await hold(page, 4);
  await page.getByRole('heading', { name: 'Tools out now' }).scrollIntoViewIfNeeded();
  await hold(page, 4);
  const flag = page.getByRole('article', { name: /Unusual check-out of/ }).first();
  await flag.scrollIntoViewIfNeeded();
  await say(page, 'An <b>Isolation Forest</b> flags unusual check-outs. A person decides, and that decision is audited.', '7');
  await hold(page, 3);
  await flag.getByLabel('Note (optional)').pressSequentially('Night maintenance, approved', { delay: 40 });
  await glideClick(page, flag.getByRole('button', { name: 'Looks fine' }));
  await hold(page, 3);

  // 8. The audit trail
  await page.goto('/audit');
  await say(page, 'Every change lands in a <b>hash-chained audit trail</b>. Even the database owner can’t quietly edit it.', '8');
  await hold(page, 3);
  await glideClick(page, page.getByRole('button', { name: 'Verify integrity' }));
  await expect(page.getByText(/Chain intact/)).toBeVisible();
  await hold(page, 4);
  await hideCaption(page);

  await card(
    page,
    'ToolTrace',
    [
      'Also: offline check-outs, row-level security, CodeQL, ZAP, a STRIDE threat model',
      'TypeScript · Next.js · PostgreSQL · Redis · Python · C++ (ESP32) · MQTT · Docker',
      'github.com/vijayantrao/Tool-Trace',
    ],
    6,
  );
  expect(await rec.stop()).toBeGreaterThan(100);
});
