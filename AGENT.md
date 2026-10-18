# Agent guide

FateClaw combines a Fastify host, resident agent processes, and two Next.js apps. Start with the task map below; read only the relevant subsystem guide and source. See [local development](docs/development.md) for setup and commands.

## Find the owning code

All paths below are relative to the repository root.

| Task | Start here | Reference |
| --- | --- | --- |
| HTTP routes and authentication | `apps/api/src/interfaces/http/server.ts`, then the relevant `*-routes.ts` | [API guide](apps/api/src/interfaces/http/AGENT.md), [API reference](docs/api-reference.md) |
| Chat turns, history, and session state | `apps/api/src/modules/chat/chat-session-service.ts` | [Runtime architecture](docs/agent-architecture.md) |
| Dispatch, process lifecycle, or missing replies | `apps/api/src/runtime/resident-agent.ts`, `local-runner.ts`, `ipc-worker.ts`, `ipc-ai-chat-outbox-handler.ts`, `ai-chat-stream.ts` (all in the same directory) | [Runtime architecture](docs/agent-architecture.md) |
| Model execution and tools | `apps/agent-runtime/src/daemon.ts`, `request-boundary.ts`, `pi-runtime/` (all under `src/`) | [Runtime architecture](docs/agent-architecture.md) |
| Chart calculation | `apps/api/src/modules/chat/paipan-registry.ts`, `apps/api/src/modules/chat/paipan-runners/` | [API reference](docs/api-reference.md) |
| Knowledge storage and access | `apps/api/src/modules/skills/skills-service.ts`, `apps/agent-runtime/src/skill-content-cache.ts`, `apps/agent-runtime/src/pi-runtime/resource-loader.ts` | [Runtime architecture](docs/agent-architecture.md) |
| Membership and billing | `apps/api/src/modules/billing/` | [Entitlements and billing](docs/membership-entitlement-current.md) |
| User interface | `apps/web/app/`, `apps/web/features/` | [Web guide](apps/web/AGENT.md) |
| Admin interface | `apps/admin/` | [Admin guide](apps/admin/AGENT.md) |
| Shared API types | `packages/contracts/` | [API reference](docs/api-reference.md) |
| Database and migrations | `apps/api/src/infrastructure/db.ts`, `apps/api/src/infrastructure/repositories/`, `apps/api/src/infrastructure/migrations/` | [Database migrations](docs/database-migrations.md) |
| Deployment | `scripts/pack.sh`, `ecosystem.config.cjs` | [Deployment](docs/deployment-split.md) |
| External API or WeChat | Relevant routes in `apps/api/src/interfaces/http/` | [Documentation index](docs/README.md) |

## Boundaries to preserve

- The API owns permissions, persistence, billing, chart calculation, and runtime dispatch. `apps/api/src/app/index.ts` is the full startup entry; `dev-api.ts` skips IPC workers and background startup.
- Redis carries requests and responses between the host and resident processes. Web chat uses runtime IDs of the form `web:{userId}`. `local-runner.ts` selects the source daemon during development and prefers the compiled daemon in production.
- Shared IPC data and session frames belong to `packages/contracts/src/agent/`; capacity scheduling belongs to `runtime/agent-scheduler.ts`.
- Chat submission returns acceptance and a request ID. The final reply is persisted by the AI Chat outbox handler and delivered through the stream; an accepted POST is not proof of completion.
- Model configuration is a request-level `llmRuntime` snapshot. Runtime process environment construction belongs to `apps/api/src/runtime/agent-env.ts`; do not introduce a second model configuration path.
- Chart runners produce structured artifacts in the API. PostgreSQL owns immutable Skill content revisions and access rules; `.fateclaw/text-skills/` contains rebuildable process-owned snapshots. Runtime resources remain scoped to the authorized request.
- WeChat availability is gated by `apps/api/src/modules/billing/entitlements.ts`. Consult the [integration guide](docs/openclaw-integration.md) and current callers before changing that path.

## Validate a change

1. Trace the affected caller, owner, and direct dependents before editing. Confirm behavior in source and tests; older documentation may lag behind implementation.
2. Find focused tests under `apps/<app>/tests/` or `tests/`. The inclusion rules live in `vitest.config.ts`.
3. Run the relevant tests and checks from the [development guide](docs/development.md). A run with no matching tests is not validation.
4. Update the owning topic document when a contract changes. Keep this file as navigation and the root README as a product introduction.
5. Report what was checked and mark runtime behavior not exercised as unverified. Keep credentials and user content out of reports, logs, and diffs.

## Documentation ownership

[docs/README.md](docs/README.md) routes tasks to topic references. Keep detailed explanations in those files rather than copying them into each entry point. [docs/archive/](docs/archive/) contains historical plans and reviews, not current contracts.
