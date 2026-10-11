/**
 * Loads fictional demo data: locations and tools in a range of calibration
 * states, including one that is expired so the lockout can be demonstrated.
 * Idempotent: safe to run more than once.
 */
import { createDb } from '../db.js';
import { DEMO_COUNTS, seedDemoTools } from '../demo/demo.js';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

const sql = createDb(url, { max: 1 });
try {
  await seedDemoTools(sql);
  console.log(`[seed] ${DEMO_COUNTS.locations} locations and ${DEMO_COUNTS.tools} tools ready (${DEMO_COUNTS.tags} with RFID tags)`);
} finally {
  await sql.end();
}
