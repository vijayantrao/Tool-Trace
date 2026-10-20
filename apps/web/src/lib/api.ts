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

export async function api<T>(
  path: string,
  init: { method?: string; body?: unknown; idempotencyKey?: string } = {},
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  // Lets an offline action be sent again safely: the server applies it only once.
  if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers,
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

/** Sends a form with a file (multipart). The browser sets the content type and boundary. */
export async function apiForm<T>(path: string, form: FormData): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, { method: 'POST', body: form, credentials: 'same-origin', cache: 'no-store' });
  } catch {
    throw new ApiError(0, 'network', 'No connection to the server. Check your network and try again.');
  }
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
    unitPrice: 'Unit price',
    make: 'Make',
    model: 'Model',
    labName: 'Lab',
    labEmail: 'Lab email',
    expectedBackOn: 'Expected back',
    code: 'Code',
    unit: 'Unit',
    reorderLevel: 'Reorder level',
    quantity: 'Quantity',
    countedQuantity: 'Counted quantity',
    note: 'Note',
    title: 'What is needed',
    estimatedCost: 'Estimated cost',
    toolId: 'Tool',
  })[path] ?? path;
