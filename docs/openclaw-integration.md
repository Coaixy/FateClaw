# WeChat OpenClaw/iLink integration

FateClaw retains the WeChat OpenClaw/iLink Bot integration. The owner administrator controls availability through `wechat_claw_enabled` on `/system/runtime`; it defaults to false. Active membership and an enabled, owned account are also required. See [Runtime configuration](runtime-configuration.md).

## Startup and live changes

The full backend entry initializes IPC, then starts `runtime/wechat-runtime.ts`. It reconciles the administrator switch and account membership every ten seconds. Eligible accounts receive a pinned IPC listener and an iLink polling loop. Disabling access or losing membership stops those listeners and pollers without deleting account credentials or conversation history.

Binding HTTP requests start polling in the background and return without waiting for the long polling loop to finish. Newly created CLI accounts remain disabled until an authorized binding enables them. Existing disabled accounts are not automatically enabled by the global switch.

The API-only development entry skips polling and background workers. It cannot establish that a configured integration is polling successfully.

## Binding and conversation APIs

The retained authenticated `/api/account` routes provide QR-code creation/status, binding, account reads and deletion. Binding requires current WeChat availability and active membership. The current web app has no `/devices` page or `DevicesPanel`; enabling the backend switch does not create that frontend flow.

WeChat messages use `runWechatChatSessionTurn()` and the same owned chat-session turn pipeline as the web interface. The integration supports selecting, resuming, creating and detaching sessions through its existing chat commands. The obsolete generic inbox submission API is not part of this path.

## Owning modules

- `apps/api/src/runtime/wechat-runtime.ts`: account activation, reconciliation and shutdown.
- `apps/api/src/modules/billing/entitlements.ts`: administrator availability plus membership capabilities.
- `apps/api/src/modules/account/account-http-service.ts`: owned account access and binding.
- `apps/api/src/infrastructure/ilink.ts`: QR login, long polling and message transport.
- `apps/api/src/runtime/poller.ts`: per-account polling and bounded message execution.
- `apps/api/src/modules/chat/message-handler.ts` and `wechat-chat-session-service.ts`: message handling and unified session turns.

## External verification

The administrator switch does not verify iLink protocol availability or authenticate an external account. Before advertising the integration as operational, verify the QR login, account credentials, external endpoint behavior and message delivery against the deployed platform. Monitor WeChat separately from web AI Chat.

Credentials stay in their existing account source. Do not include bot tokens, QR login results, account exports, WeChat identifiers or private messages in reports, issues or repository files.
