import type { Config } from '../config.js';
import type { Sql } from '../db.js';
import { hashToken, newToken } from '../lib/crypto.js';
import type { Role } from '../types.js';

export interface CreatedInvite {
  id: string;
  email: string;
  role: Role;
  expiresAt: Date;
  /** The raw token. Shown exactly once; only its hash is stored. */
  token: string;
  /** Token sits in the URL fragment, which browsers never send to servers or put in logs. */
  inviteUrl: string;
}

export async function createInvite(
  sql: Sql,
  config: Config,
  input: { email: string; role: Role; createdBy: string | null },
): Promise<CreatedInvite> {
  const token = newToken();
  const email = input.email.trim().toLowerCase();
  const [row] = await sql<{ id: string; expiresAt: Date }[]>`
    INSERT INTO invites (email, role, token_hash, created_by, expires_at)
    VALUES (${email}, ${input.role}, ${hashToken(token)}, ${input.createdBy},
            now() + make_interval(hours => ${config.INVITE_TTL_HOURS}))
    RETURNING id, expires_at`;
  return {
    id: row!.id,
    email,
    role: input.role,
    expiresAt: row!.expiresAt,
    token,
    inviteUrl: `${config.APP_URL.replace(/\/$/, '')}/accept-invite#token=${token}`,
  };
}
