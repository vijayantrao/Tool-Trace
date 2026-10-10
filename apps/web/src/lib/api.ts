/** Thin JSON client for the ToolTrace API. Same-origin only: /api is proxied by Next.js. */

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'No connection to the server. Check your network and try again.');
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const e = data?.error;
    throw new ApiError(res.status, e?.code ?? 'unknown', e?.message ?? `Request failed (${res.status})`, e?.details);
  }
  return data as T;
}

/** First field-level message if there is one, otherwise the general message. */
export function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const first = err.details?.[0];
    return first ? `${labelFor(first.path)}: ${first.message}` : err.message;
  }
  return 'Something went wrong. Try again.';
}

const labelFor = (path: string) =>
  ({
    assetTag: 'Asset tag',
    name: 'Name',
    category: 'Category',
    homeLocationId: 'Location',
    calibrationIntervalDays: 'Calibration interval',
    lastCalibratedOn: 'Last calibrated',
    requiresCalibration: 'Calibration',
    email: 'Email',
    displayName: 'Your name',
    dueBackAt: 'Due back',
    performedBy: 'Calibrated by',
    calibratedOn: 'Calibration date',
  })[path] ?? path;
