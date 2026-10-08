import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../', import.meta.url));
const outputArg = process.argv[2];
if (!outputArg || !outputArg.endsWith('.sql')) {
  throw new Error(
    'Usage: node scripts/generate-database-baseline.mjs <new-snapshot.sql> [through-migration-id]',
  );
}
const outputPath = path.resolve(outputArg);
if (fs.existsSync(outputPath)) {
  throw new Error('Baseline snapshots are immutable; choose a new output file');
}

const { MIGRATIONS } =
  await import('../apps/api/dist/infrastructure/migrations/manifest.js');
const throughId = process.argv[3] ?? MIGRATIONS.at(-1).id;
const boundary = MIGRATIONS.findIndex(
  (migration) => migration.id === throughId,
);
if (boundary < 0) throw new Error(`Unknown migration boundary: ${throughId}`);
const compose = fs.readFileSync(
  path.join(repoRoot, 'docker-compose.yml'),
  'utf8',
);
const image = compose.match(/^\s*image:\s*(postgres:\S+)/m)?.[1];
if (!image) throw new Error('No PostgreSQL image found in docker-compose.yml');

const require = createRequire(
  new URL('../apps/api/package.json', import.meta.url),
);
const { Client } = require('pg');
const container = `fateclaw-baseline-${randomUUID().slice(0, 8)}`;
const database = 'fateclaw_baseline';
let started = false;
let client;

function docker(args) {
  return execFileSync('docker', args, {
    encoding: 'utf8',
    timeout: 60000,
    maxBuffer: 2 * 1024 * 1024,
  });
}

try {
  console.log(`Starting disposable container ${container} (${image})`);
  docker([
    'run',
    '--detach',
    '--rm',
    '--name',
    container,
    '--publish',
    '127.0.0.1::5432',
    '--tmpfs',
    '/var/lib/postgresql:rw,size=256m',
    '--env',
    'POSTGRES_HOST_AUTH_METHOD=trust',
    '--env',
    `POSTGRES_DB=${database}`,
    image,
  ]);
  started = true;
  let ready = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      docker([
        'exec',
        container,
        'pg_isready',
        '--host=127.0.0.1',
        '--username=postgres',
        `--dbname=${database}`,
      ]);
      ready = true;
      break;
    } catch (err) {
      if (err.status !== 1 && err.status !== 2) throw err;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  if (!ready)
    throw new Error(`PostgreSQL did not become ready in ${container}`);

  const port = Number(
    docker(['port', container, '5432/tcp']).trim().split(':').at(-1),
  );
  client = new Client({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database,
    connectionTimeoutMillis: 5000,
    query_timeout: 125000,
  });
  await client.connect();
  await client.query("SET statement_timeout = '120s'");
  for (const migration of MIGRATIONS.slice(0, boundary + 1)) {
    await client.query('BEGIN');
    try {
      await migration.up(client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  }

  // Replay only source-controlled migrations; a live database is never a snapshot input.
  const dump = docker([
    'exec',
    container,
    'pg_dump',
    '--username=postgres',
    `--dbname=${database}`,
    '--no-owner',
    '--no-privileges',
    '--column-inserts',
  ]);
  const sql =
    dump
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('--') &&
          !line.startsWith('\\') &&
          !line.startsWith('SET ') &&
          !line.startsWith('SELECT pg_catalog.set_config('),
      )
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n';
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, sql, { flag: 'wx' });
  console.log(`Wrote baseline through ${throughId}: ${outputPath}`);
} finally {
  if (client) await client.end();
  if (started) docker(['rm', '--force', container]);
}
