import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

export class ApiError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (code: string, message: string) => new ApiError(400, code, message);
export const unauthorized = (message = 'Authentication required') =>
  new ApiError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that') =>
  new ApiError(403, 'forbidden', message);
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (code: string, message: string) => new ApiError(409, code, message);

interface PgError {
  code?: string;
  hint?: string;
  message?: string;
  constraint_name?: string;
}

const isPgError = (e: unknown): e is PgError =>
  typeof e === 'object' && e !== null && 'code' in e && typeof (e as PgError).code === 'string';

/** Translates database errors into safe, meaningful API errors. Never leaks internals. */
export function toApiError(err: unknown): ApiError {
  if (err instanceof ApiError) return err;
  if (isPgError(err)) {
    switch (err.code) {
      case '23505':
        return conflict('already_exists', 'A record with that value already exists');
      case '23503':
        return new ApiError(422, 'invalid_reference', 'A referenced record does not exist');
      case '23514':
        return new ApiError(422, 'constraint_violation', 'The data breaks a validation rule');
      case '22P02':
        return badRequest('invalid_input', 'Malformed identifier or value');
      case 'P0001':
        if (err.hint === 'uid_in_use') return conflict('uid_in_use', err.message ?? 'RFID tag already in use');
        if (err.hint === 'tool_unavailable' || err.hint === 'calibration_expired') {
          return conflict(err.hint, err.message ?? 'Rule violated');
        }
    }
  }
  return new ApiError(500, 'internal_error', 'Something went wrong');
}

export function errorResponse(c: Context, e: ApiError) {
  return c.json(
    { error: { code: e.code, message: e.message, ...(e.details ? { details: e.details } : {}) } },
    e.status,
  );
}
