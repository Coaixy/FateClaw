# Database concurrency and connection budgets

The API keeps a maximum of 10 PostgreSQL connections. Each account runtime keeps a maximum of 2. With one API and four account runtimes, the application pool ceiling is 18 connections, excluding operator tools and other services. Pools create connections on demand and release idle connections after 30 seconds. Scaling the process count must account for this aggregate ceiling.

Connection acquisition waits at most 5 seconds. Ordinary SQL statements have a server-side 30-second timeout; an idle transaction is terminated after 15 seconds. Client-side query timeouts also bound waits when the database cannot communicate: 35 seconds in the agent runtime and 125 seconds in the API. API startup migrations temporarily use a 120-second statement and idle-transaction budget inside each migration transaction. Commit or rollback restores the ordinary session limits.

Idle connection failures are handled without logging connection strings or raw error details. PostgreSQL's pool removes the failed idle client; the next operation can acquire a replacement. An active query failure still propagates to its caller.

## Soul writes

`read_soul` still returns the SHA-256 of the effective Soul and `edit_soul` still accepts `baseHash`. The tool's initial read provides early validation, but it is not the concurrency boundary. The database update opens a serializable transaction, locks the canonical and any legacy fallback rows that supply the effective content, validates the hash, and writes the canonical destination before committing.

For `web:{userId}`, a nonblank user Soul takes precedence over the first account ordered by enabled status and creation time. Writes still target the user. For a non-web account, a nonblank owner Soul takes precedence over the account Soul; writes target the owner when present, otherwise the historical account. Clearing and whitespace normalization retain the existing behavior.

A stale hash, PostgreSQL serialization conflict, deadlock, or missing destination does not report success. The caller must read the current Soul again before editing. There is no automatic retry with a stale hash. Unexpected database failures propagate; if rollback fails, the connection is discarded. Dashboard updates continue using the same rows and therefore participate in the row-lock boundary without requiring a new schema or version column.

## Validation boundary

Unit tests cover a change between tool preflight and persistence, stale hashes, web legacy fallback, ownerless account fallback, missing targets, serialization/deadlock conflicts, and rollback failure. The opt-in `soul-postgres.integration.test.ts` additionally verifies real PostgreSQL concurrent edits, a Dashboard row-lock race, fallback migration, pool exhaustion, and statement cancellation. It passed against disposable PostgreSQL 17. The separate `agent-requests-postgres.integration.test.ts` verifies admission atomicity, recovery leasing, duplicate delivery, and rollback with real SQL. Enable them only with disposable databases through `FATECLAW_TEST_DATABASE_URL` and `FATECLAW_TEST_DURABLE_DATABASE_URL`, respectively; the suites create and drop their own tables. Production latency and capacity improvements remain unverified.

## Billing recovery

Actual model consumption remains chargeable independently of user-message delivery. If delivery rolls back before a conversation log is committed, the billing sweeper can settle from a non-synthetic durable `result_ready` or `completed` result with known token usage. Unknown, interrupted, and synthetic results remain pending; they are excluded before the stale reservation batch limit so they cannot starve known results. The ordinary idempotent settlement boundary and historical handling of legacy requests remain unchanged.
