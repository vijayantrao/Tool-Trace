/**
 * Runs before the API starts for end-to-end tests: fresh database, migrate,
 * demo tools, and the bootstrap admin invite minted by the real CLI script.
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL!;
const STATE_FILE = path.join(import.meta.dirname, '.state.json');
const apiDir = path.resolve(import.meta.dirname, '../../api');

const url = new URL(DB_URL);
const dbName = url.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('e2e')) throw new Error(`Refusing to reset database "${dbName}"`);
url.pathname = '/postgres';
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${dbName}`);
await admin.end();

const run = (script: string, ...args: string[]) =>
  execFileSync('npx', ['tsx', `src/scripts/${script}.ts`, ...args], { cwd: apiDir, env: process.env, encoding: 'utf8' });

run('migrate');
run('seed-demo');
const out = run('bootstrap-admin', 'admin@tooltrace.example');
const inviteUrl = out.match(/https?:\/\/\S+/)?.[0];
if (!inviteUrl) throw new Error(`No invite URL in bootstrap output:\n${out}`);
writeFileSync(STATE_FILE, JSON.stringify({ adminInviteUrl: inviteUrl }));
console.log('[e2e] database ready');
