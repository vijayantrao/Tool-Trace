/**
 * Builds the tour's database exactly as the nightly demo reset does:
 * demo data and personas, then the ML job's synthetic history and a model run.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import postgres from 'postgres';

const DB_URL = process.env.DATABASE_URL!;
const url = new URL(DB_URL);
const dbName = url.pathname.slice(1);
if (!/^[a-z0-9_]+$/.test(dbName) || !dbName.includes('tour')) throw new Error(`Refusing to reset database "${dbName}"`);
url.pathname = '/postgres';
const admin = postgres(url.toString(), { max: 1, onnotice: () => {} });
await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.unsafe(`CREATE DATABASE ${dbName}`);
await admin.end();

const apiDir = path.resolve(import.meta.dirname, '../../api');
const mlDir = path.resolve(import.meta.dirname, '../../../ml');
const run = (cmd: string, args: string[], cwd: string) =>
  process.stdout.write(execFileSync(cmd, args, { cwd, env: process.env, encoding: 'utf8' }));

run('npx', ['tsx', 'src/scripts/demo-reset.ts'], apiDir);
const python = process.env.ML_PYTHON ?? 'python3';
run(python, ['-m', 'tooltrace_ml', 'seed-history', '--open'], mlDir);
run(python, ['-m', 'tooltrace_ml', 'run'], mlDir);
