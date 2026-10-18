# API module

This is the Fastify API in the host process, not a standalone service. It shares a Node process with account runtime management, database access, and logging.

## Where to start

Read these files first:

1. `apps/api/src/interfaces/http/server.ts`
2. `apps/api/src/interfaces/http/auth-routes.ts`
3. `apps/api/src/interfaces/http/account-routes.ts`
4. `apps/api/src/interfaces/http/messages-routes.ts`
5. `apps/api/src/interfaces/http/skills-routes.ts`
6. `apps/api/src/infrastructure/db.ts`

## Structure

```text
apps/api/src/interfaces/http/
├── server.ts       # Fastify setup, plugins, global hooks, error handling, static-site hosting
├── captcha.ts      # Captcha support
├── rate-limit.ts   # Rate-limit helpers
├── account-routes.ts
├── admin-routes.ts
├── auth-routes.ts
├── billing-routes.ts
├── chat-sessions-routes.ts
├── model-settings-routes.ts
├── messages-routes.ts
├── paipan-routes.ts
└── skills-routes.ts
```

Supporting business modules:

- `apps/api/src/modules/user/auth-service.ts`: Registration, login, and user DTOs safe to expose.
- `apps/api/src/modules/account/account-http-service.ts`: Account binding, runtime start/stop, and Soul reads/writes.
- `apps/api/src/modules/chat/web-chat-service.ts`: Sending and receiving web chat messages.
- `apps/api/src/modules/chat/chat-session-service.ts`: AI chat sessions and execution details.
- `apps/api/src/modules/chat/paipan-service.ts`: Direct chart previews and submission to AI Chat.
- `apps/api/src/modules/billing/billing-service.ts`: Billing snapshots and user resets.
- `apps/api/src/modules/skills/skills-service.ts`: Skill-domain facade.
- `apps/api/src/modules/admin/admin-service.ts`: Admin aggregation logic.
- `apps/api/src/infrastructure/db.ts`: Underlying data-access layer.

## Current route registration

`apps/api/src/interfaces/http/server.ts` currently registers these prefixes:

- `/api/admin`
- `/api/auth`
- `/api/account`
- `/api/chat-sessions`
- `/api/client-profiles`
- `/api/messages`
- `/api/model-settings`
- `/api/paipan`
- `/api/skills`
- `/api/issues` (see [Issues](../../../../../docs/issues.md))
- `/api/billing`
- `/api/api-keys`
- `/api/open-sessions`
- `/api/v1` (Open API)

When adding routes, reuse existing prefix groups rather than introducing inconsistent prefixes.

## Key behavior

### Authentication

- Uses `@fastify/jwt`.
- `request.requireAuth()` is injected in the `onRequest` hook.
- Most authenticated endpoints explicitly call `request.requireAuth()` inside the route.
- Admin access generally uses the `MANAGER_KEY` system, separate from regular-user JWT authentication.
- Open API `/api/v1` uses `api-key-auth.ts` for key validation, rate limits and the arrears gate. Active membership is required to create a key, not to keep using an existing valid key.

### Error handling

- `server.ts` centrally configures `setErrorHandler`.
- 4xx errors are logged at warn level; 5xx errors at error level.
- API errors return JSON, not HTML.

### Static frontend hosting

- If `apps/web/out/` exists, Fastify serves the static export directly.
- Missing `/api/*` routes return a JSON 404.
- Non-API page requests first try `{path}/index.html` and `{path}.html`.
- `{path}.txt` requests from App Router client navigation are also mapped to the actual `route/index.txt`.
- Missing static assets return 404 rather than incorrectly falling back to the home page.

The API layer therefore also hosts the production frontend site.

### Asynchronous AI Chat flow

The site's AI Chat send endpoint does not return the final reply synchronously:

- For `POST /api/chat-sessions/s/:sessionId/messages`, `chat-session-service.ts` saves the user message, acquires the session lock, resolves `llmRuntime`, and queues the request.
- A normal response usually contains `accepted: true` and `request_id`. `runtime/ipc-ai-chat-outbox-handler.ts` asynchronously persists the final assistant message from `ipc:{runtimeId}:ai-chat:outbox`.
- Live frontend output uses `runtime/ai-chat-stream.ts`: first `POST /api/chat-sessions/s/:sessionId/stream-ticket`, then connect to the `/api/chat-sessions/s/:sessionId/stream` WebSocket.
- Cancellation releases pending state, the session lock, the global concurrency slot, and the local agent lease, and writes a cancellation request to `ipc:{runtimeId}:cancel`.

### Chart calculation and simple mode

- `/api/paipan/*` performs deterministic chart calculation with TypeScript runners inside the API and does not require a model runtime.
- Simple mode no longer has a separate `/api/simple-workflows` route. It uses the AI Chat turn flow through `prepareOwnedChatSessionTurn` and shares the wallet arrears gate with ordinary chat.

### Health probes

- `/api/health` reports process liveness only.
- `/api/ready` checks PostgreSQL and Redis and can serve as a deployment readiness probe.

## Relationship to the database

Keep the route layer thin and place business orchestration in `apps/api/src/modules/*` services. To understand endpoint behavior, read more than the route handler. At minimum, also check:

- Orchestration in the corresponding module service.
- Table creation and migrations.
- Queried fields.
- Ownership checks.
- Feature switches and state fields.

## Change conventions

- Reuse existing prefixes for new endpoints.
- Preserve the current style of Chinese error messages in response structures where possible.
- Bind authorization checks to resource ownership; JWT validation alone is insufficient.
- When changing API routes or parameters, also check `apps/web/features/*/api.ts`, `apps/web/lib/admin-api.ts`, and `docs/api-reference.md`.
- API Vitest test sources are kept in the repository. After API changes, run relevant `*.test.ts` tests first, then `pnpm --filter @fateclaw/api typecheck` and `pnpm --filter @fateclaw/api lint`.
