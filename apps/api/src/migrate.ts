import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Sql } from './db.js';

/** Repo-root /db/migrations. Works from both src/ and dist/ (same depth). */
export const DEFAULT_MIGRATIONS_DIR = path.resolve(import.meta.dirname, '../../../db/migrations');

const LOCK_ID = 727_274_001;

/**
 * Applies pending *.sql migrations in filename order inside one transaction,
 * guarded by an advisory lock so two app instances can never migrate at once.
 */
export async function migrate(sql: Sql, dir = DEFAULT_MIGRATIONS_DIR): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const applied: string[] = [];

  await sql.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(${LOCK_ID})`;
    await tx`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version     text PRIMARY KEY,
        applied_at  timestamptz NOT NULL DEFAULT now()
      )`;
    const done = new Set(
      (await tx<{ version: string }[]>`SELECT version FROM schema_migrations`).map((r) => r.version),
    );
    for (const file of files) {
      if (done.has(file)) continue;
      const body = await readFile(path.join(dir, file), 'utf8');
      await tx.unsafe(body);
      await tx`INSERT INTO schema_migrations (version) VALUES (${file})`;
      applied.push(file);
    }
  });

  return applied;
}
