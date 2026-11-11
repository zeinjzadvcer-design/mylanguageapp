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

/**
 * The tables the Drizzle schema defines, read from its source.
 *
 * The push is limited to these. Other tables live in the same database: some
 * are created by the SQL migrations (ai_usage_logs), some by the app
 * (`session`, from when sessions were kept in Postgres), and extensions add
 * views (pg_stat_statements). Seen by the push, each was a problem — a view
 * it tried to drop, or a table it asked about interactively ("is
 * payment_settings_audit new, or a rename of ai_usage_logs?"), which cannot be
 * answered here and stopped the migration.
 */
function schemaTableNames() {
  const dir = path.join(root, 'lib', 'db', 'src', 'schema');
  const names = new Set();
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(dir, file), 'utf8');
    for (const match of source.matchAll(/pgTable\(\s*["']([a-z0-9_]+)["']/g)) names.add(match[1]);
  }
  if (names.size === 0) throw new Error(`No pgTable definitions found in ${dir}.`);
  return [...names].sort();
}

/**
 * Refuse, before anything is changed, when the push would try to drop an id
 * counter (sequence) that no schema table owns.
 *
 * Drizzle treats every sequence in the database as its own unless a table it
 * can see owns it, so a table outside the schema has its counter dropped — or,
 * when the table still uses it, the push fails partway through. Tables outside
 * the schema are otherwise harmless here and are only listed.
 */
async function checkNothingOutsideSchema(tables) {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const unknownTables = await client.query(
      `select c.relname as name
         from pg_class c join pg_namespace ns on ns.oid = c.relnamespace
        where ns.nspname = 'public' and c.relkind = 'r' and c.relname <> all($1)
        order by 1`,
      [tables],
    );
    const strayCounters = await client.query(
      `select s.relname as name
         from pg_class s join pg_namespace ns on ns.oid = s.relnamespace
        where ns.nspname = 'public' and s.relkind = 'S'
          and not exists (
            select 1 from pg_depend d join pg_class t on t.oid = d.refobjid
             where d.objid = s.oid and d.deptype in ('a', 'i') and t.relname = any($1))
        order by 1`,
      [tables],
    );
    if (unknownTables.rows.length > 0) {
      console.log(
        `Tables outside the Drizzle schema, left alone: ${unknownTables.rows.map((r) => r.name).join(', ')}`,
      );
    }
    if (strayCounters.rows.length > 0) {
      throw new Error(
        `Nothing was changed. The schema push would try to drop these sequences, which no ` +
          `table in lib/db/src/schema owns: ${strayCounters.rows.map((r) => r.name).join(', ')}. ` +
          'Describe the table that uses each one in the Drizzle schema (as ai_usage_logs is), ' +
          'or drop it with a SQL migration if it is no longer used.',
      );
    }
  } finally {
    await client.end();
  }
}

function pushDrizzleSchema(tables) {
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
      // Only the schema's own tables; see schemaTableNames. One glob with a
      // brace list, because the command line takes a single filter.
      arg(`--tablesFilter={${tables.join(',')}}`),
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
const schemaTables = schemaTableNames();
await checkNothingOutsideSchema(schemaTables);
pushDrizzleSchema(schemaTables);
await applySqlMigrations();
console.log('Migrations complete.');
