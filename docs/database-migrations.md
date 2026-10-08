# Database migrations

The API calls `runDatabaseMigrations()` from `initDatabase()`. The migration owner is [runner.ts](../apps/api/src/infrastructure/migrations/runner.ts); [manifest.ts](../apps/api/src/infrastructure/migrations/manifest.ts) explicitly orders the upgrade history and baseline snapshots.

## Empty databases and existing databases

An empty migration ledger is insufficient to identify an empty database. Before bootstrapping, the runner checks PostgreSQL's namespace dependencies for objects in the `public` schema, including tables, views, sequences, functions, composite types, and collations. The ledger, extension members, and their automatically or internally owned implementation objects are allowed. An untracked nonempty schema fails startup without running migration SQL; reconcile its history explicitly rather than treating it as a new installation.

A verified empty schema uses the newest registered baseline. The current [0077 snapshot](../apps/api/src/infrastructure/migrations/baselines/0077-current-schema.sql) contains the schema and default configuration after all migrations through `0077_drop_bazi_cases`. It skips historical user-data cleanup and tables retired through that boundary.

The subsequent `0078_drop_public_financial_ledger` migration removes `public_financial_ledger_entries` and its records on both fresh installations and existing databases. The published 0077 snapshot and older upgrade SQL remain frozen; the retired table is removed before database initialization completes.

The snapshot and all covered migration IDs are committed in one transaction. A failure rolls back the schema and those ledger entries together, allowing a later startup to retry. The empty ledger table may remain after a failed bootstrap.

Databases with recorded migration history always use [versions/](../apps/api/src/infrastructure/migrations/versions/). Each missing migration runs in its own transaction and records its original ID and description. The legacy `0001_core_schema_baseline` already represents historical migrations 0001–0067. Older ledgers may additionally contain historical 0002–0069 IDs; those records remain intact.

Both paths share the existing PostgreSQL advisory lock and 120-second transaction statement and idle budgets. Baseline SQL excludes dump-level session settings so it cannot disable those budgets. The normal API connection and query limits are documented in [Database reliability](database-reliability.md).

## Adding an upgrade

1. Add a file under `versions/` exporting one named `DatabaseMigration` object.
2. Use a new increasing ID and append it to `MIGRATIONS` in `manifest.ts`. Keep published SQL, IDs, descriptions, and ordering stable. Keep data-fix logic owned by its migration so later business-code changes cannot change historical replay.
3. Add relevant behavior tests. Until the next baseline is generated, both new and existing databases run the appended migrations after their covered history.

The manifest rejects duplicate or reordered migration IDs and baseline boundaries that are unknown or out of order. Frozen baseline snapshots coexist with the upgrade history; they do not replace it.

## Generating a new baseline

Build the API, start the Docker engine, then generate a new snapshot file:

```bash
pnpm run build:api
node scripts/generate-database-baseline.mjs apps/api/src/infrastructure/migrations/baselines/0080-current-schema.sql 0080_example_change
```

Replace the example ID with a migration registered in the manifest. Omitting the final argument selects the latest registered migration. The generator refuses to overwrite an existing snapshot.

The generator creates its own disposable PostgreSQL container using the image pinned in `docker-compose.yml`, replays source-controlled migrations through the selected boundary, and uses that container's `pg_dump` to capture schema and default seeds. It takes no live database connection or workspace `.env` input. It strips client meta commands and session settings, and removes its container when finished. The printed container name is the recovery handle if the process is interrupted.

Add a corresponding baseline module with `throughMigrationId` set to the captured boundary, then append it to `BASELINES`. Keep older snapshots frozen. API builds copy baseline `.sql` files into `dist`; production runtime packages include them with the compiled API.

Before registering the snapshot, compare an empty installation with the historical upgrade path on disposable PostgreSQL. Include table and column definitions, defaults, indexes, constraints, comments, extensions, and default configuration rows. Source-controlled default seeds must stay free of installation-specific user data and credentials.

## Validation

The unit suite covers bootstrap selection, covered IDs, ledger failures, migration ordering, incremental upgrades, and repeated startup. The opt-in PostgreSQL suite covers schema and seed equivalence, upgrading from 0075 while preserving user data, preinstalled extensions, rejecting untracked objects, rollback and retry, and concurrent first startup.

```bash
pnpm test apps/api/tests/infrastructure/migrations.test.ts
pnpm test apps/api/tests/infrastructure/migrations-postgres.integration.test.ts
```

For the second command, provide `FATECLAW_TEST_MIGRATIONS_DATABASE_URL` to the consuming test process. It must point to a disposable PostgreSQL server with `CREATE DATABASE` permission. The suite creates and drops only its own databases and never falls back to the application's `DATABASE_URL`.

These paths were verified on disposable PostgreSQL 18.4. Deployment and writes against an existing configured database were not exercised (unverified).
