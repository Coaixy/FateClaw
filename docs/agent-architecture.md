# Agent architecture

Last checked: 2026-10-20.

This document describes the agent runtime architecture in the current code. In the main flow, the host process calls an account-level agent-runtime through Redis IPC. For each request, agent-runtime creates a Pi SDK Runtime, which handles the model loop, user knowledge reads, and final reply. System chart calculation runs in deterministic packages on the Web/API side.

Core code entry points:

- `apps/api/src/runtime/resident-agent.ts`
- `apps/api/src/runtime/ipc-worker.ts`
- `apps/api/src/runtime/local-runner.ts`
- `apps/agent-runtime/src/daemon.ts`
- `apps/agent-runtime/src/request-boundary.ts`
- `apps/agent-runtime/src/pi-runtime/`
- `apps/agent-runtime/src/skill-content-cache.ts`

## Architecture layers

```text
Web AI Chat / WeChat message handling
        │
        ▼
apps/api host process
  - Sessions, accounts, billing, model configuration
  - Build history / activeBoardContext
  - Call system chart runners to generate chart artifacts
  - Manage Text Skill Bundle metadata and permissions
  - Enqueue Redis IPC requests and listen to outboxes
        │
        ▼
Redis IPC
  ipc:{runtimeId}:inbox:member
  ipc:{runtimeId}:inbox
  ipc:{runtimeId}:outbox
  ipc:{runtimeId}:ai-chat:outbox
  ipc:{runtimeId}:cancel
        │
        ▼
Account-level resident agent-runtime process
  - daemon BRPOP inbox
  - request-boundary handles each request
  - Create a request-scoped Pi Runtime
  - Pi ResourceLoader exposes Text Skill Bundles authorized for the turn
        │
        ▼
Pi SDK model loop / authorized Skill file reads
        │
        ▼
Host persists results, settles billing, and replies to Web or WeChat
```

The host and agent-runtime have distinct responsibilities:

- The host owns platform operations: users, accounts, sessions, message persistence, billing reservations and settlement, model runtime resolution, Redis IPC, Fastify API, Text Skill Bundle writes, and system chart-runner calls.
- agent-runtime owns AI execution: creating request runtimes, calling Pi SDK, reading authorized Skill files, and generating transcript / trace / agentGraph data.
- Model keys and providers are AI request-level data. Before enqueueing AI Chat or WeChat messages, the host resolves database configuration and sends an `llmRuntime` snapshot in the IPC payload. Manual chart requests call system chart runners in the API and do not require a model runtime.

## Local agent-runtime lifecycle

Local deployments no longer require Docker to run agent-runtime. The host uses `apps/api/src/runtime/local-runner.ts` to launch `apps/agent-runtime` as a child process:

- Development prefers the source entry point `src/daemon.ts`; production or `LOCAL_AGENT_ENTRY_MODE=dist` uses `dist/daemon.js`.
- Each runtimeId maps to one resident child process. AI Chat uses `web:{userId}`. WeChat linked-session turns enter that same owned chat pipeline; retained legacy account envelopes use the WeChat account ID.
- `apps/api/src/runtime/agent-env.ts` centrally builds the child environment, injecting only runtime dependencies such as identity, PostgreSQL, Redis, project root, and Pi session directories. It does not inject global model keys.
- The current local policy permits four resident account processes. At capacity, the host retires the oldest idle runtime and counts it until actual exit.
- Idle runtimes retire after ten minutes. An admitted execution retains its exact child lease until final response, cancellation or timeout.
- On Linux startup, the host cleans up this project's orphaned agent-runtime processes left by a previous host crash, preventing old processes from continuing to consume Redis queues.

## Skill and chart-calculation model

Only user Text Skill Bundles are currently exposed to the model as Pi Skills. System chart calculation is a controlled, deterministic business resource on the Web/API side:

| Type                   | File source                                                              | Exposure                                                                                                  | Database storage                                                                                |
| ---------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| System chart runner    | `apps/api/src/modules/chat/paipan-registry.ts` + `paipan-runners/*.ts`   | Manual `/api/paipan/*` requests and the conversation `create_paipan` tool call the same API-owned runners | `skill_global_config` controls enabled chart types; results are saved in message `tool_context` |
| User Text Skill Bundle | Rebuildable process-owned snapshots in `.fateclaw/text-skills/cache-v1/` | Authorized per request through ResourceLoader                                                             | Immutable `skill_content_revisions`, a current revision pointer, metadata, and permissions      |

PostgreSQL owns user skill content. API saves atomically insert an immutable revision and update its skill pointer after checking the editor's base revision. Agent-runtime authorizes and fixes a revision for each request, then restores it with the shared content protocol and process-owned local cache. Active snapshot leases are released when session creation or execution finishes or fails. Cache retention never deletes active snapshots. Legacy filesystem reads are confined to the API's independent import module; ordinary skill reads use PostgreSQL. See [Skill content architecture](skill-content-architecture.md).

A typical user Text Skill Bundle has this structure:

```text
SKILL.md
index.md
docs/
  knowledge.md
examples/
notes/
```

Private user Skills never enter `.pi/skills`, `~/.pi/agent/skills`, or any globally discoverable directory. `apps/agent-runtime/src/skill-content-cache.ts` rejects those paths and reads only `SKILL.md`, `index.md`, and Markdown files under `docs/`, `examples/`, and `notes/`.

## Host request flow

The main AI Chat flow lives in `apps/api/src/modules/chat/chat-session-service.ts`:

1. Verify session ownership and acquire a session-level concurrency lock using Redis `session:processing:{sessionId}`.
2. Persist the user message.
3. `resolveUserLlmRuntime()` captures the official model pool, common prices and thinking level; legacy user selections are ignored. Model-call routing, failover and shared circuit state are described in [Official model pool](official-model-pool.md).
4. Build historical context with `buildStructuredInputForSession()`.
5. Append `activeBoardContext` if the user selected a chart.
6. Call `dispatchAiChatPrompt()`.

`dispatchAiChatPrompt()` first ensures that agent-runtime is running for `web:{userId}`, then calls `addAccountListener()` to start the host-side outbox listener, and finally enqueues the request through `submitAiChatInboxRequest()`.

AI Chat normally responds to the frontend asynchronously: after successful enqueueing, HTTP `POST /api/chat-sessions/s/:sessionId/messages` usually returns `accepted: true` and `request_id`. `ipc-ai-chat-outbox-handler.ts` handles `ipc:{runtimeId}:ai-chat:outbox` and persists the final reply. The web client exchanges `POST /api/chat-sessions/s/:sessionId/stream-ticket` for a short-lived, single-use ticket, then connects to the `/api/chat-sessions/s/:sessionId/stream` WebSocket. The server uses Redis pub/sub to push Pi session events, progress, final replies, and errors to the current session.

Current WeChat turns use `runOwnedChatSessionTurn()` and deliver the returned final messages through the WeChat message handler. Retained legacy account envelopes use `ipc:{runtimeId}:outbox`, handled by `ipc-outbox-handler.ts` during upgrades. The dedicated AI Chat outbox never sends WeChat messages. Runtime policy and WeChat activation are described in [Runtime configuration](runtime-configuration.md).

## Concurrency, cancellation, and settlement

The host maintains several runtime safeguards before and after requests enter agent-runtime:

- Session busy lock: `session:processing:{sessionId}` prevents concurrent turns in one AI Chat session. Only the current requestId can renew or release it. Its TTL is derived from the timeout chain (API timeout + five minutes).
- Global agent concurrency slots: `agent:concurrency:active` limits site-wide requests entering the model loop simultaneously. Wait queues are ZSETs (`agent:concurrency:waitq:member` / `waitq:normal`, scored by enqueue time) paired with heartbeat hash `agent:concurrency:wait:heartbeat`. Waiters report liveness on each poll. Any live waiter's Lua call atomically evicts a dead queue head after a 15-second heartbeat timeout, so a process crash cannot permanently block the queue. Released slots prioritize the member queue.
- Local agent leases: A request retains its runtime child process until the final response, cancellation, error, or timeout. Idle TTL reclamation follows release.
- Listener reclamation: Outbox listeners for `web:{userId}` are created lazily and exit after ten idle minutes with no in-flight requests, releasing Redis connections. WeChat account listeners remain pinned. After reclamation or process restart, the `inbox-stall-sweeper` outbox scan consumes and persists late orphaned messages after a three-minute threshold, preventing message loss.
- Cancellation queue: A frontend interruption writes a cancel payload to `ipc:{runtimeId}:cancel`. agent-runtime polls this queue while processing the current request and calls Pi session `abort()`.
- Billing reservations and settlement: A billing reservation is recorded according to `llmRuntime` before enqueueing. The final reply is persisted and delivered before charges are settled. If persistence fails, the reservation remains pending and billing-sweeper reconciles charges from conversation logs, preventing users from being charged without receiving a message. After settlement, the charged amount is written back to the final message metadata.
- Timeout chain: All request-flow timeouts derive from the single source `apps/api/src/shared/timeout-chain.ts` (eight-minute daemon hard timeout < inbox cleanup threshold < 30-minute API timeout < session-lock TTL). The host injects daemon values through the environment at spawn time. Invalid configurations fail at startup.
- Liveness heartbeat: Every ten seconds, the daemon writes `agent:heartbeat:{accountId}` with a 30-second TTL and deletes it on graceful exit. Monitoring immediately alerts on accounts with an inbox backlog but no heartbeat (`ALERT_WEBHOOK_URL`, optional), without waiting for the cleanup threshold.

## A single Agent Runtime request

`apps/agent-runtime/src/daemon.ts` is the sole resident entry point:

1. `initContext()` reads runtimeId and user identity from the environment.
2. Connect to Redis.
3. Wait for requests with `BRPOP ipc:{accountId}:inbox`.
4. Parse `InboxRequest`; validate `llmRuntime` for AI requests.
5. If the request specifies `outboxQueue`, create customized `AgentRuntimeDeps` that redirect `messageBus.pushOutbox()` to that queue.
6. Call `executeContainerInput()` for AI requests.
7. Wrap `ContainerOutput` as `OutboxResponse` and `LPUSH` it to the outbox.

`request-boundary.ts` handles the logic surrounding each request:

- Call `createRequestRuntime()` and pass the request to `executePiRuntime()`.
- Merge and return the turn's skill context, transcript, traceEvents, agentGraph, and usage.
- Map internal errors to user-facing errors while retaining existing trace/transcript data for diagnosis.

## Pi Runtime

`apps/agent-runtime/src/pi-runtime/` is the current main AI execution path:

- `resource-loader.ts`: Injects authorized Text Skill Bundles per request.
- `session.ts`: Creates Pi sessions and configures the provider, prompt, tools, and ResourceLoader.
- `skill-read-tool.ts`: Lets the model read Markdown files from currently authorized Skill Bundles on demand.

The API generates structured chart artifacts. Pi can request a new chart through
`create_paipan` and interpret the returned facts in the same turn. Skill file
reads remain limited to the current ResourceLoader's authorized knowledge files.

Chart-specific prompts live in `apps/agent-runtime/src/pi-runtime/prompts/` and
attach to the matching board in the context manifest. The Jingzhan prompt applies
to official and user-pasted Jingzhan boards and prohibits Liuyao interpretation
methods. It is loaded only with a Jingzhan board.

Pi sessions disable built-in tools and explicitly register FateClaw tools for
authorized Markdown, Soul, calendar and session-board access. Chart creation is
available only when the host supplies a durable execution ID, request ID and
session. Other callers retain the existing instruction to use the dedicated chart
entry point.

### Conversation visualizations

Web requests with an admitted request ID, execution ID and session expose
`render_visualization({ type, title, summary, spec })`. SVG source describes
custom explanatory diagrams: element cycles, annotated relationships, grouped
structures and timelines. Mermaid source describes automatically laid out
flows, sequences, state diagrams, mind maps and timelines. Vega-Lite JSON
describes charts with inline data, layers and selection or input parameters.
The model must distinguish calculated facts from illustrative data in `summary`;
visualization does not calculate or replace authoritative chart facts.

The agent proactively illustrates relationships, structures, processes,
comparisons and timelines when a figure improves understanding, without waiting
for an explicit drawing request. Qualitative diagrams do not require invented
scores or statistics. Each figure focuses on one topic and appears next to its
explanation. Short factual answers and explicit text-only requests remain text.
The session boundary appends the registered tools' snippets and guidelines to
the custom system prompt: Pi 1.3 does not add those contributions automatically
when a custom prompt is present. Only available tools contribute guidance.

The tool uses account-encrypted `ipc:{accountId}:visualization` requests and the
existing account listener. Both chart and visualization writes use
`withActiveConversationRequest`: the admitted request supplies ownership, and
its PostgreSQL row lock serializes retries. A request/tool-call-derived ID
identifies an immutable `visualization_result` message. Identical retries reuse
the artifact; changed arguments fail. Persistence commits before the best-effort
stream notification and successful tool reply. Cancelling interpretation does
not remove an already committed visualization. RPC and queue lifetimes match
conversation chart creation below.

`packages/contracts/src/visualization/` owns the versioned rendering contract.
SVG uses the same XML parser and element/attribute allowlist in the runtime,
API and browser. It permits basic shapes, text, groups, markers, gradients and
clipping, bounded to 64,000 bytes, 500 elements and 16 levels. A required viewBox
bounds the root canvas to 100–1,600 by 100–2,400 units. Scripts, events, CSS,
HTML, images, links, animation, document types and processing instructions are
unavailable. Paint and marker references must resolve to matching definitions
inside the figure. Theme color variables keep text readable in both themes.
Mermaid source is bounded to 16,000 characters and disallows HTML, links,
directives and custom styles. Syntax validation runs in a disposable worker with
an empty environment, a private DOM and a four-second deadline. Vega-Lite uses
the pinned schema, compiler and expression parser; the contract bounds data to 1,000 rows, 12
layers, 64,000 bytes and 24 levels of nesting. Data field names are treated as
data, separately from renderer configuration. External resources, DOM selectors,
custom event streams and multiple views are unavailable. Expressions permit
field/parameter arithmetic and comparisons, without function calls. Transforms
are limited to filtering, calculations, aggregation, binning and time units
(up to 20 steps); callers must prepare data that would require row expansion.

The successful tool result contains a small ID, title, summary and a fenced
`visualization` reference. The model inserts that reference between paragraphs;
the full specification is stored outside truncated tool previews. Final reply
persistence resolves references only within the same account and session and
attaches the full artifacts to each referencing assistant message. Thus a
paginated answer or shared conversation retains everything needed to render.
The web client renders references in place and hides a standalone result once
the answer references it; unreferenced results remain readable after interrupted
turns. Unknown references and individual rendering failures preserve the text.
Copying an answer substitutes each figure's title and summary for its reference.

Browser renderers load on demand. SVG creates DOM nodes from its validated tree,
without parsing model markup as HTML, and gives every mount its own definition
IDs. Inline figures retain their natural height rather than shrinking long
diagrams to a viewport. Mermaid uses host-controlled strict settings.
Vega uses its AST interpreter without `unsafe-eval` and a loader that refuses
external resources and links. Figure interaction and full-screen reading reuse
the existing artifact portal and viewer. WeChat requests do not expose this
browser capability.

### Conversation chart creation

`create_paipan({ mode: "catalog", skill? })` returns enabled chart types and their
canonical parameter schemas. `mode: "create"` requires `skill` and `input` and
uses the same validation, profile prefill, runners and formatters as manual
charting. The agent must clarify missing birth information, calendar ambiguity
and unspecified random casting methods before creating a chart. Follow-up
questions reuse the existing board unless the user requests a new one.

The runtime sends an account-encrypted operation to `ipc:{accountId}:paipan`.
The existing account outbox listener handles this queue as well, so a waiting
model does not need another resident host listener. The host resolves the user
and session from the admitted `agent_requests` row and checks the execution ID,
running state, cancellation, deadline and active session ownership. Model
arguments cannot select a user, session or customer profile.

The host locks that request row, calculates and saves a standalone `board_result`
message in one PostgreSQL transaction. The request and tool-call IDs determine a
stable message ID; identical retries return the stored result, and changed
arguments for that same call fail. The transaction shares its database client
with chart permissions, profile prefill and message persistence. This keeps
concurrent retries from generating different random charts or exhausting the
pool with nested connections.

After commit, a best-effort stream message asks the web client to reload saved
messages, and the host returns chart facts to the model through an encrypted
reply queue. The runtime updates the same mutable board collection used by
`get_session_board`, preserving existing board indices. The saved chart is not
attached again to the final assistant reply. Subsequent requests rebuild board
context from its persisted message, including after a refresh or interrupted
interpretation. Jingzhan creation results also carry its interpretation rule.

RPC waits end after 15 seconds or cancellation and release their dedicated
blocking Redis connection. Request queues expire after 30 seconds; reply queues
also expire after 30 seconds, and both envelope lifetimes are 15 seconds. A lost
reply does not undo a committed chart. The agent must not automatically reroll
when the outcome is uncertain.

The runtime and API pin Pi SDK packages to 1.3.0. `SessionManager` owns finalized
provider context, including compaction and context edits; restore version-3 JSONL
sessions through the manager rather than assigning message arrays to agent state.
The request-scoped resource loader supplies no extensions, and the explicit tool
allowlist contains only FateClaw tools. Pi's MCP, codemode, and tool-search
extensions require separate host integration.

## Bounded Skill search and runtime recovery

- Each `grep` invocation runs scope resolution, Markdown discovery, regex compilation
  and line matching in a disposable worker. The daemon enforces a two-second budget
  for the entire invocation and terminates the worker on timeout or cancellation.
- Workers receive only search parameters, authorized Skill names and directories,
  and the request's cached Markdown file lists. They have an empty environment and
  do not load the daemon, database clients or model credentials.
- Search keeps JavaScript regex semantics, defaults to regex mode, and falls back
  to literal matching for invalid patterns. Complete lines are matched; only result
  previews are shortened. The eight-MiB file limit and result count limit remain.
- Timeout, cancellation and worker failure return explicit tool errors with an
  inexact result count. File discovery is committed to the request cache only after
  successful worker exit. Source workers use Node 24 type stripping; TypeScript
  rewrites relative `.ts` imports for the compiled `.js` workers.
- The host checks each ready child's heartbeat after a 30-second startup grace,
  then every ten seconds. Two consecutive successful Redis reads reporting a
  missing key retire the child even if it is busy. A Redis error or a live heartbeat
  resets that count. SIGTERM is followed by SIGKILL after ten seconds if necessary.
- A replacement for the same account waits for the retired child to exit. Local
  request leases belong to exact child records and release once, so delayed cleanup
  cannot change a replacement's busy count. Existing exit handling and durable
  recovery terminate interrupted requests without automatically replaying execution.

## State and observability

Primary sources of truth:

- PostgreSQL: Users, accounts, sessions, messages, tasks, model configuration, Skill metadata, billing, `conversation_logs`, and `conversation_log_payloads`.
- Filesystem: rebuildable authorized Skill revision snapshots, Pi session files and unsent result spools. PostgreSQL owns Skill content.
- Redis: IPC queues, session busy flags, short-lived history/context boundaries, and other runtime state.
- `apps/api/src/modules/chat/paipan-registry.ts`: System chart catalog, parameter schemas, and runner bindings.
- `apps/api/src/modules/chat/paipan-runners/`: Deterministic TypeScript implementations of system chart calculation.

On request completion, agent-runtime returns:

- `usage`: Actual model token usage.
- `skillContext`: Tool/Skill results reusable in subsequent turns.
- `transcript`: assistant/tool_use/tool_result events.
- `traceEvents`: Structured Pi Runtime, tool, error, and progress events.
- `agentGraph`: A graph of tasks, evidence, and the final reply.

In the outbox handler, the host writes usage, model, event counts, and summaries to `conversation_logs`, and stores transcript, traceEvents, and agentGraph bodies in `conversation_log_payloads`. The web Execution Details feature looks up these logs through the `request_id` in message metadata.

## Runtime scheduling and recovery frames

Capacity scheduling is owned by `apps/api/src/runtime/agent-scheduler.ts`.
A Redis account lease precedes local startup and the global execution gate.
Waiting requests retain durable admission and their original deadline without
occupying global slots. Member priority applies among runnable accounts. Release
atomically removes account/global ownership and publishes a capacity notification;
local wakeups and finite reconciliation bound recovery when notifications fail.
Queued requests are not failed when an earlier execution's child exits.

Pi session frame data is owned by `packages/contracts/src/agent/` and persisted by
`pi-session-frames-repository.ts` in the result delivery transaction. Full
checkpoints occur every sixteen frames and after compaction changes the message
prefix. Lightweight traces remain independent of snapshot storage. See
[performance and reliability](performance-and-reliability.md) for rollout, resource
preparation, timing definitions, retention and validation boundaries.

## Runtime transport and stream batching

- Each agent daemon owns two Redis connections. The inbox connection is used only
  for blocking reads; heartbeat, cancellation, stream publication and outbox writes
  use the command connection. The ready signal is emitted only after both connect.
- Shutdown disconnects the blocking connection directly, since `QUIT` would wait
  behind `BRPOP`. Command connection shutdown waits at most five seconds before
  disconnecting. This bounds Redis cleanup, not the entire daemon drain sequence.
- Each Pi request coalesces consecutive assistant or thinking text updates within
  a 50 ms window. Full snapshots remain available to reconnecting clients, and
  merged deltas contain all text added within the window. A stream type change,
  turn change, replacement snapshot, or non-text event flushes pending text first.
- Request completion, cancellation and errors flush pending text and clear the
  batching timer through the Pi session cleanup path. Publication remains
  best-effort; persisted final messages remain the delivery source of truth.

## Common misconceptions

- Each runtimeId reuses a resident agent-runtime; a temporary agent is not started for every message.
- `web:{userId}` is not an account-table record. It is a runtime key used for agent-runtime reuse, message archiving, and log partitioning.
- Redis is the primary IPC transport here, not just a cache.
- A successful AI Chat HTTP send does not mean the final reply exists. The ai-chat outbox persists the final message asynchronously and pushes it through WebSocket.
- Model provider, model, and secret are a request-level `llmRuntime` snapshot, not values read from the agent process environment.
- System chart calculation no longer uses the legacy instruction files or a separate script directory. Parameter schemas and runner bindings are maintained in `apps/api/src/modules/chat/paipan-registry.ts`.
- Do not look for a one-shot stdin/stdout entry point in agent-runtime. Its sole current entry point is `daemon.ts`.

## Reliability contract

See [performance and reliability](performance-and-reliability.md) for the durable
admission state machine, result acknowledgement, recovery, bounded queues and
Pi 1.3.0 deployment contract.
