# Local development

Run commands from the repository root. Script names and package-manager requirements are defined in [package.json](../package.json).

## Prerequisites

- Node.js 24, matching `.nvmrc` and the repository's `>=24 <25` engine declaration.
- The package-manager version pinned in `package.json` (currently pnpm 11.5.0).
- PostgreSQL and Redis, either provided locally or through Docker Compose.
- A model provider account for AI interpretation. Deterministic chart calculation does not require one.

## Setup

Install dependencies and start the local infrastructure:

```bash
pnpm install
docker compose up -d
```

[docker-compose.yml](../docker-compose.yml) starts only PostgreSQL and Redis, on ports 5432 and 6379. It creates the `fateclaw` database and persists data in named volumes.

For a new checkout without an existing `.env`, create a local configuration from `.env.example`. Keep existing configuration when revisiting a checkout. Set these fields locally:

| Field | Purpose |
| --- | --- |
| `DATABASE_URL` | Connection to the development PostgreSQL database |
| `REDIS_URL` | Connection to the development Redis instance |
| `JWT_SECRET` | Strong random signing secret, at least 32 characters |
| `MANAGER_KEY` | Strong random full-access admin key, at least 32 characters |
| `USER_MANAGER_KEY` | Optional restricted admin key for user and message management |
| `ALLOWED_ORIGINS` | Include `http://localhost:3001,http://localhost:3002` for local browser access |

Configuration validation is owned by [config.ts](../apps/api/src/infrastructure/config.ts). Keep credentials local and out of commits or diagnostic output.

Start all three apps:

```bash
pnpm run dev
```

| App | Default address |
| --- | --- |
| API | http://localhost:3000 |
| User site | http://localhost:3001 |
| Admin site | http://localhost:3002 |

API startup runs database migrations through `initDatabase()` in [db.ts](../apps/api/src/infrastructure/db.ts). Verified empty databases use the latest baseline; existing databases apply only missing migration IDs. See [Database migrations](database-migrations.md) for the initialization and upgrade contract. Use a development database: startup can change its schema and data.

## First AI request

1. Open the admin site and authenticate with the configured `MANAGER_KEY`.
2. Configure the official model pool in admin system settings: common public prices and thinking level, then one retained primary node and optional child nodes with their own protocol, endpoint, key and routing weight.
3. Optionally configure `/system/benefit-models` independently: free nodes, daily personal turns and execution concurrency. It starts disabled. Other execution rules are shared with paid models. See [Free model service](benefit-model-pool.md).
4. Check the user site's model status. Users can select paid or free service in the existing composer; they cannot enter personal providers.
5. Confirm the user's [membership and billing requirements](membership-entitlement-current.md). Free models require active membership; their daily turns and concurrency remain configurable. Then send a message in AI Chat.

Registration and password recovery use SMS verification; configure that integration if those flows are needed. See the authentication endpoints in the [API reference](api-reference.md).

The host resolves model settings into a request-level `llmRuntime` snapshot. Do not configure a separate global model key for the agent process.

## Commands

| Command | Purpose |
| --- | --- |
| `pnpm run dev` | Full API, user site, and admin site |
| `pnpm run dev:api` | Full API only |
| `pnpm run dev:www` | User site only |
| `pnpm run dev:admin` | Admin site only |
| `pnpm run dev:light` | Lightweight API plus both sites |
| `pnpm run dev:api-only` | Lightweight API only |
| `pnpm test <test-file>` | Focused Vitest run; builds shared contracts first |
| `pnpm test` | Full Vitest suite |
| `pnpm run typecheck` | Workspace type checks |
| `pnpm run lint` | API lint checks |
| `pnpm run build:all` | Build shared contracts, API, runtime, and both sites |

The lightweight entry initializes the database, Redis, and HTTP server but skips IPC worker and background startup. Use full development mode to validate the complete AI Chat lifecycle.

## Dependency security

Use the pinned pnpm version to update dependencies and commit `pnpm-lock.yaml`
together with the package manifests and workspace overrides. Check both
`pnpm audit` and `pnpm audit --prod`; the latter excludes development tools.

The Next.js lint dependency chain currently uses `braces@3.0.3`, which has no
published upstream fix for
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm).
The exact-version patch in `patches/braces@3.0.3.patch` limits the recursive
compile, expand, and stringify walkers to 128 AST levels. Its regression tests
also exercise ordinary Next.js lint globs. pnpm applies this patch through
`patchedDependencies`; keep the patch file with the workspace configuration in
source and runtime archives. Replace it with an upstream release once that
release passes the same regression tests.

`pnpm audit` still reports this advisory because the patched package retains
its upstream version. Review that result alongside the patch and its tests.

## Backend imports

Backend package aliases are defined by each app's `package.json` `imports` field. In the API, use the source directory prefix for imports across directories, such as `#modules/chat/chat-session-service`, `#infrastructure/db`, or `#shared/types`. In Agent Runtime, use `#agent/` followed by the path relative to `src`, such as `#agent/types` or `#agent/pi-runtime/tools/skill-path`. Alias specifiers omit the file extension. Keep relative imports for files in the same directory, and use the existing `@fateclaw/contracts` exports for shared contracts.

The `development` condition resolves these aliases to TypeScript source; the default resolves to compiled JavaScript in `dist`. The backend TypeScript configurations and Vitest use the development condition. API development and CLI scripts, as well as the host's source daemon launcher, pass `--conditions=development` to `tsx`. When running a source file directly, pass the same flag, for example:

```bash
pnpm --filter @fateclaw/api exec tsx --conditions=development src/app/cli.ts list
```

Compiled entry points run with ordinary Node.js and require the app's `package.json` alongside `dist`. The backend runtime package includes both.

## Verify a local run

- `GET /api/health` checks that HTTP is serving; `GET /api/ready` checks database and Redis connectivity.
- For AI Chat, verify that a final assistant message is persisted and displayed. An HTTP acceptance response alone does not establish success.
- For code changes, run focused tests and relevant type, lint, or build checks. For documentation changes, check links, source paths, and script names.

These instructions were checked against repository scripts and startup source. A live local startup and provider-backed request were not exercised for this documentation update (unverified).

For production packaging and deployment, use the [deployment guide](deployment-split.md).

The public `/status` page reads shared AI availability observations. Full API startup runs lightweight probes every six hours; API-only mode only serves existing results. See [Public service status](service-status.md) for the probe budget and stale-state behavior.
