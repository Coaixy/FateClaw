# Open API

FateClaw exposes authenticated chart calculation and stateful Agent sessions under
`/api/v1`. API-key management uses the separate JWT-authenticated `/api/api-keys`
interface. External requests and responses use `snake_case`.

This reference describes the current routes in
[`open-api-routes.ts`](../apps/api/src/interfaces/http/open-api-routes.ts),
[`open-paipan-routes.ts`](../apps/api/src/interfaces/http/open-paipan-routes.ts), and
[`open-session-routes.ts`](../apps/api/src/interfaces/http/open-session-routes.ts).
Human-readable sample content is translated into English; actual chart text,
labels, and error messages may be Chinese.

## Authentication and key management

Call `/api/v1/*` with a platform-issued API key:

```http
Authorization: Bearer <api-key>
```

Keys use the `fc_live_` prefix and belong to a user, not a WeChat account.
The server stores only a hash. The complete key is returned once at creation;
subsequent listings expose its prefix and last four characters.

Manage keys using the user's JWT instead of an API key:

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/api-keys` | Create a key; requires active membership |
| GET | `/api/api-keys` | List the current user's keys, including revoked keys, without plaintext |
| DELETE | `/api/api-keys/:id` | Revoke a key belonging to the current user |

Creation body:

```json
{
  "name": "My application",
  "expires_at": "2027-01-01T00:00:00Z"
}
```

`name` is trimmed and must contain 1–50 characters. `expires_at` is optional or
nullable; if supplied, it must be a future ISO 8601 timestamp with a timezone.
A user can hold at most ten active keys. Creation returns HTTP 201 with the key's
metadata and one-time `key` field. Listing returns `{ "api_keys": [...] }`;
revocation returns `{ "success": true }`.

Membership expiry does not invalidate an existing active, unexpired key.
External calls still require a wallet that is not in arrears. This authentication
gate applies to chart and Agent endpoints alike. See
[Entitlements and billing](membership-entitlement-current.md) for membership and pricing.

## Models and Skills

| Method | Path | Response |
| --- | --- | --- |
| GET | `/api/v1/models` | `{ "object": "list", "data": [...] }` with official model aliases |
| GET | `/api/v1/skills` | `{ "object": "list", "data": [...] }` with effectively available Skills |

Model entries contain `id`, `object: "model"`, and `owned_by: "fateclaw"`.
Use a returned model ID rather than an upstream provider's model identifier.
Skill entries contain `id`, `object: "skill"`, `name`, `description`, and `source`.
Pass Skill UUIDs into session creation to opt in to those resources.

## Chart calculation

`GET /api/v1/paipan/catalog` returns `paipan_types`. Each entry contains `type`,
`name`, `description`, and a `parameters` JSON Schema, including any examples.
Use this catalog for the currently enabled types and their accepted parameters.

| Type | System | Internal runner |
| --- | --- | --- |
| `bazi` | Bazi | `bazi-paipan` |
| `iching` | Liuyao Najia | `iching-paipan` |
| `jingzhan` | Zhouyi Jingzhan | `jingzhan-paipan` |
| `meihua` | Meihua Yishu | `meihua-paipan` |
| `qimen` | Qimen Dunjia | `qimen-paipan` |
| `liuren` | Da Liu Ren | `liuren-paipan` |
| `ziwei` | Ziwei Doushu | `ziwei-paipan` |

Submit chart parameters directly to `POST /api/v1/paipan/:type`. For example,
`POST /api/v1/paipan/bazi` accepts:

```json
{
  "solar_date": "1990-05-20",
  "hour": 10,
  "gender": "male"
}
```

The response contains `type`, AI-readable `text`, and structured `data`.
Calculation uses the same deterministic runners as manual charting, without
creating a chat session or calling a model. Chart calls have no coin charge,
but remain subject to API-key authentication, the arrears gate, and rate limits.

`data` is the underlying algorithm library's chart output and can change with
library versions. `text` is the formatted interpretation input. The API converts
external snake_case parameters to the registry's internal camelCase names.

## Agent sessions

| Method | Path | Behavior |
| --- | --- | --- |
| POST | `/api/v1/sessions` | Create a session and return HTTP 201 |
| POST | `/api/v1/sessions/:sid/messages` | Send one turn and wait for the complete reply |
| GET | `/api/v1/sessions/:sid` | Read session metadata without conversation history |
| DELETE | `/api/v1/sessions/:sid` | Soft-delete the session and archive its associated chat session |

Create a session with optional model, persona, Skills, and chart context:

```json
{
  "model": "<model-id-from-models>",
  "system": "You are a careful Chinese astrology interpreter.",
  "fateclaw": {
    "skills": ["<skill-uuid>"],
    "board": {
      "type": "bazi",
      "text": "<text-from-the-chart-response>"
    }
  }
}
```

Omit `model` to use the current official model. A supplied alias must be valid
at creation. Session metadata records the creation-time alias; message turns
resolve the current official pool configuration, prices, and thinking level.
See [Official model pool](official-model-pool.md).

`system` is a constrained persona overlay and does not replace the platform's
core instructions. `fateclaw.skills` is an explicit opt-in list of UUIDs. Omission
or an empty array enables no user Skills. Runtime filters IDs against current
ownership, subscription, and enabled status; unauthorized or disabled IDs are
silently omitted.

A board may contain `type`, `text`, and `data`. It is stored once and reconstructed
for every turn. Nonblank `text` takes precedence over serialized `data`. All
caller-supplied boards are treated as `user_pasted_board`, including copied chart
responses, rather than trusted platform-generated facts.

The session response contains `id` (`sess_…`), `object: "session"`, `model`,
`status`, `created_at`, `last_active_at`, and `expires_at`. Keep the returned public
ID for subsequent requests. Internal runtime IDs and ownership fields are not
exposed. All lookups are scoped to the authenticated user; absent, foreign,
expired, and deleted sessions return HTTP 404.

Sessions expire after 30 days, extended after successful message turns. Deletion
returns `{ "id": "sess_…", "object": "session", "deleted": true }` and prevents
further messages through that ID.

### Sending a message

Send only the current turn's content to `POST /api/v1/sessions/:sid/messages`:

```json
{
  "content": "Please interpret my career prospects."
}
```

The server reconstructs persona, chart, and Skill scope from the session, while
the runtime resumes conversation history. Do not resend earlier messages or the
board on every turn. Concurrent turns in the same session return HTTP 409 with
code `session_busy`.

Responses are non-streaming: the HTTP request waits for the complete reply.
Configure reverse-proxy and client read timeouts for long interpretations.
The response follows the OpenAI `chat.completion` structure:

```json
{
  "id": "chatcmpl-<request-id>",
  "object": "chat.completion",
  "created": 1780000000,
  "model": "<official-model-alias>",
  "choices": [
    {
      "index": 0,
      "message": { "role": "assistant", "content": "Your chart suggests..." },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 1200,
    "completion_tokens": 800,
    "total_tokens": 2000
  }
}
```

Usage comes from runtime reporting and falls back to zero when absent. The
shared dispatch path owns billing reservations and actual-token settlement;
HTTP routes do not settle again. Session creation itself does not invoke the
model or incur a charge. The API exposes neither SSE streaming nor a stateless
`/chat/completions` endpoint.

Session continuation depends on the runtime's persistence and recovery paths.
For runtime storage and deployment requirements, see
[Agent architecture](agent-architecture.md),
[Performance and reliability](performance-and-reliability.md), and
[Deployment](deployment-split.md).

## Rate limits and errors

Each valid API key has a fixed-window limit of 60 calls per minute across
`/api/v1/*`. Rate-limit checks precede the more expensive entitlement lookup.
Rate-limited requests return HTTP 429 with `Retry-After`; an unavailable limiter
returns HTTP 503 with code `service_unavailable`.

External errors use this structure:

```json
{
  "error": {
    "message": "API key is invalid or revoked",
    "type": "invalid_request_error",
    "code": "invalid_api_key",
    "param": null
  }
}
```

| HTTP status | Scenario | Example type / code |
| --- | --- | --- |
| 400 | Invalid request or unavailable/unknown official model | `invalid_request_error` / `invalid_request` or `model_not_found` |
| 401 | Missing, invalid, revoked, or expired key | `invalid_request_error` / `invalid_api_key` |
| 402 | Wallet in arrears | `insufficient_quota` / `insufficient_quota` |
| 404 | Unknown chart type or inaccessible session | `invalid_request_error` / `unknown_paipan_type` or `session_not_found` |
| 409 | Another turn is processing in this session | `invalid_request_error` / `session_busy` |
| 429 | Per-key rate limit exceeded | `rate_limit_exceeded` / `rate_limit_exceeded` |
| 502 | Agent execution or dispatch failure | `api_error` / public runtime reason code or `agent_error` |
| 500/503 | Internal service or rate-limiter failure | `api_error` / `internal_error` or `service_unavailable` |

`/api/v1` responses set `Cache-Control: no-store`. JWT-authenticated key-management
routes retain the internal `{ "error": "message" }` format documented in the
[API reference](api-reference.md).
