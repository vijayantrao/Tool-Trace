/**
 * RFID UIDs arrive in many spellings ("c0:ff:ee:99", "C0 FF EE 99", "c0ffee99").
 * They are stored one way: uppercase hex, no separators, 4, 7 or 10 bytes.
 */
const UID = /^([0-9A-F]{8}|[0-9A-F]{14}|[0-9A-F]{20})$/;

export function normalizeUid(raw: string): string | null {
  const s = raw.replace(/[\s:.-]/g, '').toUpperCase();
  return UID.test(s) ? s : null;
}

/** C0FFEE99 -> C0:FF:EE:99 */
export const formatUid = (uid: string) => uid.match(/.{2}/g)!.join(':');
