# Local development

Run commands from the repository root. Script names and package-manager requirements are defined in [package.json](../package.json).

## Prerequisites

- Node.js satisfying both the repository's `>=20` engine declaration and the selected pnpm release's requirements.
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

API startup runs database migrations through `initDatabase()` in [db.ts](../apps/api/src/infrastructure/db.ts). Use a development database: startup can change its schema and data.

## First AI request

1. Open the admin site and authenticate with the configured `MANAGER_KEY`.
2. Configure a model provider, protocol, base URL, model, and API key in system settings.
3. Use the user site's model settings to select an official model or configure a personal provider.
4. Confirm the user's [membership and billing requirements](membership-entitlement-current.md), then send a message in AI Chat.

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

## Verify a local run

- `GET /api/health` checks that HTTP is serving; `GET /api/ready` checks database and Redis connectivity.
- For AI Chat, verify that a final assistant message is persisted and displayed. An HTTP acceptance response alone does not establish success.
- For code changes, run focused tests and relevant type, lint, or build checks. For documentation changes, check links, source paths, and script names.

These instructions were checked against repository scripts and startup source. A live local startup and provider-backed request were not exercised for this documentation update (unverified).

For production packaging and deployment, use the [deployment guide](deployment-split.md).
