# FateClaw API Reference

> Base URL: `http://localhost:3000` (configurable through the `API_PORT` environment variable)

> Human-readable names, sample content, and error messages below are translated into English for this reference. Actual server messages and default display labels may be Chinese; field names and machine-readable codes are unchanged.

## Route inventory

The API prefixes currently registered in Fastify:

- `/api/auth`
- `/api/account`
- `/api/chat-sessions`
- `/api/messages`
- `/api/model-settings`
- `/api/paipan`
- `/api/skills`
- `/api/issues`
- `/api/announcements` — public popup notices; owner management under `/api/admin/announcements` ([contract](announcements.md))
- `/api/billing`
- `/api/api-keys`
- `/api/v1`
- `/api/admin`
- `/api/health`
- `/api/ready`

## Execution modes at a glance

The stable primary flows are AI Chat, manual chart calculation, and Text Skill Bundle knowledge libraries. WeChat OpenClaw/iLink is fully and reversibly disabled (`WECHAT_CLAW_FEATURE_ENABLED=false` + migration 0057). `canUseWechatClaw` is always `false`, so QR-code binding, polling, and delivery are unavailable.

- For AI Chat, the API persists the user message, resolves the request-level `llmRuntime`, acquires the session busy lock, and dispatches through Redis IPC to the local agent-runtime for `web:{userId}`.
- `POST /api/chat-sessions/s/:sessionId/messages` usually indicates only that the request was queued. The `ipc:{runtimeId}:ai-chat:outbox` handler asynchronously persists the final assistant message, settles billing, and pushes it through WebSocket.
- Manual chart calculation does not call a model. The API directly runs `paipan-runners/*.ts` and saves the structured chart in the session as `tool_context/artifactData`.
- AI Chat can create charts through the `create_paipan` tool during an admitted
  conversation turn. It discovers enabled chart schemas with `mode=catalog`,
  then calls the same API-owned runners with `mode=create`. The API saves a
  standalone `board_result` message before interpretation continues. The web
  client refreshes saved messages on the stream `message` event; a final reply
  is not required for the chart to remain available. This adds no public HTTP
  endpoint. See [Conversation chart creation](agent-architecture.md#conversation-chart-creation).
- Complete Text Skill Bundles are stored in PostgreSQL alongside their metadata and permissions. `.fateclaw/text-skills` is a rebuildable local cache; agent-runtime restores only request-authorized bundles when needed.

## Authentication

Business endpoints require a JWT in the request header unless explicitly marked public. Public endpoints include graphical captchas, login/registration/password recovery, share previews, chart catalog/preview, public marketplaces, invitation previews, status pages, payment notifications, and health checks.

```
Authorization: Bearer <token>
```

---

## Auth endpoints

Google sign-in is disabled. All interface languages use mainland China phone
authentication. The former `GET /api/auth/google/start`,
`GET /api/auth/google/callback`, and `POST /api/auth/oauth/exchange` endpoints are
no longer registered and return 404. The Web OAuth callback page has also been
removed. Existing users, OAuth identity records, and issued sessions are preserved;
accounts that only used Google cannot start a new session through Google.

Public signup now requires a single-use `inviteCode`. Registration SMS requests
also require it; login and password recovery do not. See
[Registration invitations](registration-invites.md) for allowance, expiry, refund
accounting and owner administration.

The authentication routes also include:

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/auth/captcha` | Get a graphical captcha challenge |
| POST | `/api/auth/me/send-sms-captcha` | Send an SMS verification code for an authenticated user's phone-change or reset flow |
| POST | `/api/auth/change-password` | Change an authenticated user's password |
| POST | `/api/auth/reset-password` | Recover a password without logging in |
| POST | `/api/auth/me/reset-password` | Reset the authenticated user's own password |

### POST /api/auth/register

Register a new user.

**Request Body**

```json
{
  "phoneNumber": "13800138000",
  "password": "test-password123",
  "smsCaptchaCode": "123456",
  "inviteCode": "0123456789ABCDEF01234567"
}
```

| Field | Type | Required | Description |
| -------------- | ------ | ---- | ------------------ |
| phoneNumber | string | Yes | Mainland China phone number |
| password | string | Yes | At least eight characters |
| smsCaptchaCode | string | Yes | SMS verification code |
| inviteCode | string | Yes | Valid single-use registration invitation |

**Response 201**

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "phone": "138****8000",
    "phone_masked": "138****8000",
    "phone_verified": true,
    "role": "consumer",
    "purchased_coins": 0,
    "bonus_coins": 0,
    "reserved_coins": 0,
    "created_at": "2026-03-28T10:00:00.000Z"
  }
}
```

**Error 400**

```json
{ "error": "This phone number is already registered" }
```

---

### POST /api/auth/login

Log in and receive a JWT.

**Request Body**

```json
{
  "phone": "13800138000",
  "password": "123456",
  "captcha_token": "captcha-token",
  "captcha_answer": "A7KD2"
}
```

| Field | Type | Required | Description |
| -------------- | ------ | ---- | ------------------ |
| phone | string | Yes | Mainland China phone number |
| password | string | Yes | Login password |
| captcha_token | string | Yes | Graphical captcha token |
| captcha_answer | string | Yes | Graphical captcha answer |

**Response 200**

```json
{
  "token": "eyJhbGciOi...",
  "user": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "phone": "138****8000",
    "phone_masked": "138****8000",
    "phone_verified": false,
    "role": "consumer",
    "purchased_coins": 100,
    "bonus_coins": 20,
    "reserved_coins": 0,
    "created_at": "2026-03-01T00:00:00.000Z"
  }
}
```

**Error 401**

```json
{ "error": "Incorrect phone number or password" }
```

---

### GET /api/auth/me

Get the current authenticated user's information. Authentication required.

**Response 200**

```json
{
  "id": "550e8400-e29b-41d4-a716-446655440000",
  "phone": "138****8000",
  "phone_masked": "138****8000",
  "phone_verified": false,
  "role": "consumer",
  "purchased_coins": 100,
  "bonus_coins": 20,
  "reserved_coins": 0,
  "created_at": "2026-03-01T00:00:00.000Z"
}
```

---

### POST /api/auth/send-sms-captcha

Send an SMS verification code. Use `type = 1` for registration and `type = 0` for password recovery.

**Request Body**

```json
{
  "type": 1,
  "phoneNumber": "13800138000",
  "captcha_token": "captcha-token",
  "captcha_answer": "A7KD2",
  "inviteCode": "0123456789ABCDEF01234567"
}
```

| Field | Type | Required | Description |
| -------------- | ------ | ---- | ------------------------------------- |
| type | number | Yes | `1` for registration, `0` for password recovery |
| phoneNumber | string | Yes | Mainland China phone number |
| captcha_token | string | Yes | Graphical captcha token |
| captcha_answer | string | Yes | Graphical captcha answer |
| inviteCode     | string | `type=1` | Required for registration; omitted for password recovery |

**Response 200**

```json
{ "success": true }
```

**Error 400**

```json
{ "error": "Only one SMS verification code can be sent every three minutes" }
```

---

## Account management

All account-management endpoints require authentication. WeChat OpenClaw/iLink is fully and reversibly disabled (`WECHAT_CLAW_FEATURE_ENABLED=false` + migration 0057). `canUseWechatClaw` is always `false`, so QR-code binding, status polling, and delivery are unavailable. The endpoints below remain registered, but the disabled feature switch prevents them from taking effect.

### GET /api/account

Get all WeChat accounts bound to the current user. Authentication required.

**Response 200**

```json
[
  {
    "id": "bot_123@im.bot",
    "user_id": "wxid_abc@im.wechat",
    "name": "Lao Zhang",
    "base_url": "https://ilinkai.weixin.qq.com",
    "get_updates_buf": "",
    "enabled": 1,
    "created_at": "2026-03-01T00:00:00.000Z",
    "owner_id": "550e8400-e29b-41d4-a716-446655440000"
  }
]
```

> The `bot_token` field is never returned.

---

### GET /api/account/:id

Get one account's details. Authentication required; users can view only their own bound accounts.

**Path Params**

| Parameter | Description |
| ---- | ----------------- |
| id | Account ID (bot_id) |

**Response 200** — A single object with the same structure as above

**Error 404**

```json
{ "error": "Account not found" }
```

---

### POST /api/account/:id/bind

Bind an existing WeChat account to the current user. Authentication required.

**Path Params**

| Parameter | Description |
| ---- | ----------------- |
| id | Account ID (bot_id) |

**Response 200**

```json
{ "success": true }
```

**Error 403**

```json
{ "error": "This account is already bound to another user" }
```

### Other account endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/account/me/soul` | Read the current user's custom Soul persona |
| PUT | `/api/account/me/soul` | Update the current user's custom Soul persona with `{ "content": "..." }` |
| GET | `/api/account/:id/soul` | Read the specified account's Soul |
| PUT | `/api/account/:id/soul` | Update the specified account's Soul with `{ "content": "..." }` |
| DELETE | `/api/account/:id` | Unbind and delete an account owned by the current user |
| POST | `/api/account/qrcode` | Request an iLink QR code for account binding |
| POST | `/api/account/qrcode/status` | Poll QR-code status with `{ "qrcode": "..." }` |

---

## Message history

### GET /api/messages/:accountId

Get conversation history for an account. Authentication required; users can view only messages from their own accounts.

**Path Params**

| Parameter | Description |
| --------- | ------- |
| accountId | Account ID |

**Query Params**

| Parameter | Type | Default | Description |
| ----- | ------ | ---- | ------------------ |
| limit | number | 50 | Number of messages to return, maximum 200 |
| before | string | - | Timestamp cursor; return messages before this time |

**Response 200**

```json
[
  {
    "id": "msg-1711612800000",
    "account_id": "bot_123@im.bot",
    "sender": "wxid_abc@im.wechat",
    "sender_name": "Xiao Ming",
    "content": "Hello",
    "timestamp": "2026-03-28T10:00:00.000Z",
    "is_from_me": 0,
    "is_bot_message": 0
  }
]
```

**Error 403**

```json
{ "error": "You do not have permission to access this account's messages" }
```

---

## AI Chat sessions

All endpoints below except share previews require authentication and allow access only to the current user's own sessions.

| Method | Path | Description |
| ------ | -------------------------------------------------------------------- | -------------------------- |
| GET | `/api/chat-sessions` | List AI Chat sessions |
| GET | `/api/chat-sessions/archived` | List archived sessions |
| POST | `/api/chat-sessions` | Create a session, optionally passing `{ "title": "..." }` |
| PATCH | `/api/chat-sessions/s/:sessionId` | Update the session title |
| DELETE | `/api/chat-sessions/s/:sessionId` | Archive the session and clean up local Pi session files |
| POST | `/api/chat-sessions/s/:sessionId/restore` | Restore an archived session |
| POST | `/api/chat-sessions/s/:sessionId/share` | Create or reuse a private session-sharing link |
| GET | `/api/chat-sessions/shared/:token` | Read a session through a share token without authentication |
| GET    | `/api/chat-sessions/s/:sessionId/messages`                           | List messages with `limit`, `before`, and optional `before_id` |
| GET    | `/api/chat-sessions/s/:sessionId/boards`                             | List selectable board summaries |
| POST | `/api/chat-sessions/s/:sessionId/messages` | Send a message with `content` and optional `selected_board_message_id` |
| POST | `/api/chat-sessions/s/:sessionId/messages/cancel` | Interrupt the current session's in-progress AI Chat output |
| POST | `/api/chat-sessions/s/:sessionId/stream-ticket` | Issue a single-use WebSocket stream ticket |
| GET | `/api/chat-sessions/s/:sessionId/messages/:messageId/query-process` | Get a redacted execution timeline |

### GET /api/chat-sessions/s/:sessionId/messages

The message response includes `processing` and `processing_request_id`. The request ID is read from the existing session processing lock and is `null` while idle. Clients can correlate it with stream events and persisted message `metadata.request_id` when recovering a turn after a reload.

`limit` defaults to 50 and is capped at 200. Results are ordered by `timestamp DESC, id DESC`. To page into older messages, send the last result's `timestamp` as `before` and its `id` as `before_id`. This compound cursor includes remaining messages sharing the boundary timestamp without repeating the boundary message. Supplying only `before` preserves the existing strict `timestamp < before` behavior; `before_id` alone has no effect. Clients must merge refreshed recent messages with already loaded history.

### GET /api/chat-sessions/s/:sessionId/boards

Returns selectable official and pasted boards from the authenticated owner's session. The newest valid board comes first, matching the default board used by message submission. Duplicate source message IDs are collapsed. Each summary contains `source_message_id`, `skill`, `title` (the artifact title, falling back to the skill), and optional `created_at`; it excludes board text and artifact data.

```json
{
  "boards": [
    {
      "source_message_id": "paipan-res-example",
      "skill": "bazi-paipan",
      "title": "Bazi chart",
      "created_at": "2026-10-17T08:00:00.000Z"
    }
  ]
}
```

Pass a summary's `source_message_id` as `selected_board_message_id` when sending a message. The send endpoint remains responsible for validating that the selected message belongs to the session and contains a board. Omitting it keeps the existing newest-board default. Missing sessions return 404; sessions owned by another user return 403.

### POST /api/chat-sessions/s/:sessionId/messages

Send one AI Chat turn. The server first saves the user message, resolves the model runtime, builds history and active chart context, then asynchronously dispatches to the agent-runtime for `web:{userId}`.

**Request Body**

Regular message:

```json
{
  "content": "What does this chart suggest about my career?",
  "selected_board_message_id": "paipan-res-...",
  "input_kind": "normal"
}
```

User-pasted chart:

```json
{
  "input_kind": "user_pasted_board",
  "pasted_board": {
    "category": "bazi",
    "content": "Chart text pasted by the user",
    "question": "Please interpret my career prospects"
  }
}
```

**Response 200**

Asynchronous mode usually returns:

```json
{
  "text": "",
  "accepted": true,
  "request_id": "aichat-1770000000000-abcdef",
  "session_title": "Bazi chart"
}
```

`accepted: true` means only that the backend accepted the request, not that the final reply exists. The outbox handler writes the final assistant message to the message table. The frontend should connect to WebSocket or poll the message list to refresh results.

### AI Chat WebSocket Stream

WebSocket cannot directly reuse a long-lived JWT. The frontend must first call:

```http
POST /api/chat-sessions/s/:sessionId/stream-ticket
Authorization: Bearer <token>
```

Response:

```json
{
  "ticket": "single-use-ticket",
  "expiresAt": "2026-06-14T10:00:00.000Z"
}
```

Then connect to:

```text
ws://localhost:3000/api/chat-sessions/s/:sessionId/stream?ticket=single-use-ticket
```

The ticket expires after 60 seconds, is single-use, and is bound to the current user and session. Event types include `connected`, `agent_start`, `turn_start`, `thinking_delta`, `assistant_delta`, `tool_start`, `tool_update`, `tool_end`, `progress`, `final`, `error`, and `usage`.

### Session continuation and cancellation

- Only one request can be processing in a session at a time, tracked by Redis key `session:processing:{sessionId}`.
- `POST /api/chat-sessions/s/:sessionId/messages/cancel` releases pending state, concurrency slots, and the local agent lease, and writes a cancellation request to `ipc:{runtimeId}:cancel`.
- If a session has been inactive for a long time and its local Pi session file is missing, the message list returns `continuation_blocked`. The frontend should prevent follow-up messages and ask the user to start a new conversation.

---

## Direct chart calculation

Direct chart endpoints call internal TypeScript runners in the API process and return structured `skillContext`. Preview requests neither write to a session nor require a model `llmRuntime`.

| Method | Path | Description |
| ---- | --------------------- | -------------------------------------------------- |
| GET | `/api/paipan/catalog` | Public endpoint listing system chart types available for direct calculation |
| POST | `/api/paipan/preview` | Public endpoint; pass `skill` and `input` to preview without writing to a session. A valid JWT supplies user context |
| POST | `/api/paipan/commit` | Authentication required; submit previewed or newly calculated results to AI Chat |

`commit.target` supports `new_session_from_preview` and `current_session`. Pass `sessionId` when submitting to the current session. You can also pass `skill` + `input` for the server to calculate and save a chart immediately.

The built-in system chart catalog is maintained in `apps/api/src/modules/chat/paipan-registry.ts`. Common `skill` values include:

- `bazi-paipan`: Bazi chart calculation
- `ziwei-paipan`: Ziwei Doushu chart calculation
- `qimen-paipan`: Qimen Dunjia chart calculation
- `iching-paipan`: Liuyao Najia chart calculation
- `jingzhan-paipan`: Zhouyi Jingzhan chart calculation
- `meihua-paipan`: Meihua Yishu chart calculation
- `liuren-paipan`: Da Liu Ren chart calculation

The `skillContextEntry` in a `preview` response contains:

```json
{
  "previewId": "uuid",
  "skillContextEntry": {
    "skill": "bazi-paipan",
    "output": "Formatted chart summary",
    "artifactType": "skill.bazi-paipan",
    "artifactTitle": "Bazi chart",
    "artifactData": {}
  },
  "expiresAt": "2026-06-14T10:30:00.000Z"
}
```

`artifactData` contains structured chart data. After submission, it is saved in message `tool_context`; later AI Chat turns use it as chart context instead of recalculating the chart.

---

## Public service status

`GET /api/service-status` is public and reads saved AI availability observations.
It never triggers an inference. The response contains `status` (`operational`,
`unavailable` or `unknown`), `checked_at`, `latency_ms`, `check_interval_seconds`
(21600), `stale_after_seconds` (43200), and up to 28 history samples with only
`checked_at`, `status` and `latency_ms`. Node identities, counts, connection details
and provider errors are not returned. Responses permit public caching for 60 seconds.
`token_usage` adds the platform's recorded `total_tokens`, UTC `today_tokens`,
snapshot `updated_at` and seven ascending `daily` points (`date`, `tokens`),
including days with no usage. These are aggregate counts without account details.

The full API startup performs a shared lightweight check every six hours, stopping
at the first available node. Results older than twelve hours become unknown. See
[Public service status](service-status.md) for probe budgets and metric boundaries.

## Issues

Public feedback uses `/api/issues`; authenticated users create and edit their own content. Owner administrators manage `/api/admin/issues`. See [Issues](issues.md) for endpoints, anonymous identity boundaries, moderation and rate limits.

## Model Settings

Users choose between the platform-managed paid and free pools. Supplier connections and credentials remain administrator-owned. Each pool may contain multiple models/providers; users select a service rather than a provider node.

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/model-settings` | Authenticated paid `model`, `benefit` availability/allowance/reset time and `preferred_pool` |
| PUT | `/api/model-settings/preference` | Save `{ "pool_key": "official" | "benefit", "session_id"?: "..." }`; optional session must belong to the caller and have no active turn |

The paid `model` remains nullable and keeps its existing public alias. Displayed input/output prices include the current account's non-member multiplier when applicable. `benefit` includes `model`, `enabled`, `eligible`, `supply`, `daily_turns`, `remaining_turns`, and `resets_at`. `eligible` indicates active membership, independently of pool availability; ineligible users receive `remaining_turns: null`. New free requests require active membership at durable admission and return HTTP 403 otherwise. Expiry does not interrupt accepted requests or recovery. Daily turns and concurrency keep their configured values. Connection details and credential values are omitted. Preferences are server-owned; session choices apply to future turns, and exhaustion never changes a request into paid execution. Legacy custom-provider selection endpoints remain removed. See [Free model service](benefit-model-pool.md).

## Skill marketplace and creators

`/api/skills` currently handles only user Text Skill Bundles, Bundle collections, the marketplace, and authorization invitations. It does not maintain the system chart catalog. Regular users use `/api/paipan/catalog`; admin global switches are at `/api/admin/skills/global`.

Complete Skill files are stored as immutable revisions in `skill_content_revisions`. `user_custom_skills.current_revision_id` selects the current revision; shares and subscriptions still reference the stable skill ID. Revision content includes `format_version`, checksum, files, and content length. The existing display `version` is independent of revision identity and format version. New `bundle_uri` values identify the revision without a deployment-specific filesystem path.

Every author update requires `base_revision_id` (a revision ID, or `null` for a legacy record). Missing preconditions return HTTP 428; a stale base returns HTTP 409 with `code: skill_revision_conflict`. Metadata changes, a new immutable revision, and the current pointer commit in one transaction. Failed saves leave the previous revision and metadata intact. The editor retains unsaved text on conflict. `GET /api/skills/user` returns metadata summaries without `files`; the detail endpoint supplies full content for editing and export.

Agent-runtime authorizes the catalog per request, fixes its selected revision, and retrieves that revision even after a newer one becomes current. The shared server-only `@fateclaw/contracts/skills/content` protocol owns normalization, format validation, and checksums. The Pi adapter accepts the currently supported Markdown text format; unknown formats fail explicitly. Cached files are never uploaded to the canonical database.

Local snapshots are rebuilt under `.fateclaw/text-skills/cache-v1/` (or `FATECLAW_TEXT_SKILLS_DIR`). Each runtime owns a separate process namespace and pins snapshots for active requests. Cleanup evicts inactive snapshots above 64 MiB per runtime or after seven idle days, and reclaims namespaces of exited processes on subsequent cache activity. Active requests may temporarily exceed the cache budget. Cache maintenance failures are logged; required revision reads and checksum failures fail the request.

API startup separately imports legacy records with no current revision. `skill_content_imports` records `pending`, `missing`, `mismatched`, `invalid`, or `complete` with a bounded error code. Missing or mismatched files remain retryable; completed records leave the import path. Complete original files must be available on the old deployment before it is retired. Completely empty databases require an explicit mapping for orphan file ownership and skill IDs. See [Skill content architecture](skill-content-architecture.md) and [deployment](deployment-split.md#user-skill-storage).

### User-created Skills

- `GET /api/skills/user`: List owned and subscribed Skills
- `POST /api/skills/user`: Create a Markdown Skill Bundle
- `GET /api/skills/user/:id`: View details
- `PUT /api/skills/user/:id`: Update a Markdown Skill Bundle
- `DELETE /api/skills/user/:id`: Soft-delete
- `PATCH /api/skills/user/:id/toggle`: Enable or disable
- `GET /api/skills/limits`: Read effective Skill Bundle file limits; no authentication required
- `POST /api/skills/user/:id/share` / `DELETE /api/skills/user/:id/share`: Enable or disable private sharing
- `POST /api/skills/user/:id/publish` / `DELETE /api/skills/user/:id/publish`: Publish or unpublish a public listing
- `GET /api/skills/shared/:token`: Preview a shared Skill without authentication
- `POST /api/skills/subscribe/:token`: Subscribe to a shared Skill
- `PATCH /api/skills/subscribe/:id/toggle`: Enable or disable a subscription
- `DELETE /api/skills/subscribe/:id`: Unsubscribe

`POST /api/skills/user` request body:

```json
{
  "skill_name": "Liuyao wealth assessment",
  "dir_name": "liuyao-money",
  "files": [
    {
      "path": "SKILL.md",
      "content": "---\nname: \"Liuyao wealth assessment\"\ndescription: \"Entry point for Liuyao wealth questions\"\n---\n\n# Liuyao wealth assessment\n\n## Recommended reading order\n\n- `index.md`\n- `docs/knowledge.md`\n"
    },
    {
      "path": "index.md",
      "content": "# File index\n\n- `docs/knowledge.md`: Main knowledge content\n"
    },
    {
      "path": "docs/knowledge.md",
      "content": "# Knowledge content\n\n## Applicable scenarios\n\n- Wealth, partnerships, and project payments.\n"
    }
  ]
}
```

`PUT /api/skills/user/:id` request body:

```json
{
  "skill_name": "Liuyao wealth assessment",
  "files": [
    { "path": "SKILL.md", "content": "---\nname: \"Liuyao wealth assessment\"\ndescription: \"Updated description\"\n---\n\n# Liuyao wealth assessment\n" },
    { "path": "index.md", "content": "# File index\n" },
    { "path": "docs/knowledge.md", "content": "# Knowledge content\n" }
  ]
}
```

`GET /api/skills/limits` response:

```json
{
  "max_files": 50,
  "max_file_chars": 100000,
  "max_total_chars": 500000,
  "max_zip_bytes": 8388608
}
```

`files` may contain only text files at safe relative paths and must include `SKILL.md`. Admin system configuration controls file count, characters per file, total characters, and ZIP import size limits. Response `skill_name` and `description` are synchronized from `SKILL.md` frontmatter.

### Bundles and the marketplace

- `POST /api/skills/bundles` / `GET /api/skills/bundles`: Create and list owned Bundles
- `PUT /api/skills/bundles/:id` / `DELETE /api/skills/bundles/:id`: Update or soft-delete a Bundle
- `POST /api/skills/bundles/:id/share` / `DELETE /api/skills/bundles/:id/share`: Enable or disable Bundle sharing
- `POST /api/skills/bundles/:id/publish` / `DELETE /api/skills/bundles/:id/publish`: Publish or unpublish a public listing
- `GET /api/skills/bundles/shared/:token`: Preview a shared Bundle without authentication
- `POST /api/skills/bundles/subscribe/:token`: Subscribe to all Skills in a Bundle
- `DELETE /api/skills/bundles/subscriptions/:bundleId`: Unsubscribe from a Bundle
- `GET /api/skills/market`: Public Skill marketplace
- `GET /api/skills/bundles/market`: Public Bundle marketplace
- `GET /api/skills/subscriptions/mine`: My subscriptions

---

## Registration invitations

These routes replace the retired referral documentation. They gate new account
creation and do not issue referral commissions. Anonymous preview uses a POST body
so invitation codes do not enter API URLs. All responses use `Cache-Control: no-store`.

| Method | Path | Description |
| --- | --- | --- |
| POST | `/api/auth/invites/preview` | Validate `{ inviteCode }` without consuming the code |
| GET | `/api/auth/invites/me` | Authenticated user's qualification, allowance and recent codes |
| POST | `/api/auth/invites` | Reserve a slot using `{ request_key }`; return the code once |
| POST | `/api/auth/invites/:id/revoke` | Revoke an owned unused code and release its reservation |

Owner-only policy, allowance, operational code and completed-refund administration
is under `/api/admin/registration-invites`. See the complete
[invitation contract](registration-invites.md#http-contract).

---

## Wallet and token billing

### GET /api/billing

Get the current user's wallet balance and monthly token billing overview. Authentication required.

**Response 200**

```json
{
  "monthly_tokens_used": 905000,
  "monthly_charged_coins": 12.5,
  "purchased_coins": 100,
  "bonus_coins": 20,
  "reserved_coins": 0,
  "available_coins": 120,
  "membership": {
    "enabled": true,
    "active": false,
    "plan_key": null,
    "monthly_price_coins": 30,
    "display_price_coins": 30,
    "current_period_start": null,
    "current_period_end": null
  },
  "membership_entitlements": [
    {
      "plan_key": "membership",
      "name": "Diviner Access",
      "effective_start": "2026-06-10T00:00:00.000Z",
      "effective_end": "2026-07-10T00:00:00.000Z",
      "is_current": true
    }
  ],
  "membership_plans": []
}
```

**Membership entitlement timeline**

`membership.active` is the effective membership state. `membership_entitlements` contains the single stored period when its status is active and its end is in the future; `is_current` identifies whether that period has started. Renewals extend the same membership row. All membership identifiers are `membership`, and configured names take precedence over the default display name, which means Diviner Access.

---

### GET /api/billing/usage

Get the current user's cumulative and daily message counts, input tokens, output tokens, and total tokens. Authentication required.

**Response 200**

```json
{
  "total_messages": 126,
  "total_input_tokens": 620000,
  "total_output_tokens": 285000,
  "total_tokens": 905000,
  "today_messages": 8,
  "today_input_tokens": 24000,
  "today_output_tokens": 6200,
  "today_total_tokens": 30200
}
```

---

### GET /api/billing/usage/daily

Get the current user's daily aggregated token usage. Authentication required.

**Response 200**

```json
[
  {
    "date": "2026-05-06",
    "msg_count": 12,
    "input_tokens": 24000,
    "output_tokens": 6200,
    "total_tokens": 30200,
    "official_model_charge_coins": 0.36
  }
]
```

---

### GET /api/billing/status

Get site-wide daily statistics shown on the status page. No authentication required.

**Response 200**

```json
{
  "today_messages": 126,
  "registered_users": 42,
  "today_total_tokens": 905000,
  "processing_sessions": 3,
  "token_usage_series": [
    {
      "date": "2026-05-30",
      "input_tokens": 620000,
      "output_tokens": 285000,
      "total_tokens": 905000
    }
  ]
}
```

### POST /api/billing/recharge/orders

Create a recharge order and return the Epay checkout URL. Authentication required.

**Request Body**

```json
{
  "amount_coins": "50.00",
  "pay_type": "alipay"
}
```

**Response 200**

```json
{
  "pay_url": "https://pay.example.com/...",
  "order": {
    "id": "order-uuid",
    "user_id": "550e8400-e29b-41d4-a716-446655440000",
    "trade_id": "rc1770000000000123456",
    "provider": "epay",
    "provider_trade_id": null,
    "pay_type": "alipay",
    "amount_coins": 50,
    "pay_url": "https://pay.example.com/...",
    "status": "pending",
    "paid_at": null,
    "notified_at": null,
    "created_at": "2026-04-27T10:00:00.000Z",
    "updated_at": "2026-04-27T10:00:00.000Z"
  }
}
```

---

### GET /api/billing/recharge/orders

Get the current user's recent recharge orders. Authentication required.

---

### GET /api/billing/recharge/stats

Get the current user's recharge statistics. Authentication required.

**Response 200**

```json
{
  "total_paid_orders": 3,
  "total_recharge_coins": 150,
  "last_paid_at": "2026-04-27T10:00:00.000Z"
}
```

---

### POST /api/billing/recharge/orders/:tradeId/sync

Actively query Epay after payment and reconcile the wallet credit. Authentication required.

---

### GET/POST /api/billing/recharge/notify

Epay asynchronous notification endpoint. No login required. After verifying the signature and matching the amount, credit the wallet idempotently and return plain text `success`.

The recharge switch, amount range, Epay gateway, merchant ID, and key are stored in database table
`recharge_payment_config`. The server generates the asynchronous notification and post-payment return URLs from
`PUBLIC_API_BASE_URL` / `PUBLIC_WEB_BASE_URL`, the compatibility variable `PUBLIC_BASE_URL`,
or the current request domain, and passes them to Epay when placing the order. For three-site deployments, `notify_url`
must point to the API site and `return_url` to the www site.

---

### GET /api/billing/transactions

Get the current user's recent wallet transactions. Authentication required.

---

### GET /api/billing/daily-sign-in

Get the current user's daily check-in status. Authentication required.

---

### POST /api/billing/daily-sign-in

Claim the daily check-in reward in RMB credits. Authentication required.

---

### POST /api/billing/membership/subscribe

Requires authentication. Opens or renews the single membership using the wallet balance. Optional `plan_key` accepts only `membership`; omission selects the same membership. Unsupported identifiers return HTTP 400. Active memberships retain their period anchor and extend the end date by one month.

---

### POST /api/billing/reset

Soft-reset the current user's data by scope. Authentication required. `scope` supports `all`, `messages`, `memories`, and `tasks`, defaulting to `all`.

---

## API keys and Open API

For users making programmatic calls with API keys: `/api/api-keys` is the internal management surface (JWT authentication) where users create, list, and revoke their keys. `/api/v1` is the external calling surface (API-key authentication, OpenAI-compatible requests, responses, and errors). Creating a key requires active membership; existing keys remain usable after membership expiry, subject to the arrears gate. See [Open API](open-api.md) for authentication, endpoints, billing, and session retention.

| Prefix | Authentication | Description |
| --- | --- | --- |
| `/api/api-keys` | JWT | Internal API-key management: create, list, and revoke the current user's keys |
| `/api/v1` | API Key | External Open API: OpenAI-compatible entry point for key holders to call chart and Agent capabilities programmatically |

---

## Health checks

### GET /api/health

No authentication required.

**Response 200**

```json
{ "status": "ok" }
```

### GET /api/ready

No authentication required. Checks PostgreSQL and Redis connections; returns `503` if either dependency is unavailable.

**Response 200**

```json
{
  "status": "ready",
  "checks": {
    "postgres": "ok",
    "redis": "ok"
  }
}
```

---

## Admin system configuration

> All endpoints below use `/api/admin/*` and require the `X-Admin-Key` request header.
> `MANAGER_KEY` has full access; `USER_MANAGER_KEY` allows only user-management and message modules.

### POST /api/admin/verify

Verify an admin key and return the current admin identity.

**Response**

```json
{
  "success": true,
  "role": "owner",
  "scopes": ["admin:*"],
  "home_path": "/admin/overview"
}
```

### GET /api/admin/stats

Read global statistics, optionally filtered by recharge date range.

### GET /api/admin/system-config

Returns `{ "model": { ... }, "thinking_level": "medium", "nodes": [ ... ] }`. The model describes the public pool alias and common prices. Nodes include the read-only `is_primary` role, connection metadata, enabled state, weight, `has_secret`, `failure_count` and `cooldown_until`. Credential values are never returned; an unconfigured pool has an empty nodes list.

### GET /api/admin/recharge-config

Read recharge configuration. Response `notify_url` / `return_url` values are generated by the server for display.

### PUT /api/admin/recharge-config

Update recharge configuration. Callback URLs are generated by the server and do not need to be submitted.

**Request Body**

```json
{
  "enabled": true,
  "min_coins": "1.00",
  "max_coins": "1000.00",
  "epay_url_prefix": "https://pay.example.com/",
  "epay_platform_id": 1001,
  "epay_merchant_private_key": "-----BEGIN PRIVATE KEY-----...",
  "epay_platform_public_key": "-----BEGIN PUBLIC KEY-----...",
  "epay_merchant_key": "query-secret"
}
```

### GET /api/admin/reward-config

Read daily check-in and membership reward configuration.

### PUT /api/admin/reward-config

Update daily check-in and membership reward configuration.

### PUT /api/admin/system-config/model

Saves the paid pool name, common token prices, thinking level and complete node list in one transaction. Concurrent writers share its pool lock. New clients supply `revision` from the overview to reject a stale draft.

**Request Body**

```json
{
  "display_name": "Official model pool",
  "thinking_level": "medium",
  "input_token_price_per_million_coins": 200,
  "output_token_price_per_million_coins": 800,
  "nodes": [
    {
      "id": "existing-node-id",
      "display_name": "Provider A",
      "pi_api": "openai-responses",
      "base_url": null,
      "model_name": "provider-model-id",
      "api_key": "<provider-api-key>",
      "context_window_tokens": 128000,
      "enabled": true,
      "weight": 3
    }
  ]
}
```

- `nodes`: one retained primary node plus 0–19 child nodes. On first configuration the first submitted node becomes primary. Subsequent saves must include its existing `id`; omission is rejected with HTTP 400. Omit `id` to add a child, or omit an existing child from the list to remove it. Reordering does not replace the primary. Historical model rows and credential references remain intact.
- `weight`: integer 1–1000. Each model call selects among eligible nodes by weight and tries each candidate at most once.
- `pi_api`: `openai-completions`, `openai-responses`, `anthropic-messages`, or `google-generative-ai`. Different models and protocols may share a pool.
- `api_key`: required to enable an unconfigured node; omit or leave blank to preserve its credential. Changing protocol, endpoint or authentication mode requires a new credential.
- `auth_mode`: optional; must match the protocol. Anthropic supports `anthropic_api_key` and `claude_code_oauth_token`.
- `context_window_tokens`: `null` or `0` uses automatic detection; an explicit value must be 8192–2000000. Requests use the smallest capacity among enabled, configured nodes.
- `thinking_level`: `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`, applied to all users and Open API turns.
- Public token prices are common to the pool and captured at admission. Failover does not change the admitted prices.

Existing installations enroll only their previously configured official model and preserve its public alias and prices. User custom-provider endpoints remain removed. Provider failures trigger shared cooldown and failover before response content is published; cancellation and input errors do not trigger failover. See [Official model pool](official-model-pool.md) for timeout, recovery and billing boundaries.

### GET / PUT /api/admin/system-config/benefit

The independent free overview/update uses `revision`, `enabled`, `display_name`,
`thinking_level`, zero input/output prices, `benefit_policy` and `nodes`.
`benefit_policy` contains only `daily_turns` (1–100) and `concurrency_limit`
(1–10). Free requests use the same context/output policy, history compaction
and finite timeouts as paid requests; no separate token or tool/model-call budget
is accepted.
Free nodes use the same connection and weight fields as paid nodes; no upstream
quota group or manual request/token limit is required. An empty node list is valid
while disabled. Enabling requires at least one configured enabled node. Stale
revisions fail without overwriting the current settings.

Provider rate limits or exhausted quota automatically cool the responding node
and trigger failover within the free pool. Cooldown metadata is read-only; unrelated
settings saves preserve it. The paid and free updates cannot change each other's
membership or policy. See the [operating contract](benefit-model-pool.md) for cooldown
defaults, personal limits, failure/refund rules and activation.

The legacy `/system-config/providers`, `/system-config/runtime`, and `/system-config/model-billing` mutation endpoints remain removed.

### Other admin endpoints

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/admin/users` | User list and usage overview |
| POST | `/api/admin/users` | Create a user directly as an administrator |
| GET | `/api/admin/users/:id` | User details |
| GET | `/api/admin/users/:id/transactions` | User wallet transactions |
| POST | `/api/admin/users/:id/balance/grant` | Grant bonus balance |
| POST | `/api/admin/users/:id/balance/adjust` | Adjust recharge balance |
| GET | `/api/admin/users/:id/balance/grants` | User bonus-balance records |
| DELETE | `/api/admin/users/:id/logs` | Delete user conversation logs |
| DELETE | `/api/admin/users/:id` | Delete a user |
| GET | `/api/admin/billing/reservations` | Query billing reservations |
| POST | `/api/admin/billing/reconcile` | Reconcile stale billing reservations |
| GET | `/api/admin/messages` | Search messages as an administrator |
| GET | `/api/admin/chat-sessions` | Search sessions as an administrator |
| POST | `/api/admin/chat-sessions/pi-sessions/cleanup` | Clean up Pi session files |
| GET | `/api/admin/skills/custom` | Search custom Skills as an administrator |
| GET | `/api/admin/skills/custom/:id` | Current skill content, database storage metadata, and recent revision history |
| GET | `/api/admin/skills/global` | List global system chart switches |

The custom skill list returns summary metadata without file bodies or revision arrays. Its `storage` object includes the persisted content state, current revision ID and save time, format version, revision and file counts, and legacy import status, diagnostic code, and last check time. A current database revision takes precedence over historical import outcomes when determining the displayed storage state. Enabled and visibility flags remain independent.

The detail endpoint returns the same metadata, the current revision's `files`, and metadata for the latest 20 revisions in `revisions`. File counts, text length, timestamps, and revision identity are read in the same SQL snapshot. These endpoints report PostgreSQL state; they do not measure runtime cache readiness or database replication lag. The admin list supports storage-state filtering and preserves filters when opening a detail page.

---

## Common error format

All error responses use a consistent format:

```json
{ "error": "Error description" }
```

| HTTP status | Meaning |
| ----------- | ------------------- |
| 400 | Invalid request parameters |
| 401 | Not logged in or token expired |
| 403 | Permission denied |
| 404 | Resource not found |
| 500 | Internal server error |

---

## Environment variables

| Variable | Default | Description |
| --------------------------- | ----------------------- | ---------------------------------- |
| `API_PORT` | 3000 | API listen port |
| `API_HOST` | 0.0.0.0 | API listen address |
| `PUBLIC_BASE_URL` | - | Public base URL for generating payment callback URLs |
| `PUBLIC_API_BASE_URL` | - | Public API URL for generating payment notification `notify_url` |
| `PUBLIC_WEB_BASE_URL` | - | Public www URL for generating post-payment `return_url` |
| `DATABASE_URL` | - | PostgreSQL connection URL |
| `REDIS_URL` | - | Redis connection URL |
| `JWT_SECRET` | - | JWT signing secret; must be strongly random |
| `MANAGER_KEY` | - | Admin authentication key; must be strongly random if supplied |
| `USER_MANAGER_KEY` | - | User-manager key granting access only to user and message modules; must be strongly random if supplied |
| `ALLOWED_ORIGINS` | - | Production CORS allowlist; must include www and admin origins in three-site deployments |
| `NODE_ENV` | - | Set to `production` in production |
| `LOCAL_AGENT_ENTRY_MODE` | `auto` | Local agent-runtime entry selection: `auto` / `src` / `dist` |
| `LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB` | - | V8 old-space limit for agent-runtime children; `128` recommended for a 2 GB server |
| `AGENT_REQUEST_TIMEOUT` | `1800000` | WeChat Bot timeout waiting for an agent response, in milliseconds |
| `AI_CHAT_REQUEST_TIMEOUT` | `1800000` | AI Chat timeout waiting for an agent response, in milliseconds |
| `BILLING_RESERVATION_STALE_MS` | `2400000` | Age at which a billing reservation is considered stale |
| `TRACE_RETENTION_DAYS` | `7` | Retention days for `conversation_log_payloads.trace_events` |
| `FATECLAW_TEXT_SKILLS_DIR`  | `.fateclaw/text-skills` | Rebuildable user skill cache and legacy backfill root |
| `FATECLAW_PI_SESSION_DIR` | - | Directory for agent-runtime Pi session files |
| `LOG_LEVEL` | `info` | Server log level |
| `LOG_PRETTY` | Enabled by default outside production | `1` forces pino-pretty on; `0` forces it off |

Model providers are primarily configured in the database through admin `/api/admin/system-config`. AI requests consume the host-supplied `llmRuntime` and do not rely on process-level model keys.
Agent concurrency slots, the resident runtime limit, and idle-reclamation timeout are written to `runtime_config` through the admin app.
