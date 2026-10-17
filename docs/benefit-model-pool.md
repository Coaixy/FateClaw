# Free model service

FateClaw offers separate paid and free model pools. Both use the existing
platform-owned provider adapters, request-level `llmRuntime` snapshot, resident
agent, durable request recovery and model-call failover. Users choose a service;
they cannot supply providers or credentials. A free request never selects a
paid node or creates a wallet charge.

User-facing labels use **免费模型** and **免费额度**. Internal identifiers,
including the `benefit` pool key and existing API routes, remain unchanged.

## Administration and activation

`/system/models` configures paid models and public prices. `/system/benefit-models`
configures free models, policy and shared upstream quota groups. They reuse one node
editor but use separate endpoints, drafts, revision checks and database locks.
Saving a page cannot remove the other pool's nodes. Unsaved edits are guarded on
link navigation, refresh and window close. The paid primary remains protected;
all free nodes may be removed when the free service is disabled.

Free models are **disabled by default**, with no prepopulated suppliers or credentials.
To enable them, configure at least one node, assign its actual shared quota group,
confirm that the supply permits the application's data/use and stops before paid
overage, then enable the pool. API keys remain in the existing server credential
source. Metadata, request persistence and usage records never include their values.

Each group represents a provider's real project, organization or account quota.
Multiple models/keys drawing on the same capacity must use the same group. Enter
RPM, RPD, TPM, daily token budget, the provider's IANA reset timezone and optional
expiry. The local counters are conservative estimates, not an authoritative
provider balance. Expired, unapproved or archived groups cannot supply new calls.
Editing a group does not reset its counters. Removing it archives its accounting
references and prevents further calls.

## Selection and user experience

The existing chart/plain-question start flow is preserved. The composer adds a
compact model selector; typed questions survive a switch. Pasted-board AI
submission and model settings reuse that selector. Deterministic chart calculation
and chart insertion do not acquire an AI allowance.

The server stores the last explicit preference for new sessions and the selected
pool of each existing session. A session switch also updates the new-session
preference. A preference change does not rewrite unrelated sessions. Existing
sessions migrate to paid; new sessions without a remembered preference select
free models when enabled. Exhaustion never automatically selects paid.

Switches use the existing session processing lock plus the durable session-row
boundary. Admission verifies the selected pool and absence of another active
durable request under that same row lock. A running turn cannot be switched,
including after loss of a transient Redis lock. Request snapshots preserve the
chosen pool and limits through queueing/recovery. A conflicting selection fails
before dispatch; a previously registered paid reservation can settle at zero usage.

The UI identifies free models as **基础体验**, explains limited reasoning/tool capability
in the selector, shows remaining turns without a large permanent banner, and
labels final replies as free replies. Paid choices show the current account's
applicable input/output prices, including the non-member multiplier. Model status
refreshes after a turn, on return to the page and once a minute while visible.

## Durable admission and limits

The API creates the free reservation, durable request intent and user message
in one transaction. Personal allowance rows serialize the final available turn
across processes. One user can hold one queued/running free request. The pool
has a bounded FIFO wait and execution share, also subject to global agent capacity.

Initial policy:

| Limit | Default |
| --- | --- |
| Daily personal turns | 3, all memberships, no carryover; Asia/Shanghai midnight |
| Free execution slots / waiters | 2 / 20 |
| Queue / execution deadline | 30 / 180 seconds |
| Model attempts / tool executions per turn | 4 / 4 |
| Input budget per call / turn | 16,384 / 65,536 |
| Generated tokens per call / turn | 2,048 / 4,096 |

Daily input/output budgets are the admitted daily turns multiplied by the admitted
per-turn bounds. Failed and cancelled attempts still consume applicable token
budgets. The authenticated overview reports no remaining free allowance when either the
turn allowance or the daily token budget is exhausted.

Input reservations use the UTF-8 size of the complete model context plus a protocol
margin as a conservative upper estimate for unknown provider tokenizers. This
includes system instructions, tool schemas and history, not just the question.
Actual reported usage reconciles the reservation. Providers must still enforce
the approved free/overage boundary; this estimate cannot establish their billing
terms. The initial 12,000 input bound was rejected by an actual synthetic end-to-end
turn whose full context required 13,979 budget units; the verified initial bound is
16,384. Large contexts are rejected rather than silently truncated.

## Per-call enforcement and finalization

PostgreSQL owns allowance, quota, model/tool-call and execution state. The shared
`claim_benefit_attempt` function serializes project budgets and node recovery leases
before contacting a provider. RPM/TPM windows and provider-timezone daily windows
are shared by all resident processes and monitoring calls. This uses the existing
shared database boundary rather than a transaction spanning PostgreSQL and Redis.

The runtime applies these guards to every model call, including failover. SDK
retries and background warming are disabled; free compaction is disabled.
Every tool execution needs its own durable grant. Model attempts have bounded
first-content, idle and total deadlines (20, 30 and 60 seconds), further limited
by the turn deadline. Output allowance shrinks to remaining generation/context
capacity. Exhausted budgets terminate the turn; tools and agent sessions are never
replayed. Switching after content publication remains prohibited.

Reported usage settles exactly once. Unknown usage retains its conservative
reservation until the corresponding quota window expires; it is not recorded as
zero. Short upstream rate limits pause the quota group for its retry interval.
An explicitly reported daily limit pauses it until its configured reset. Keys
inside that group cannot restore its capacity.

Final reply persistence and personal allowance settlement share the durable result
delivery transaction. A complete answer consumes one turn. A provider/platform
failure refunds the personal turn, including interrupted partial answers, without
refunding spent upstream budgets. User cancellation consumes a turn after answer
text has been published, and otherwise releases it. Duplicate results and recovery
cannot settle twice. Running/ambiguous requests are not resubmitted after a crash.
Free requests bypass paid wallet admission; wallet debt does not block them.

Account deletion removes personal preferences, daily allowances and free requests.
Provider attempts detach from those requests and retain shared quota accounting,
including idempotent settlement of usage reported after deletion. Deleting an
account does not refund provider requests or discard monitoring attempts.

## Status and validation

The public status endpoint returns separate paid/free sections without exposing
node/provider identities or personal allowance. Existing top-level fields still
describe paid service. Free health observations and supply are distinct:
disabled, busy and quota-exhausted supply do not become a paid outage. Recent real
free successes can confirm health; sampled histories remain independent.

Synthetic checks retain shared six-hour schedules, tiny prompts and finite budgets.
Free checks claim the same upstream allowance and are capped at four attempts
per provider quota group per provider day. Refreshing a page never runs inference.
Exhausted groups skip checks. Stale health and stale cached supply become unknown.

PostgreSQL integration checks cover pool isolation, final-turn contention, shared
upstream budgets, uncertain usage, transactional/idempotent finalization, active
session selection fencing, cancellation, tool limits and monitoring budgets. A
real local synthetic stream verifies output/model-call guards and excludes paid
fallback. Historical upgrade and fresh-baseline paths converge on the same schema
and deterministic seeds.

Browser validation uses the application's actual built pages, a disposable
PostgreSQL/Redis environment and a local synthetic provider. Three successful
free turns persisted, exhausted the allowance and produced no wallet transaction
or paid-provider call. An overdrawn synthetic account could use its remaining
free allowance. Source supplier permissions, real availability and production deployment
remain **unverified**; operator credentials have not been configured by this work.

The detailed [design decisions](benefit-model-pool-design.md) are background.

The final October 16, 2026 check passed 792 automated tests; 40 opt-in integration
checks without their external fixtures were skipped. API/runtime compilation and
both Next.js production exports passed. API lint reported zero errors and 103
existing-style warnings. The actual 360px conversation layout had no horizontal
overflow, and the final built application completed a fresh synthetic free turn.
Public refreshes after setting the synthetic provider's daily cap to its used
count displayed shared exhaustion and did not increase its four free calls;
its paid-call count and wallet transaction count remained zero.
