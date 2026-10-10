import type { CalibrationState, Role, ToolStatus } from './types';

const dayFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const shortFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const timeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const rel = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "2026-11-03" (a calendar date, no time zone) -> local Date at midnight. */
export const parseDay = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y!, m! - 1, day!);
};

export const formatDay = (d: string) => dayFmt.format(parseDay(d));
export const formatShortDay = (d: string) => shortFmt.format(parseDay(d));
export const formatDateTime = (iso: string) => timeFmt.format(new Date(iso));

/** "in 3 hours", "yesterday", "in 2 days" */
export function relative(iso: string, now = Date.now()): string {
  const diff = new Date(iso).getTime() - now;
  const abs = Math.abs(diff);
  if (abs < 3_600_000) return rel.format(Math.round(diff / 60_000), 'minute');
  if (abs < 86_400_000) return rel.format(Math.round(diff / 3_600_000), 'hour');
  return rel.format(Math.round(diff / 86_400_000), 'day');
}

export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const statusLabel: Record<ToolStatus, string> = {
  available: 'In the crib',
  checked_out: 'Checked out',
  quarantined: 'Quarantined',
  retired: 'Retired',
};

export const calibrationLabel: Record<CalibrationState, string> = {
  ok: 'Calibrated',
  due_soon: 'Calibration due soon',
  expired: 'Calibration expired',
  not_required: 'No calibration needed',
};

export const roleLabel: Record<Role, string> = {
  admin: 'Admin',
  storekeeper: 'Storekeeper',
  technician: 'Technician',
  auditor: 'Auditor',
};

export const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('');

/** C0FFEE99 -> C0:FF:EE:99 */
export const formatUid = (uid: string | null) => (uid ? uid.match(/.{2}/g)!.join(':') : '');
