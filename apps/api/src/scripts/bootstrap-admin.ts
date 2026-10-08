/**
 * Creates the very first admin invite. Refuses to run once an active admin
 * exists, so it can't be abused later to mint extra admin accounts, and
 * refuses to issue a second link while one is still pending.
 *
 *   npm run bootstrap-admin -w apps/api -- you@example.com
 *   npm run bootstrap-admin -w apps/api -- you@example.com --replace   (revokes the pending link first)
 */
import { z } from 'zod';
import { loadConfig } from '../config.js';
import { createDb } from '../db.js';
import { createInvite } from '../services/invites.js';

const args = process.argv.slice(2);
const replace = args.includes('--replace');
const email = z.email().safeParse(args.find((a) => !a.startsWith('--')));
if (!email.success) {
  console.error('Usage: npm run bootstrap-admin -- <admin-email> [--replace]');
  process.exit(1);
}

const config = loadConfig();
const sql = createDb(config.DATABASE_URL, { max: 1 });
try {
  const [admins] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM users WHERE role = 'admin' AND is_active`;
  const [pending] = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count FROM invites
    WHERE role = 'admin' AND created_by IS NULL AND used_at IS NULL AND expires_at > now()`;

  if ((admins?.count ?? 0) > 0) {
    console.error('An active admin already exists. Ask them to send you an invite instead.');
    process.exitCode = 1;
  } else if ((pending?.count ?? 0) > 0 && !replace) {
    console.error('A bootstrap admin invite is already pending. Re-run with --replace to revoke it and issue a new one.');
    process.exitCode = 1;
  } else {
    await sql`DELETE FROM invites WHERE role = 'admin' AND created_by IS NULL AND used_at IS NULL`;
    const invite = await createInvite(sql, config, { email: email.data, role: 'admin', createdBy: null });
    console.log(`Admin invite for ${invite.email} (expires ${invite.expiresAt.toISOString()}):`);
    console.log(invite.inviteUrl);
  }
} finally {
  await sql.end();
}
