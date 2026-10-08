import { zValidator } from '@hono/zod-validator';
import type { ValidationTargets } from 'hono';
import type { ZodType } from 'zod';
import { ApiError, errorResponse } from './errors.js';

/** zod validation with one consistent error shape for the whole API. */
export const validate = <T extends ZodType, Target extends keyof ValidationTargets>(
  target: Target,
  schema: T,
) =>
  zValidator(target, schema, (result, c) => {
    if (!result.success) {
      const details = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      return errorResponse(c, new ApiError(422, 'validation_failed', 'Request validation failed', details));
    }
  });
