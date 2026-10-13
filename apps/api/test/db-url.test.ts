import postgres from 'postgres';
import { describe, expect, it } from 'vitest';
import { normalizeDatabaseUrl } from '../src/db.js';

// A Neon connection string as the console's Connect dialog hands it out (fake password).
const NEON =
  'postgresql://neondb_owner:not-a-real-password@ep-quiet-math-b3iwlfyb.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

describe('connection strings pasted from a hosting console', () => {
  it('drops channel_binding, which postgres.js would send to the server as an unknown setting', () => {
    const fixed = new URL(normalizeDatabaseUrl(NEON));
    expect(fixed.searchParams.has('channel_binding')).toBe(false);
    const opts = postgres(normalizeDatabaseUrl(NEON)).options;
    expect(Object.keys(opts.connection)).not.toContain('channel_binding');
  });

  it('verifies Neon’s TLS certificate instead of only encrypting', () => {
    const fixed = new URL(normalizeDatabaseUrl(NEON));
    expect(fixed.searchParams.get('sslmode')).toBe('verify-full');
    expect(postgres(normalizeDatabaseUrl(NEON)).options.ssl).toBe('verify-full');
  });

  it('keeps the user, password, host and database intact', () => {
    const fixed = new URL(normalizeDatabaseUrl(NEON));
    expect([fixed.username, fixed.password, fixed.hostname, fixed.pathname]).toEqual([
      'neondb_owner',
      'not-a-real-password',
      'ep-quiet-math-b3iwlfyb.c-4.ap-southeast-1.aws.neon.tech',
      '/neondb',
    ]);
  });

  it('leaves other databases alone', () => {
    const local = 'postgres://postgres:postgres@localhost:5432/tooltrace';
    expect(normalizeDatabaseUrl(local)).toBe(local);
    const other = 'postgres://u:p@db.example.com/x?sslmode=require';
    expect(new URL(normalizeDatabaseUrl(other)).searchParams.get('sslmode')).toBe('require');
  });
});
