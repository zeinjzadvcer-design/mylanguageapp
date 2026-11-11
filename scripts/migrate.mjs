#!/usr/bin/env node
/**
 * Bring a database up to date, from empty or from a previous version.
 *
 * 1. Waits for PostgreSQL to accept connections.
 * 2. Pushes the Drizzle schema (lib/db/src/schema).
 * 3. Applies the hand-written SQL migrations in artifacts/api-server/migrations,
 *    which are idempotent and safe to re-run.
 *
 * Usage: DATABASE_URL=postgresql://... node scripts/migrate.mjs
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDatabase({ attempts = 30, delayMs = 1000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    const client = new pg.Client({ connectionString: databaseUrl });
    try {
      await client.connect();
      await client.end();
      console.log('Database is accepting connections.');
      return;
    } catch {
      await client.end().catch(() => {});
      if (i === attempts) {
        throw new Error(`Database unreachable after ${attempts} attempts.`);
      }
      await sleep(delayMs);
    }
  }
}

function pushDrizzleSchema() {
  console.log('Pushing Drizzle schema...');
  // Schema and url are passed explicitly rather than via drizzle.config.ts:
  // the config resolves its schema path with __dirname, which breaks when the
  // project lives under a path containing non-ASCII characters.
  // Quoted for cmd.exe, which the win32 shell below goes through: hosted URLs
  // carry query strings (Neon: ?sslmode=require&channel_binding=...) and an
  // unquoted & would end the command there.
  const arg = (value) => (process.platform === 'win32' ? `"${value}"` : value);
  const result = spawnSync(
    'pnpm',
    [
      '--filter', '@workspace/db', 'exec', 'drizzle-kit', 'push',
      '--force',
      '--dialect=postgresql',
      '--schema=./src/schema/index.ts',
      // The pg_stat_statements extension keeps two views in `public`. They are
      // not in our schema, so the push tried to drop them, Postgres refused,
      // and the push stopped after creating tables but before their indexes and
      // foreign keys. Managed Postgres (DigitalOcean's query insights) commonly
      // has the extension enabled.
      arg('--tablesFilter=!pg_stat_statements*'),
      arg(`--url=${databaseUrl}`),
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    },
  );

  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  process.stdout.write(stdout);
  process.stderr.write(stderr);

  // drizzle-kit exits 0 even when the push fails, and writes the database's
  // error to stderr, which this used not to read: a refused statement left the
  // schema half applied and the script still printed "Migrations complete."
  // The exit code, stdout and stderr are all checked.
  if (/Interactive prompts require a TTY/.test(stdout + stderr)) {
    throw new Error(
      'drizzle-kit push did not complete: it needs an interactive prompt for a ' +
        'structural change (exit code 0 is not trustworthy here). Express that ' +
        'change as a SQL file in artifacts/api-server/migrations instead.',
    );
  }
  if (result.error || result.status !== 0 || /^\s*error:/im.test(stdout + stderr)) {
    throw new Error(
      'drizzle-kit push failed, so the schema is only partly applied. The ' +
        "database's error is printed above. Nothing after this step was run.",
    );
  }
}

async function applySqlMigrations() {
  const dir = path.join(root, 'artifacts', 'api-server', 'migrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  if (files.length === 0) {
    console.log('No SQL migrations to apply.');
    return;
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    for (const file of files) {
      console.log(`Applying ${file}...`);
      await client.query(readFileSync(path.join(dir, file), 'utf8'));
    }
  } finally {
    await client.end();
  }
}

await waitForDatabase();
pushDrizzleSchema();
await applySqlMigrations();
console.log('Migrations complete.');
