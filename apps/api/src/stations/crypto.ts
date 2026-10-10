/**
 * Station message authentication.
 *
 * Each station signs every message with HMAC-SHA256 using its own key. Keys are
 * never stored: they are derived on demand from one server master key with
 * HKDF, so the database holds no secrets and rotating a station's key is just
 * bumping its key_version.
 *
 * The exact byte layout signed by the ESP32 firmware is defined by canonical().
 * firmware/station/test/vectors.json pins it down for both implementations.
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';

export interface StationMessage {
  v: 1;
  seq: number;
  type: 'hello' | 'tap';
  uid: string;
  flag: 'ok' | 'problem';
}

export function decodeMasterKey(raw: string): Buffer {
  const key = /^[0-9a-fA-F]{64,}$/.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length < 32) throw new Error('STATION_MASTER_KEY must be at least 32 bytes');
  return key;
}

export function deriveStationKey(masterKey: Buffer, stationId: string, keyVersion: number): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey, Buffer.from(stationId, 'utf8'), `tooltrace-station-key-v${keyVersion}`, 32));
}

/** The exact string that is signed: fields joined with "|". */
export const canonical = (stationId: string, m: StationMessage) =>
  `v${m.v}|${stationId}|${m.seq}|${m.type}|${m.uid}|${m.flag}`;

export const sign = (key: Buffer, stationId: string, m: StationMessage) =>
  createHmac('sha256', key).update(canonical(stationId, m), 'utf8').digest('hex');

export function verify(key: Buffer, stationId: string, m: StationMessage, sigHex: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;
  const expected = Buffer.from(sign(key, stationId, m), 'hex');
  return timingSafeEqual(expected, Buffer.from(sigHex, 'hex'));
}
