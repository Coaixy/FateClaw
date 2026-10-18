# Database migrations

The API calls `runDatabaseMigrations()` from `initDatabase()`. The migration owner is [runner.ts](../apps/api/src/infrastructure/migrations/runner.ts); [manifest.ts](../apps/api/src/infrastructure/migrations/manifest.ts) explicitly orders the upgrade history and baseline snapshots.

## Empty databases and existing databases

An empty migration ledger is insufficient to identify an empty database. Before bootstrapping, the runner checks PostgreSQL's namespace dependencies for objects in the `public` schema, including tables, views, sequences, functions, composite types, and collations. The ledger, extension members, and their automatically or internally owned implementation objects are allowed. An untracked nonempty schema fails startup without running migration SQL; reconcile its history explicitly rather than treating it as a new installation.

A verified empty schema uses the newest registered baseline. The current [0077 snapshot](../apps/api/src/infrastructure/migrations/baselines/0077-current-schema.sql) contains the schema and default configuration after all migrations through `0077_drop_bazi_cases`. It skips historical user-data cleanup and tables retired through that boundary.

The subsequent `0078_drop_public_financial_ledger` migration removes `public_financial_ledger_entries` and its records on both fresh installations and existing databases. The published 0077 snapshot and older upgrade SQL remain frozen; the retired table is removed before database initialization completes.

The `0079_drop_announcements` migration removes `announcements` and its records on both fresh installations and existing databases after retirement of the user and admin announcement pages and APIs. It runs after the frozen 0077 snapshot, leaving no announcement table when database initialization completes.

The `0080_drop_redemption_codes` migration removes `redemption_codes` and its records on both fresh installations and existing databases after retirement of the redemption pages and APIs. The published 0075 migration and 0077 snapshot remain frozen. Previously credited user balances, balance grants, and wallet transactions are preserved.

The `0082_unify_membership_identity` migration renames the stored membership identifier to `membership`, updates the old built-in display name, and constrains configuration and user membership keys to that single value. It preserves configured prices and sale status, custom names, user membership periods and status, timestamps, balances and historical wallet records. Both bootstrap and incremental upgrades run it after the frozen snapshots.

The `0081_skill_content_revisions` migration adds immutable `skill_content_revisions`, a same-skill current revision pointer, and `skill_content_imports` for durable legacy import outcomes. Updates to revision rows are rejected by a database trigger. Content insertion and pointer changes commit together. API startup imports legacy files separately from the schema ledger, preserves pending failures for retries, and skips records with a current revision. See [User skill storage](deployment-split.md#user-skill-storage) before moving an existing installation.

The `0083_official_model_pool` migration creates the public pool settings and node membership/circuit tables. It enrolls only the previous platform model, preserving its public alias, prices and credential reference. It does not read or rewrite credential values. Pool membership and health behavior are owned by [Official model pool](official-model-pool.md).

The `0084_official_model_pool_primary` migration designates the existing canonical pool member as primary, or the oldest remaining member when the canonical member is absent. Empty installations remain unconfigured until the first save. The primary pointer references pool membership with `ON DELETE RESTRICT`; child membership remains independently editable and removable. Credentials and public prices are preserved.

The `0085_ai_service_status` migration creates a shared check schedule and aggregate availability observations. The schedule reserves six-hour probe intervals across processes and restarts. Observation rows contain only state, timestamp and latency; no provider configuration or credential values are copied.

The snapshot and all covered migration IDs are committed in one transaction. A failure rolls back the schema and those ledger entries together, allowing a later startup to retry. The empty ledger table may remain after a failed bootstrap.

Databases with recorded migration history always use [versions/](../apps/api/src/infrastructure/migrations/versions/). Each missing migration runs in its own transaction and records its original ID and description. The legacy `0001_core_schema_baseline` already represents historical migrations 0001–0067. Older ledgers may additionally contain historical 0002–0069 IDs; those records remain intact.

Both paths share the existing PostgreSQL advisory lock and 120-second transaction statement and idle budgets. Baseline SQL excludes dump-level session settings so it cannot disable those budgets. The normal API connection and query limits are documented in [Database reliability](database-reliability.md).

The `0086_issues` migration adds public issues, per-issue anonymous participants, timeline entries and account moderation. Private attribution remains linked to existing users; account deletion cascades the account's content. See [Issues](issues.md) for permissions and transaction boundaries.

The `0091_popup_announcements` migration creates a new `popup_announcements`
table for versioned operational notice dialogs. The retired banner table and
its frozen removal migration remain unchanged. See [Popup announcements](announcements.md)
for publication, browser dismissal and concurrent editing behavior.

The `0092_registration_invites` migration adds invitation policy, lifetime user
allowances, hashed single-use codes and completed-refund records. Historical paid
orders qualify for the initial CNY 100 / three-slot allowance. Subsequent recharge
qualification runs within the order transaction using a user-row
`FOR NO KEY UPDATE` lock, compatible with the order's foreign-key `KEY SHARE` lock.
It leaves wallet balances, payment configuration and stored credentials untouched.
See [Registration invitations](registration-invites.md) for redemption atomicity,
refund accounting and deployment behavior. Both fresh and incremental startup
apply this migration after the frozen snapshots.

The `0093_registration_invite_tiers` migration replaces the single invitation
threshold with CNY 30/100/300 cumulative totals of 3/5/10 registrations. It
preserves used invitations and manual allowance adjustments while reconciling
existing paid users. Refunds and policy changes recalculate unused capacity;
excess newer codes are revoked without removing invited accounts. A shared
policy-row lock keeps an account transaction on one version of the rules.
The published 0092 migration remains unchanged. Deploy the API and both clients
together for the new `tiers` policy contract.

## Incremental agent sessions

`0094_pi_session_frames` stores immutable complete checkpoints and appended-message
deltas for admitted AI Chat requests. Frames belong to their chat session, commit
with result delivery and cascade on physical session deletion. The latest frame
index follows admission time. Trace retention does not delete recovery frames.
The API must apply this migration before the new daemon emits frame results;
legacy complete snapshots remain readable. No credential values are migrated.

## Adding an upgrade

`0087_benefit_model_pool` adds pool-scoped membership, a disabled free model pool,
server-side user/session selection, durable personal allowances and provider
quota/attempt ownership. It preserves paid prices, aliases, primary identity,
wallets and existing credential references. It does not read or copy credential
values. Paid and free status schedules/histories become independently scoped.
New default seeds use a fixed migration timestamp so historical replay and fresh
bootstrap converge. Existing sessions retain the paid pool.

`0088_benefit_user_deletion` makes personal model preferences, free daily usage
and free requests cascade on account deletion. Shared model attempts retain their
quota accounting and detach from deleted requests so late usage can still settle.
Indexes support request lookup by user and detaching attempts by request.
The migration applies to both fresh installations and databases already on 0087;
published 0087 SQL remains unchanged.

`0090_benefit_turns_and_concurrency` removes free-only token/call budgets and
shorter deadlines. It preserves each installation's configured daily turns and
concurrency, retains usage and node cooldown records, and makes attempt claims
depend on active request ownership instead of token reservations. Free requests
use the common request deadline. The migration changes no credential values.

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
