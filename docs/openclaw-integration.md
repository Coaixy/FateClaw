# WeChat OpenClaw/iLink integration

FateClaw retains the integration code for WeChat OpenClaw/iLink Bot. The full backend entry point still contains code to start iLink long polling and IPC listeners for enabled existing accounts with active memberships. However, `WECHAT_CLAW_FEATURE_ENABLED=false` and migration 0057 (`accounts.enabled=false`) both prevent activation, so zero accounts actually start. New QR-code bindings also remain unavailable on the web. This document describes the current state and the boundaries to check before restoring the full flow.

## Current status

- The site's AI Chat is the current stable primary flow.
- `apps/api/src/app/index.ts` initializes the database, system chart-calculation switches, Redis, IPC workers, retention workers, and the Fastify API.
- Full startup reads `getEnabledAccounts()`, calls `startAccountPolling()` only for accounts with an `owner_id` and an active membership, and registers those accounts with `startIpcWorker(memberAccounts)`.
- `activateAccount()` calls `addAccountListener(account.id)` and starts polling for that account, enabling activation immediately after binding.
- The lightweight `pnpm run dev:api-only` entry point starts only the database, Redis, and API server. It skips iLink polling, IPC workers, and runtime activation.
- Web device binding remains unavailable: the frontend displays the `WECHAT_DEVICE_BINDING_DISABLED_MESSAGE` constant (`account-service.ts`), while backend `checkAccountBindingLimit` (`account-http-service.ts`) rejects new binding requests.

The backend therefore retains a WeChat execution flow, but the product has not reopened new bindings. Restoring WeChat access requires coordinating frontend switches, membership and account policies, and the external platform protocol as well as backend polling.

## Related modules

- `apps/api/src/infrastructure/ilink.ts`: OpenClaw/iLink requests, QR-code login, long polling, message delivery, and message conversion.
- `apps/api/src/modules/account/`: Account binding, account HTTP services, and account management.
- `apps/api/src/modules/chat/message-handler.ts`: Processing WeChat messages before they reach the agent.
- `apps/api/src/runtime/poller.ts`: Polling entry point.
- `apps/api/src/runtime/resident-agent.ts`: Dispatching requests to account-level agent-runtime processes.
- `apps/api/src/runtime/ipc-outbox-handler.ts`: Handling agent-runtime responses and sending WeChat messages.
- `apps/web/components/workspace/`: Device and binding UI.

## Checklist before restoring the integration

1. Confirm that the OpenClaw/iLink Bot API base URL, token handling, QR-code login, and message-delivery endpoints still match the protocol in `ilink.ts`.
2. Define the relationship between accounts and users to prevent one WeChat account from being incorrectly bound to multiple users.
3. When reopening new bindings, check the `DevicesPanel` frontend switch, QR-code binding API, `startIpcWorker()`, account listeners and pollers, agent-runtime lifecycle, and graceful shutdown order.
4. Confirm that `dispatchResidentPrompt()`'s `autoDeliver` behavior and outbox handling still meet WeChat automatic-delivery requirements.
5. Add rate limits, error retries, and idempotency handling to prevent duplicate messages or uncontrolled message floods.
6. Check log redaction to avoid recording bot tokens, user WeChat IDs, private messages, or model keys.
7. Update the README, API documentation, and web device-page text to state which parts are available: polling for existing accounts, new bindings, automatic delivery, and failure degradation.

## Environment variables and credentials

OpenClaw/iLink credentials are primarily stored with account configuration and must not be committed. Redact bot tokens, QR-code login results, account exports, and message samples before including them in issues or PRs.

## Operational boundaries

WeChat is an external platform integration, subject to third-party availability, API changes, account risk controls, and message rate limits. In production, monitor WeChat and the site's AI Chat separately so external platform failures are not mistaken for failures in core agent capabilities.
