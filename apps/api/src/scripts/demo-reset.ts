/**
 * Public demo only: wipes the database and loads the demo again (tools, the
 * four one-click personas). Run nightly by .github/workflows/demo-reset.yml,
 * followed by the ML job's synthetic history and a model run.
 *
 * Refuses to touch a database that has real accounts and isn't already a demo database.
 *
 *   DATABASE_URL=... npm run demo:reset -w apps/api
 */
import { createDb } from '../db.js';
import { resetDemo } from '../demo/demo.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = createDb(url, { max: 1 });
try {
  const { wiped } = await resetDemo(sql);
  console.log(`[demo] reset: ${wiped} tables wiped, demo data and personas loaded`);
} catch (err) {
  console.error(`[demo] ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await sql.end();
}
