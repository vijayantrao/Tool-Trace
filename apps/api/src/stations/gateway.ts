/**
 * Station gateway: turns signed RFID taps from ESP32 stations (over MQTT) into
 * check-outs and returns, and answers each station with a signed reply.
 *
 * Every message passes these gates, in order, before it can change anything:
 *   1. topic names a known, active station
 *   2. payload is small and well-formed
 *   3. HMAC signature matches the station's derived key
 *   4. sequence is fresh (within 5 minutes) and higher than any seen before (no replays)
 *   5. per-station rate limit
 * Rejected messages get no reply, so an attacker learns nothing, but are logged.
 */
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { Sql, TxSql } from '../db.js';
import { ApiError, toApiError } from '../lib/errors.js';
import { enterAppRole, setActorUser } from '../middleware/db.js';
import { normalizeUid } from '../lib/uid.js';
import { checkOutTool, returnCheckout } from '../services/floor.js';
import { decodeMasterKey, deriveStationKey, verify, type StationMessage } from './crypto.js';

export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const MAX_PAYLOAD_BYTES = 1024;

const messageSchema = z.object({
  v: z.literal(1),
  seq: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  type: z.enum(['hello', 'tap']),
  uid: z.string().max(32),
  flag: z.enum(['ok', 'problem']),
  sig: z.string().length(64),
});

export type Led = 'green' | 'red' | 'amber' | 'blue';
export interface Reply {
  seq: number;
  ok: boolean;
  led: Led;
  l1: string;
  l2: string;
}
export interface SignedReply extends Reply {
  sig: string;
}

export interface Outcome {
  outcome: 'accepted' | 'rejected' | 'ignored';
  code: string;
  reply?: SignedReply;
}

interface StationRow {
  id: string;
  name: string;
  isActive: boolean;
  keyVersion: number;
}

/** The station's OLED font is plain ASCII: drop accents and anything it can't draw, and the "|" separator. */
export const oledText = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]|\|/g, '')
    .trim();
const line = (s: string) => oledText(s).slice(0, 20);
const firstName = (n: string) => oledText(n.split(/\s+/)[0] ?? '') || 'there';

/** Replies are signed too, so a station can't be fooled by a forged "Checked out" on a shared broker. */
export const replyCanonical = (stationId: string, r: Reply) =>
  `r1|${stationId}|${r.seq}|${r.ok ? 1 : 0}|${r.led}|${r.l1}|${r.l2}`;

export class StationGateway {
  private readonly master: Buffer | null;
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  readonly topicPrefix: string;

  /** Sends a reply to the broker. Set by connectGateway(); tests may replace it. */
  publish: (topic: string, payload: string) => Promise<void> = async () => {};

  constructor(
    private readonly sql: Sql,
    private readonly config: Config,
    /** Taps per station: short bursts allowed, sustained flooding refused. */
    private readonly limits = { burst: 10, perSecond: 4 },
  ) {
    this.master = config.STATION_MASTER_KEY ? decodeMasterKey(config.STATION_MASTER_KEY) : null;
    this.topicPrefix = config.MQTT_TOPIC_PREFIX;
  }

  get enabled() {
    return this.master !== null;
  }

  eventsTopic = (stationId: string) => `${this.topicPrefix}/stations/${stationId}/events`;
  repliesTopic = (stationId: string) => `${this.topicPrefix}/stations/${stationId}/replies`;
  subscription = () => `${this.topicPrefix}/stations/+/events`;

  keyFor(stationId: string, keyVersion: number): Buffer {
    if (!this.master) throw new ApiError(503, 'stations_disabled', 'Smart stations are not configured on this server');
    return deriveStationKey(this.master, stationId, keyVersion);
  }

  private allow(stationId: string): boolean {
    // Token bucket per station.
    const now = Date.now();
    const { burst, perSecond } = this.limits;
    const b = this.buckets.get(stationId) ?? { tokens: burst, at: now };
    b.tokens = Math.min(burst, b.tokens + ((now - b.at) / 1000) * perSecond);
    b.at = now;
    if (b.tokens < 1) {
      this.buckets.set(stationId, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(stationId, b);
    return true;
  }

  private async log(
    tx: TxSql,
    stationId: string,
    e: { kind: 'hello' | 'tap'; uid?: string | null; outcome: 'accepted' | 'rejected'; code: string; userId?: string | null; toolId?: string | null },
  ) {
    await tx`
      INSERT INTO station_events (station_id, kind, uid, outcome, code, user_id, tool_id)
      VALUES (${stationId}, ${e.kind}, ${e.uid ?? null}, ${e.outcome}, ${e.code}, ${e.userId ?? null}, ${e.toolId ?? null})`;
  }

  private signReply(stationId: string, keyVersion: number, r: Reply): SignedReply {
    const r2 = { ...r, l1: line(r.l1), l2: line(r.l2) };
    const sig = createHmac('sha256', this.keyFor(stationId, keyVersion)).update(replyCanonical(stationId, r2), 'utf8').digest('hex');
    return { ...r2, sig };
  }

  /** Entry point for every MQTT message. Never throws. */
  async handleMessage(topic: string, payload: Buffer): Promise<Outcome> {
    try {
      return await this.process(topic, payload);
    } catch (err) {
      console.error('[stations] failed to process message', err);
      return { outcome: 'ignored', code: 'internal_error' };
    }
  }

  private async process(topic: string, payload: Buffer): Promise<Outcome> {
    if (!this.master) return { outcome: 'ignored', code: 'stations_disabled' };
    const match = topic.match(/\/stations\/([0-9a-f-]{36})\/events$/);
    if (!match || !topic.startsWith(`${this.topicPrefix}/`)) return { outcome: 'ignored', code: 'bad_topic' };
    const stationId = match[1]!;

    // One transaction per message, running as the restricted role in the
    // "station" context: row-level security lets it touch only this station's
    // row and issue tools only to the person who badged in.
    const result = await this.sql.begin((tx) =>
      enterAppRole(tx, { role: 'station', stationId }, { write: true }).then(() => this.decide(tx, stationId, payload)),
    );
    // Reply only after the decision is committed, so the screen never shows a change that was rolled back.
    if (result.reply) {
      await this.publish(this.repliesTopic(stationId), JSON.stringify(result.reply)).catch((err: Error) =>
        console.warn(`[stations] could not deliver reply to ${stationId}: ${err.message}`),
      );
    }
    return result;
  }

  private async decide(tx: TxSql, stationId: string, payload: Buffer): Promise<Outcome> {
    const [station] = await tx<StationRow[]>`
      SELECT id, name, is_active, key_version FROM stations WHERE id = ${stationId}`;
    if (!station) return { outcome: 'ignored', code: 'unknown_station' };
    if (!station.isActive) {
      await this.log(tx, stationId, { kind: 'hello', outcome: 'rejected', code: 'station_inactive' });
      return { outcome: 'rejected', code: 'station_inactive' };
    }

    let parsed: z.infer<typeof messageSchema>;
    try {
      if (payload.length > MAX_PAYLOAD_BYTES) throw new Error('too large');
      parsed = messageSchema.parse(JSON.parse(payload.toString('utf8')));
    } catch {
      await this.log(tx, stationId, { kind: 'tap', outcome: 'rejected', code: 'malformed' });
      return { outcome: 'rejected', code: 'malformed' };
    }
    const { sig, ...msg } = parsed;
    const message = msg as StationMessage;

    if (!verify(this.keyFor(stationId, station.keyVersion), stationId, message, sig)) {
      await this.log(tx, stationId, { kind: message.type, uid: message.uid || null, outcome: 'rejected', code: 'bad_signature' });
      return { outcome: 'rejected', code: 'bad_signature' };
    }

    if (Math.abs(message.seq - Date.now()) > MAX_CLOCK_SKEW_MS) {
      await this.log(tx, stationId, { kind: message.type, outcome: 'rejected', code: 'stale_clock' });
      return { outcome: 'rejected', code: 'stale_clock' };
    }
    // Atomic replay check: only one message with a given (or lower) sequence can ever pass.
    const fresh = await tx`
      UPDATE stations SET last_seq = ${message.seq}, last_seen_at = now()
      WHERE id = ${stationId} AND last_seq < ${message.seq}
      RETURNING id`;
    if (fresh.length === 0) {
      await this.log(tx, stationId, { kind: message.type, outcome: 'rejected', code: 'replay' });
      return { outcome: 'rejected', code: 'replay' };
    }

    if (!this.allow(stationId)) {
      await this.log(tx, stationId, { kind: message.type, outcome: 'rejected', code: 'rate_limited' });
      return { outcome: 'rejected', code: 'rate_limited' };
    }

    const respond = async (code: string, ok: boolean, led: Led, l1: string, l2: string, extra: { userId?: string; toolId?: string } = {}) => {
      await this.log(tx, stationId, {
        kind: message.type,
        uid: message.uid || null,
        outcome: ok ? 'accepted' : 'rejected',
        code,
        ...extra,
      });
      const reply = this.signReply(stationId, station.keyVersion, { seq: message.seq, ok, led, l1, l2 });
      return { outcome: ok ? 'accepted' : 'rejected', code, reply } as Outcome;
    };

    if (message.type === 'hello') return respond('hello', true, 'blue', 'Ready', station.name);

    const uid = normalizeUid(message.uid);
    if (!uid) return respond('bad_uid', false, 'red', 'Unreadable tag', 'Try again');

    // 1. Is it a badge?
    const [person] = await tx<{ id: string; displayName: string; role: string; isActive: boolean }[]>`
      SELECT id, display_name, role, is_active FROM users WHERE badge_uid = ${uid}`;
    if (person) {
      if (!person.isActive || person.role === 'auditor') {
        return respond('badge_not_allowed', false, 'red', 'Badge not allowed', 'See the crib', { userId: person.id });
      }
      await tx`
        UPDATE stations SET session_user_id = ${person.id},
               session_expires_at = now() + make_interval(secs => ${this.config.STATION_SESSION_SECONDS})
        WHERE id = ${stationId}`;
      return respond('badge_ok', true, 'blue', `Hi ${firstName(person.displayName)}`, 'Tap a tool', { userId: person.id });
    }

    // 2. Is it a tool tag?
    const [tool] = await tx<{ id: string; assetTag: string; status: string }[]>`
      SELECT id, asset_tag, status FROM tools WHERE rfid_uid = ${uid}`;
    if (!tool) return respond('unknown_tag', false, 'red', 'Unknown tag', 'Ask the crib');

    const [session] = await tx<{ userId: string; displayName: string }[]>`
      SELECT u.id AS user_id, u.display_name FROM stations s JOIN users u ON u.id = s.session_user_id
      WHERE s.id = ${stationId} AND s.session_expires_at > now() AND u.is_active AND u.role <> 'auditor'`;
    if (!session) return respond('badge_first', false, 'amber', 'Tap your badge', 'first', { toolId: tool.id });

    // From here on, the person who badged in is the actor (for row-level security and the audit trail).
    await setActorUser(tx, session.userId);
    // Keep the session alive while someone taps several tools in a row.
    await tx`
      UPDATE stations SET session_expires_at = now() + make_interval(secs => ${this.config.STATION_SESSION_SECONDS})
      WHERE id = ${stationId}`;
    const who = { userId: session.userId, toolId: tool.id };

    try {
      // A savepoint, so a refused check-out still lets us record why.
      if (tool.status === 'checked_out') {
        const problem = message.flag === 'problem';
        await tx.savepoint(async (sp) => {
          const [open] = await sp<{ id: string }[]>`
            SELECT id FROM checkouts WHERE tool_id = ${tool.id} AND returned_at IS NULL`;
          if (!open) throw new ApiError(409, 'not_checked_out', 'Not checked out');
          await returnCheckout(sp, {
            checkoutId: open.id,
            receivedBy: session.userId,
            condition: problem ? 'damaged' : 'ok',
            notes: problem ? 'Problem reported at station' : null,
            stationId,
          });
        });
        return problem
          ? respond('returned_problem', true, 'amber', `${tool.assetTag} returned`, 'Quarantined. Thanks', who)
          : respond('returned', true, 'green', `${tool.assetTag} returned`, 'Thank you', who);
      }

      const due = new Date(Date.now() + this.config.STATION_CHECKOUT_HOURS * 3_600_000);
      await tx.savepoint((sp) =>
        checkOutTool(sp, { tool: { id: tool.id }, holderId: session.userId, issuedBy: session.userId, dueBackAt: due, stationId }),
      );
      return respond('checked_out', true, 'green', `${tool.assetTag} is yours`, `Due in ${this.config.STATION_CHECKOUT_HOURS} h`, who);
    } catch (err) {
      const { code } = toApiError(err);
      if (code === 'calibration_expired') return respond(code, false, 'red', 'LOCKED', 'Calibration expired', who);
      if (code === 'tool_unavailable') {
        return respond(code, false, 'red', 'Not available', tool.status === 'quarantined' ? 'Quarantined' : tool.status, who);
      }
      if (code !== 'internal_error') return respond(code, false, 'red', 'Not allowed', 'See the crib', who);
      throw err;
    }
  }
}
