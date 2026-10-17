# Performance and reliability upgrade

## Preserved contracts

FateClaw continues to use one reusable daemon per runtime account, request-scoped
model credentials and authorized resources, Redis IPC, and PostgreSQL business
state. Pi owns session history and compaction. Deterministic charts remain in the
API. Sending, streaming, cancellation, history, private knowledge and Soul retain
their existing public interfaces. No balance is frozen: billing uses actual
reported usage, including completed turns before cancellation or failure.

The original memory cap and idle recycling serve small single-host deployments.
They remain in place. Runtime startup and global capacity acquisition remain
parallel, and HTTP acceptance now follows durable admission rather than worker
startup. A no-progress watchdog remains distinct from the absolute deadline.

## Durable request lifecycle

Migration `0076_durable_agent_requests` adds request admission and delivery receipts.
The user message and request are inserted in one transaction before acceptance.
The durable runtime snapshot excludes credentials. Recovery resolves the existing
credential source and checks provider/model identity before reuse; stored prices
and entitlements remain those admitted with the request.

The normal state path is `queued -> dispatched -> running -> result_ready -> completed`.
A worker atomically claims the execution ID before contacting a model. A partial
unique index permits one running execution per session. Worker leases renew every
10 seconds and expire after 60 seconds; cancellation and the original deadline
are checked at admission, dispatch, execution and renewal.

The API scans every 10 seconds, claims one expired row at a time, and processes at
most 32 rows per pass. Unstarted work may be dispatched again with the same
execution ID and deadline. Running work is never automatically rerun: it becomes
`interrupted` with unknown outcome. Starting its daemon only replays saved results.
Synthetic interruption messages do not finalize usage, billing or delivery receipts.
A late actual result can replace the interrupted state and settle actual usage.
Interruption message writes lock the request row so they cannot overwrite an
already-ready actual result. Notification acknowledgement is durable and retryable.

Results are first saved by atomic file replacement under the account's existing
Pi session directory, then persisted to PostgreSQL and sent over Redis. Local
files contain result routing and responses, never the request credential snapshot.
The daemon replays up to 16 saved results on startup and every 10 seconds. A file
is removed after reliable handoff. Disk, database and Redis failure together cannot
be made durable; this path is reported as an error, never as a new generated answer.
Host or disk loss is outside the local spool guarantee.

AI Chat Redis consumption moves a result to a processing list before handling it.
Acknowledgement removes it only after successful delivery. Processing lists are
included in orphan recovery. Invalid JSON is quarantined without logging its raw
contents; quarantine failure retains the processing copy. WeChat external sends
retain their existing delivery policy and are not blindly retried.

A single PostgreSQL transaction owns the delivery receipt, conversation log,
usage counters, final messages and session touch. Duplicate results skip these
writes. Billing settlement reads committed actual usage from the conversation log or the
durable generated result, independently of message delivery. It is idempotent and
recoverable. Stream notification failure does not turn a committed
reply into an error. Unknown durable usage is excluded before the billing sweep's
batch limit, so it neither closes as zero nor blocks other accounts' settlements.

Completed jobs clear duplicate input and result bodies; their small identity rows
and delivery receipts remain to reject late duplicates. Interrupted requests clear
input but retain their explicit outcome. Receipts and unknown billing records must
not be removed by age alone. Existing conversation retention remains authoritative
for detailed transcripts. Local unsent results and invalid-message quarantine are
retained for recovery/operator inspection rather than silently evicted.

## Bounded runtime work

- Blocking inbox Redis reads use a dedicated connection, separate from commands,
  heartbeats, cancellation, publications and result writes. Command connections
  have five-second connect/command deadlines and reject offline writes; blocking
  reads explicitly disable the command deadline and use their own finite BRPOP timeout.
- Text/thinking stream updates coalesce within 50 ms. Full snapshots and all delta
  text are retained; turn/type/replacement/critical-event boundaries flush first.
- `@fastify/websocket` handles WebSocket protocol details. One lazy Redis subscriber
  per API process multiplexes active sessions. Each socket has a 1 MiB output budget;
  compatible snapshots coalesce and irrecoverably slow clients disconnect so the
  existing history recovery can take over.
- Healthy business stream traffic reduces message polling from 1.2 seconds to about
  15.6 seconds. Five seconds without business progress, disconnects and new requests
  restore the fast recovery cadence. A socket handshake alone does not mark progress.
- Local process capacity waits for up to 30 seconds and honors cancellation and the
  request deadline. Waiters do not reserve slots; retiring processes count until
  actual exit. Same-account startup remains coalesced.
- PostgreSQL pools use 10 API connections and 2 per daemon. Connections wait at most
  5 seconds; ordinary statements use 30-second server timeouts. See
  [database reliability](database-reliability.md) for transaction and migration budgets.
- Soul updates lock the canonical and applicable legacy rows in a serializable
  transaction, check the base hash, and report conflicts instead of overwriting.

## Runtime and dependency compatibility

The supported workspace runtime is Node 24 (`.nvmrc`). Pi packages are pinned to
`0.86.0`; WebSocket integration uses `@fastify/websocket` `11.2.0`. Pi credential
initialization is awaited and cache warming is explicitly disabled to avoid added
provider calls. Exact-version release-age exceptions are recorded in the workspace
policy. The SDK's built-in transcript adapters remain the only compatibility path.

Deploy migration 0076 with the API before starting the new daemon binary. Keep the
existing session directory on persistent storage. Old in-flight inbox envelopes
without an execution ID remain accepted during rollout, but cannot acquire the
new admission/restart guarantee retroactively. Do not downgrade while durable
requests or local result files remain unresolved.

## Web chat interaction and rendering

The web client loads message pages of 50 and reconciles the latest page into the
existing history rather than increasing a refresh limit past the API's 200-message
cap. Pagination uses `before` and `before_id` with stable timestamp/ID ordering, so
messages sharing a timestamp remain reachable. A disconnected stream backfills
until it overlaps known messages. Each reconciliation is bounded to 20 pages;
exceeding that budget reports a retryable synchronization error and keeps the
existing history. Unchanged messages retain their object identity. Older-page
requests and scroll anchors belong to one visit to a session, including when a
user leaves and returns to the same session before a response arrives.

Execution state distinguishes admission, running, result synchronization,
cancellation, success, failure and stopped output. The active request ID comes
from HTTP acceptance, the stream, or the existing processing lock returned as
`processing_request_id`. An older answer cannot prove a new submission completed.
Cancellation waits for admission and server acknowledgement; a failed cancellation
keeps the stream and synchronization active. A result persisted while cancellation
is pending remains a result rather than becoming stopped output. Late responses
cannot change a newer request or another session visit. Network uncertainty stays
in synchronization instead of claiming failure or success and automatically
resubmitting the question.

Drafts use sessionStorage scoped by user and session, with an in-memory path when
storage is unavailable. They survive navigation and reload within the browser
session. Creating a session transfers its remaining draft before publishing the
selection. Failed submissions restore their text to the original scope without
overwriting the next draft. Generation permits editing the next question while
submission remains serial. Enter respects IME composition and Shift+Enter; each
input change measures textarea height once.

The chart selector reads an owner-scoped summary endpoint independently of the
visible history window. Automatic selection uses the newest chart; explicit
selection sends the existing `selected_board_message_id` contract. Accepted pasted
charts and committed charts return the selector to automatic newest-chart mode.
Associated clients link to their profile. Returning to the newest message is an
explicit action when the reader has scrolled away from ongoing output.

Markdown rendering retains stable renderer identities and memoizes completed
blocks in a growing reply. Unfinished code does not run syntax highlighting;
completed answers use one document parse. Reference definitions and other syntax
that cannot safely be split retain document-wide parsing. Message grouping is
linear and memoized. Chart-entry sheets mount only when opened and expose a
loading state. Answers can be copied directly; tool result sources link only to
absolute HTTP(S) destinations and display their actual host.

## Validation and remaining evidence

Automated checks cover admission rollback, competing claims, execution fencing,
cancellation, duplicate delivery, failed delivery retry, interruption/actual-result
races, Soul conflicts, pool limits, local process capacity, stream backpressure,
adaptive polling, and local provider SSE parsing and cancellation. Integration
suites use disposable PostgreSQL 17 and Redis containers plus synthetic stores;
no production data, provider credentials or paid model calls are required.

Real paid providers, production session migration/long-context compaction, peak
load latency and memory, and full host power-loss recovery remain **unverified**.
Polling cadence, queue budgets and batching windows are implementation bounds,
not measured production throughput claims.

Validation on 2026-09-20 used Node 24.18.0 and pnpm 11.5.0: all 708 tests
in 121 files passed with the PostgreSQL and Redis integration suites enabled.
API, agent, web and admin type checks passed; contracts and backend TypeScript
compilation passed. Changed backend files had no lint errors (62 warnings).
The offline frozen lockfile check passed with lifecycle scripts disabled.
