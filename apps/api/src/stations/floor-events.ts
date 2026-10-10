/**
 * Live floor events. Database triggers call pg_notify() on every change to
 * checkouts, tools and station events; this listens once per API instance and
 * fans enriched events out to connected browsers. Because notifications come
 * from Postgres, every API instance sees every change, whoever made it.
 */
import { EventEmitter } from 'node:events';
import type { Sql } from '../db.js';

export interface FloorEvent {
  kind: 'checked_out' | 'returned' | 'tool_changed' | 'checkout_updated' | 'station_event';
  toolId?: string;
  assetTag?: string;
  stationId?: string;
  /** Who did it, so the browser can skip notifying the person who acted. */
  actorId?: string;
  message?: string;
  at: string;
}

interface Raw {
  kind: FloorEvent['kind'];
  checkoutId?: string;
  toolId?: string;
  stationId?: string;
}

export class FloorEvents extends EventEmitter<{ event: [FloorEvent] }> {
  private unlisten: (() => Promise<void>) | null = null;

  constructor(private readonly sql: Sql) {
    super();
    this.setMaxListeners(1000);
  }

  async start() {
    const sub = await this.sql.listen('tooltrace_floor', (payload) => {
      void this.enrich(JSON.parse(payload) as Raw)
        .then((e) => e && this.emit('event', e))
        .catch((err) => console.error('[events] enrich failed', err));
    });
    this.unlisten = sub.unlisten;
    return this;
  }

  async stop() {
    await this.unlisten?.();
  }

  private async enrich(raw: Raw): Promise<FloorEvent | null> {
    const at = new Date().toISOString();
    if ((raw.kind === 'checked_out' || raw.kind === 'returned') && raw.checkoutId) {
      const [c] = await this.sql<
        {
          toolId: string;
          assetTag: string;
          holderName: string;
          issuedBy: string;
          receivedBy: string | null;
          receiverName: string | null;
          condition: string | null;
          issuedStation: string | null;
          returnedStation: string | null;
        }[]
      >`
        SELECT c.tool_id, t.asset_tag, h.display_name AS holder_name, c.issued_by, c.received_by,
               r.display_name AS receiver_name, c.condition_on_return AS condition,
               si.name AS issued_station, sr.name AS returned_station
        FROM checkouts c
        JOIN tools t ON t.id = c.tool_id
        JOIN users h ON h.id = c.holder_id
        LEFT JOIN users r ON r.id = c.received_by
        LEFT JOIN stations si ON si.id = c.issued_via_station_id
        LEFT JOIN stations sr ON sr.id = c.returned_via_station_id
        WHERE c.id = ${raw.checkoutId}`;
      if (!c) return null;
      if (raw.kind === 'checked_out') {
        return {
          kind: raw.kind,
          toolId: c.toolId,
          assetTag: c.assetTag,
          actorId: c.issuedBy,
          message: `${c.holderName} checked out ${c.assetTag}${c.issuedStation ? ` at ${c.issuedStation}` : ''}`,
          at,
        };
      }
      const quarantined = c.condition && c.condition !== 'ok';
      return {
        kind: raw.kind,
        toolId: c.toolId,
        assetTag: c.assetTag,
        actorId: c.receivedBy ?? undefined,
        message: `${c.assetTag} returned${c.returnedStation ? ` at ${c.returnedStation}` : ''}${quarantined ? ' and quarantined' : ''}`,
        at,
      };
    }
    return { kind: raw.kind, toolId: raw.toolId, stationId: raw.stationId, at };
  }
}
