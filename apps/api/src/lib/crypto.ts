import { createHash, randomBytes } from 'node:crypto';

/** 256-bit random token, URL-safe. Used for sessions and invites. */
export const newToken = (): string => randomBytes(32).toString('base64url');

/** Only hashes of tokens are stored, so a database leak does not leak live sessions. */
export const hashToken = (token: string): Buffer => createHash('sha256').update(token, 'utf8').digest();
