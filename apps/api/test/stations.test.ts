import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import path from 'node:path';
import mqtt from 'mqtt';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonical, deriveStationKey, sign, type StationMessage } from '../src/stations/crypto.js';
import { oledText, replyCanonical, StationGateway, type Outcome, type SignedReply } from '../src/stations/gateway.js';
import { connectGateway } from '../src/stations/mqtt.js';
import { createHarness, isoDay, signUp, TEST_MASTER_KEY, type Harness } from './helpers/harness.js';

/* ------------------------------------------------------------------------ */
/* Cross-language contract with the ESP32 firmware                           */
/* ------------------------------------------------------------------------ */

const vectors = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, '../../../firmware/station/test/vectors.json'), 'utf8'),
);

describe('signing contract shared with the firmware', () => {
  const key = deriveStationKey(Buffer.from(vectors.masterKeyHex, 'hex'), vectors.stationId, vectors.keyVersion);

  it('derives the same station key', () => {
    expect(key.toString('hex')).toBe(vectors.stationKeyHex);
  });

  it.each(vectors.messages as (StationMessage & { canonical: string; sig: string })[])('signs $type $uid exactly as the firmware does', (m) => {
    expect(canonical(vectors.stationId, m)).toBe(m.canonical);
    expect(sign(key, vectors.stationId, m)).toBe(m.sig);
  });

  it('signs replies exactly as the firmware verifies them', () => {
    for (const r of vectors.replies) {
      expect(replyCanonical(vectors.stationId, r)).toBe(r.canonical);
      expect(createHmac('sha256', key).update(r.canonical).digest('hex')).toBe(r.sig);
    }
  });

  it('gives each key version a different key', () => {
    const m = Buffer.from(vectors.masterKeyHex, 'hex');
    expect(deriveStationKey(m, vectors.stationId, 2).equals(key)).toBe(false);
    expect(deriveStationKey(m, '00000000-0000-0000-0000-000000000000', 1).equals(key)).toBe(false);
  });
});

/* ------------------------------------------------------------------------ */
/* A software station, signing exactly like the firmware                     */
/* ------------------------------------------------------------------------ */

class SimStation {
  private seq = Date.now();
  replies: SignedReply[] = [];
  constructor(
    private readonly h: Harness,
    readonly id: string,
    public keyHex: string,
  ) {}

  message(type: 'hello' | 'tap', uid = '', flag: 'ok' | 'problem' = 'ok', seq = ++this.seq): StationMessage & { sig: string } {
    const m: StationMessage = { v: 1, seq, type, uid, flag };
    return { ...m, sig: sign(Buffer.from(this.keyHex, 'hex'), this.id, m) };
  }

  async raw(payload: unknown): Promise<Outcome> {
    const out = await this.h.gateway.handleMessage(
      this.h.gateway.eventsTopic(this.id),
      Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    );
    if (out.reply) this.replies.push(out.reply);
    return out;
  }

  tap = (uid: string, flag: 'ok' | 'problem' = 'ok') => this.raw(this.message('tap', uid, flag));
  hello = () => this.raw(this.message('hello'));

  /** The firmware refuses replies whose signature doesn't verify. */
  verifies(r: SignedReply): boolean {
    const { sig, ...rest } = r;
    return createHmac('sha256', Buffer.from(this.keyHex, 'hex')).update(replyCanonical(this.id, rest)).digest('hex') === sig;
  }
}

let h: Harness;
let admin: Awaited<ReturnType<typeof signUp>>;
let sk: Awaited<ReturnType<typeof signUp>>;
let tech: Awaited<ReturnType<typeof signUp>>;
let auditor: Awaited<ReturnType<typeof signUp>>;
let station: SimStation;
let locationId: string;

const BADGE_TECH = 'c0:ff:ee:99';
const BADGE_AUDITOR = 'DE AD BE EF';
const TAG_OK = '11:22:33:44';
const TAG_EXPIRED = '55:66:77:88';

beforeAll(async () => {
  h = await createHarness();
  admin = await signUp(h, 'admin');
  sk = await signUp(h, 'storekeeper');
  tech = await signUp(h, 'technician', 'Asha Verma');
  auditor = await signUp(h, 'auditor');
  locationId = (await sk.client.post('/api/locations', { name: 'Main Crib', kind: 'crib' })).body.location.id;

  const tool = (tag: string, rfid: string, daysAgo: number) =>
    sk.client.post('/api/tools', {
      assetTag: tag,
      name: `Torque Wrench ${tag}`,
      category: 'Torque',
      homeLocationId: locationId,
      requiresCalibration: true,
      calibrationIntervalDays: 180,
      lastCalibratedOn: isoDay(-daysAgo),
      rfidUid: rfid,
    });
  expect((await tool('TW-0101', TAG_OK, 10)).status).toBe(201);
  expect((await tool('TW-0103', TAG_EXPIRED, 200)).status).toBe(201);
  expect((await admin.client.patch(`/api/users/${tech.user.id}`, { badgeUid: BADGE_TECH })).status).toBe(200);
  expect((await admin.client.patch(`/api/users/${auditor.user.id}`, { badgeUid: BADGE_AUDITOR })).status).toBe(200);

  const created = await admin.client.post('/api/stations', { name: 'Crib Station 1', locationId });
  expect(created.status).toBe(201);
  station = new SimStation(h, created.body.station.id, created.body.provisioning.stationKey);
});
afterAll(async () => {
  await h.close();
});

describe('station display text', () => {
  it('keeps replies drawable on the ASCII-only OLED', () => {
    expect(oledText('Ásha Vérma')).toBe('Asha Verma');
    expect(oledText('आशा')).toBe('');
    expect(oledText('A|B')).toBe('AB');
  });
});

describe('provisioning', () => {
  it('gives the admin everything the firmware needs, once', async () => {
    const res = await admin.client.post('/api/stations', { name: 'Bay 2 Station', locationId });
    const p = res.body.provisioning;
    expect(p.stationKey).toMatch(/^[0-9a-f]{64}$/);
    expect(p.eventsTopic).toBe(`tooltrace/v1/stations/${p.stationId}/events`);
    expect(p.firmwareConfig).toContain(`#define STATION_KEY_HEX "${p.stationKey}"`);
    // The key is derived, never stored.
    const cols = await h.sql`SELECT column_name FROM information_schema.columns WHERE table_name = 'stations'`;
    expect(cols.map((c) => c.columnName)).not.toContain('key');
    expect(deriveStationKey(Buffer.from(TEST_MASTER_KEY, 'hex'), p.stationId, 1).toString('hex')).toBe(p.stationKey);
  });

  it('only admins can create stations; storekeepers and auditors can view them', async () => {
    expect((await sk.client.post('/api/stations', { name: 'X', locationId })).status).toBe(403);
    expect((await sk.client.get('/api/stations')).status).toBe(200);
    expect((await auditor.client.get('/api/stations')).status).toBe(200);
    expect((await tech.client.get('/api/stations')).status).toBe(403);
  });

  it('refuses to provision when the server has no master key', async () => {
    const off = await createHarness({ STATION_MASTER_KEY: undefined });
    try {
      const a = await signUp(off, 'admin');
      const loc = (await a.client.post('/api/locations', { name: 'L', kind: 'crib' })).body.location.id;
      const res = await a.client.post('/api/stations', { name: 'S', locationId: loc });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('stations_disabled');
    } finally {
      await off.close();
    }
  });
});

describe('badges and tool tags', () => {
  it('normalises UIDs written in any common style', async () => {
    const [u] = await h.sql`SELECT badge_uid FROM users WHERE id = ${tech.user.id}`;
    expect(u!.badgeUid).toBe('C0FFEE99');
    const res = await sk.client.get('/api/tools/by-tag/TW-0101');
    expect(res.body.tool.rfidUid).toBe('11223344');
  });

  it('rejects malformed UIDs', async () => {
    const res = await admin.client.patch(`/api/users/${sk.user.id}`, { badgeUid: 'not-a-tag' });
    expect(res.status).toBe(422);
  });

  it('never lets one tag be both a badge and a tool tag', async () => {
    const asBadge = await admin.client.patch(`/api/users/${sk.user.id}`, { badgeUid: TAG_OK });
    expect(asBadge.status).toBe(409);
    expect(asBadge.body.error.code).toBe('uid_in_use');
    const tool = (await sk.client.get('/api/tools/by-tag/TW-0103')).body.tool;
    const asTag = await sk.client.patch(`/api/tools/${tool.id}`, { rfidUid: BADGE_TECH });
    expect(asTag.status).toBe(409);
  });

  it('assigning a badge does not sign the person out', async () => {
    expect((await admin.client.patch(`/api/users/${sk.user.id}`, { badgeUid: 'AA:BB:CC:DD' })).status).toBe(200);
    expect((await sk.client.get('/api/auth/me')).status).toBe(200);
  });
});

describe('station flow', () => {
  it('says hello and is shown online', async () => {
    const out = await station.hello();
    expect(out.outcome).toBe('accepted');
    expect(out.reply).toMatchObject({ ok: true, l1: 'Ready', l2: 'Crib Station 1' });
    expect(station.verifies(out.reply!)).toBe(true);
    const list = await sk.client.get('/api/stations');
    expect(list.body.stations.find((s: { id: string }) => s.id === station.id).online).toBe(true);
  });

  it('asks for a badge before a tool', async () => {
    const out = await station.tap('11223344');
    expect(out.code).toBe('badge_first');
    expect(out.reply).toMatchObject({ ok: false, led: 'amber' });
  });

  it('reports unknown tags and logs their UID so they can be enrolled', async () => {
    const out = await station.tap('0A0B0C0D');
    expect(out.code).toBe('unknown_tag');
    const log = await sk.client.get('/api/station-events?limit=5');
    expect(log.body.events[0]).toMatchObject({ code: 'unknown_tag', uid: '0A:0B:0C:0D', outcome: 'rejected' });
  });

  it('a badge, then a tool: checks the tool out to the badge holder', async () => {
    const hi = await station.tap('C0FFEE99');
    expect(hi.reply).toMatchObject({ ok: true, l1: 'Hi Asha', l2: 'Tap a tool' });
    const out = await station.tap('11223344');
    expect(out.code).toBe('checked_out');
    expect(out.reply).toMatchObject({ ok: true, led: 'green', l1: 'TW-0101 is yours' });
    expect(station.verifies(out.reply!)).toBe(true);

    const tool = (await tech.client.get('/api/tools/by-tag/TW-0101')).body.tool;
    expect(tool.status).toBe('checked_out');
    expect(tool.holderId).toBe(tech.user.id);
    const [c] = await h.sql`SELECT issued_via_station_id FROM checkouts WHERE tool_id = ${tool.id}`;
    expect(c!.issuedViaStationId).toBe(station.id);
  });

  it('tapping the same tool again returns it', async () => {
    const out = await station.tap('11223344');
    expect(out.code).toBe('returned');
    expect((await tech.client.get('/api/tools/by-tag/TW-0101')).body.tool.status).toBe('available');
  });

  it('the problem button quarantines a returned tool', async () => {
    await station.tap('C0FFEE99');
    expect((await station.tap('11223344')).code).toBe('checked_out');
    const out = await station.tap('11223344', 'problem');
    expect(out.code).toBe('returned_problem');
    expect(out.reply?.led).toBe('amber');
    const tool = (await tech.client.get('/api/tools/by-tag/TW-0101')).body.tool;
    expect(tool.status).toBe('quarantined');
    await sk.client.patch(`/api/tools/${tool.id}`, { status: 'available' });
  });

  it('refuses a tool whose calibration has expired', async () => {
    await station.tap('C0FFEE99');
    const out = await station.tap('55667788');
    expect(out.code).toBe('calibration_expired');
    expect(out.reply).toMatchObject({ ok: false, led: 'red', l1: 'LOCKED' });
    expect((await tech.client.get('/api/tools/by-tag/TW-0103')).body.tool.status).toBe('available');
  });

  it('auditor badges cannot take tools', async () => {
    const out = await station.tap('DEADBEEF');
    expect(out.code).toBe('badge_not_allowed');
  });

  it('the badge expires if nobody taps a tool in time', async () => {
    await station.tap('C0FFEE99');
    await h.sql`UPDATE stations SET session_expires_at = now() - interval '1 second' WHERE id = ${station.id}`;
    expect((await station.tap('11223344')).code).toBe('badge_first');
  });
});

describe('station security', () => {
  const toolStatus = async () => (await tech.client.get('/api/tools/by-tag/TW-0101')).body.tool.status;

  it('rejects a forged signature, changes nothing, and sends no reply', async () => {
    await station.tap('C0FFEE99');
    const m = station.message('tap', '11223344');
    const out = await station.raw({ ...m, sig: 'a'.repeat(64) });
    expect(out).toMatchObject({ outcome: 'rejected', code: 'bad_signature' });
    expect(out.reply).toBeUndefined();
    expect(await toolStatus()).toBe('available');
  });

  it('rejects a message whose content was altered after signing', async () => {
    const m = station.message('tap', '11223344');
    expect((await station.raw({ ...m, uid: '55667788' })).code).toBe('bad_signature');
  });

  it('rejects a replayed message', async () => {
    const m = station.message('hello');
    expect((await station.raw(m)).outcome).toBe('accepted');
    expect((await station.raw(m)).code).toBe('replay');
  });

  it('rejects messages with a clock far off', async () => {
    const old = station.message('hello', '', 'ok', Date.now() - 10 * 60_000);
    expect((await station.raw(old)).code).toBe('stale_clock');
  });

  it('rejects malformed and oversized payloads', async () => {
    expect((await station.raw('{not json')).code).toBe('malformed');
    expect((await station.raw({ ...station.message('tap', 'x'.repeat(2000)) })).code).toBe('malformed');
  });

  it('ignores stations that do not exist and topics outside the prefix', async () => {
    const out = await h.gateway.handleMessage('tooltrace/v1/stations/00000000-0000-0000-0000-000000000000/events', Buffer.from('{}'));
    expect(out.code).toBe('unknown_station');
    expect((await h.gateway.handleMessage(`other/stations/${station.id}/events`, Buffer.from('{}'))).code).toBe('bad_topic');
  });

  it('rate-limits a flooding station (production limits)', async () => {
    const strict = new StationGateway(h.sql, h.config);
    const results: string[] = [];
    for (let i = 0; i < 20; i++) {
      const out = await strict.handleMessage(strict.eventsTopic(station.id), Buffer.from(JSON.stringify(station.message('hello'))));
      results.push(out.code);
    }
    expect(results.slice(0, 10).every((c) => c === 'hello')).toBe(true);
    expect(results).toContain('rate_limited');
  });

  it('rotating the key locks out the old key immediately', async () => {
    const rotated = await admin.client.post(`/api/stations/${station.id}/rotate-key`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.station.keyVersion).toBe(2);
    expect((await station.hello()).code).toBe('bad_signature');
    station.keyHex = rotated.body.provisioning.stationKey;
    expect((await station.hello()).outcome).toBe('accepted');
  });

  it('a deactivated station is ignored', async () => {
    await admin.client.patch(`/api/stations/${station.id}`, { isActive: false });
    expect((await station.hello()).code).toBe('station_inactive');
    await admin.client.patch(`/api/stations/${station.id}`, { isActive: true });
  });

  it('every decision is in the audit log', async () => {
    const log = await auditor.client.get(`/api/station-events?stationId=${station.id}&limit=200`);
    const codes = new Set(log.body.events.map((e: { code: string }) => e.code));
    for (const c of ['checked_out', 'returned', 'calibration_expired', 'bad_signature', 'replay', 'stale_clock']) {
      expect(codes).toContain(c);
    }
  });
});

describe('over a real MQTT broker', () => {
  it('a station publishes a signed tap and receives a signed reply', async () => {
    const { Aedes } = await import('aedes');
    const broker = await Aedes.createBroker();
    const server = createServer(broker.handle as (s: import('node:net').Socket) => void);
    await new Promise<void>((r) => server.listen(0, r));
    const url = `mqtt://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const api = await connectGateway(h.gateway, h.config, url);
    const device = await mqtt.connectAsync(url, { clientId: `station-${station.id.slice(0, 8)}` });
    try {
      await device.subscribeAsync(h.gateway.repliesTopic(station.id), { qos: 1 });
      const replied = new Promise<SignedReply>((resolve) =>
        device.on('message', (_t, p) => resolve(JSON.parse(p.toString()) as SignedReply)),
      );
      await device.publishAsync(h.gateway.eventsTopic(station.id), JSON.stringify(station.message('tap', 'C0FFEE99')), { qos: 1 });
      const reply = await replied;
      expect(reply).toMatchObject({ ok: true, l1: 'Hi Asha' });
      expect(station.verifies(reply)).toBe(true);
    } finally {
      await device.endAsync();
      await api.endAsync();
      h.gateway.publish = async () => {};
      await new Promise<void>((r) => server.close(() => broker.close(() => r())));
    }
  });
});

describe('live updates to browsers', () => {
  async function openStream(client: ReturnType<Harness['client']>) {
    const cookie = [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await h.app.request('/api/events', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async (event: string, timeoutMs = 4000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const blocks = buffer.split('\n\n');
        for (let i = 0; i < blocks.length - 1; i++) {
          if (blocks[i]!.includes(`event: ${event}`)) {
            buffer = blocks.slice(i + 1).join('\n\n');
            const data = blocks[i]!.split('\n').find((l) => l.startsWith('data: '))!.slice(6);
            return JSON.parse(data);
          }
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<{ done: true; value: undefined }>((r) => setTimeout(() => r({ done: true, value: undefined }), deadline - Date.now())),
        ]);
        if (chunk.done && !chunk.value) break;
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      throw new Error(`no "${event}" event within ${timeoutMs} ms`);
    };
    return { next, close: () => reader.cancel() };
  }

  it('requires sign-in', async () => {
    expect((await h.client().get('/api/events')).status).toBe(401);
  });

  it('pushes a checkout made at a station to every open board, with who and where', async () => {
    const stream = await openStream(sk.client);
    await stream.next('ready');
    await station.tap('C0FFEE99');
    await station.tap('11223344');
    let evt = await stream.next('floor');
    while (evt.kind !== 'checked_out') evt = await stream.next('floor');
    expect(evt).toMatchObject({ kind: 'checked_out', assetTag: 'TW-0101', actorId: tech.user.id });
    expect(evt.message).toBe('Asha Verma checked out TW-0101 at Crib Station 1');
    await stream.close();
    await station.tap('11223344');
  });

  it('closes the stream when the session ends', async () => {
    const temp = await signUp(h, 'technician');
    const stream = await openStream(temp.client);
    await stream.next('ready');
    await admin.client.patch(`/api/users/${temp.user.id}`, { isActive: false });
    expect(await stream.next('signed_out')).toEqual({});
  });
});
