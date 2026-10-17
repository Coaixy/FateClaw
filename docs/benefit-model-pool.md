# Free model service

FateClaw offers separate paid and free model pools. The free service requires
active membership; paid on-site service remains available without membership.
Both use the existing platform-owned provider adapters, request-level
`llmRuntime` snapshot, resident
agent, durable request recovery and model-call failover. Users choose a service;
they cannot supply providers or credentials. A free request never selects a
paid node or creates a wallet charge.

User-facing labels use **免费模型** and **免费额度**. Internal identifiers,
including the `benefit` pool key and existing API routes, remain unchanged.

## Administration and activation

`/system/models` configures paid models and public prices. `/system/benefit-models`
configures free models and policy. They reuse one node editor but use separate
endpoints, drafts, revision checks and database locks.
Saving a page cannot remove the other pool's nodes. Unsaved edits are guarded on
link navigation, refresh and window close. The paid primary remains protected;
all free nodes may be removed when the free service is disabled.

Free models are **disabled by default**, with no prepopulated suppliers or credentials.
To enable them, configure at least one enabled node with its model, endpoint and
credential, then enable the pool. API keys remain in the existing server credential
source. Metadata, request persistence and usage records never include their values.

Nodes do not require quota groups, provider reset timezones, expiry dates or manually
entered RPM/RPD/TPM/daily token limits. The provider determines available supply.
Local admission enforces daily personal turns and concurrency. Usage records do not
predict or cap a node's remaining upstream capacity.

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

The selector identifies free models as an active-member benefit, offers a
membership link to ineligible users when the service is enabled, and preserves an existing free selection
after expiry so that switching to paid remains an explicit user action.
The user overview reports membership eligibility independently of pool supply;
ineligible users have `eligible: false` and `remaining_turns: null`.
The selector explains that free models have daily turn and concurrency limits and
do not charge credits. It shows remaining turns without a large permanent banner
and labels final replies as free replies. Model capability depends on the configured
nodes; the service does not impose a separate free reasoning or tool-use tier.
Paid choices show the current account's applicable input/output prices, including
the non-member multiplier. Model status refreshes after a turn, on return to the
page and once a minute while visible.

## Durable admission and limits

The API creates the free reservation, durable request intent and user message
in one transaction. That transaction checks current membership using the same
status and period-end rule as the membership service. Missing, expired or cancelled
membership rejects a new request with HTTP 403 without reserving allowance or
persisting a request/message. Membership expiry does not interrupt accepted
requests, including queued requests and durable recovery. Membership sales being
disabled does not revoke an existing active membership. Personal allowance rows
serialize the final available turn across processes. One user can hold one queued/running free request. The pool
has its own execution concurrency cap, also subject to global agent capacity.
Queued free requests use the same finite request lifetime as other model requests.

The administrator can configure only these free-service limits:

| Limit | Default |
| --- | --- |
| Daily personal turns | 3 per active member, no carryover; Asia/Shanghai midnight |
| Free execution slots | 2 |

These are source defaults, not the policy of every deployment. Upgrades preserve
the configured daily turns and concurrency while removing obsolete policy fields.
Membership gating does not change these configured values or grant a trial allowance.
The per-user active-request cap remains one, including queueing.

Deploy the API, agent runtime and admin together. Migration
`0090_benefit_turns_and_concurrency` changes the model-attempt claim signature;
restart resident agents with the new runtime before serving turns. Completed
request snapshots and recorded usage remain intact.

Free requests use the same model execution rules as paid requests: configured node
context windows, the shared output-token policy, automatic history compaction,
and finite model/request/tool timeouts. They have no additional input/output token
budget, model-call or tool-call count limit, queue-size limit, or shorter free-only
deadline. Provider context, rate and quota limits still apply.

## Per-call enforcement and finalization

PostgreSQL owns personal allowance, request execution and node health state.
Atomic attempt claims verify an active request and lease node recovery before
contacting a provider. Calls and monitoring share the same cooldown state across
resident processes. Redis retains its existing transport and global scheduling
roles. Tool execution uses the ordinary agent path without a free-only grant.
Tools and agent sessions are never replayed as failover. Switching after content
publication remains prohibited.

Reported usage settles exactly once for diagnostics; missing usage remains
explicitly unknown and does not create a personal token limit. Upstream rate
limits and exhausted quota cool only the responding node, and failover tries
the other enabled nodes in the same pool.
A valid `Retry-After` interval or HTTP date sets the cooldown, bounded to one second
through 24 hours. Without one, rate limits default to 60 seconds; daily quota,
insufficient balance and exhausted quota default to one hour. Other supplier
failures keep the existing 30-second exponential backoff capped at five minutes.
After cooldown, one leased request or scheduled probe tests recovery; success clears
the cooldown and failure starts another cooldown. Unrelated administration saves
preserve cooldowns. All nodes cooling due to quota report exhausted supply;
other cooldowns or an active recovery lease report busy supply.

The pinned pi-ai 0.86 SDK invokes `onResponse` only after successful SDK requests.
OpenAI and Anthropic adapters therefore capture status and `Retry-After` through
their supported fetch hook before SDK error normalization. The Google Generative AI
adapter rejects a custom fetch hook; its normalized error supplies the failure
classification and default cooldown when no retry header is available.

Free calls use the shared [model-pool diagnostics](official-model-pool.md#routing-and-failures).
Redacted upstream errors, captured HTTP status, node identity and request ID are
available in default-level operator logs and retained conversation traces. An
exhausted pool reports whether nodes were skipped or provider attempts failed;
the public reply keeps the existing free-service failure message.

Final reply persistence and personal allowance settlement share the durable result
delivery transaction. A complete answer consumes one turn. A provider/platform
failure refunds the personal turn, including interrupted partial answers.
User cancellation consumes a turn after answer text has been published, and
otherwise releases it. Duplicate results and recovery cannot settle twice.
Running/ambiguous requests are not resubmitted after a crash.
Free requests bypass paid wallet admission; wallet debt does not block them.

Account deletion removes personal preferences, daily allowances and free requests.
Provider attempts detach from those requests and retain their recorded usage,
including idempotent settlement of usage reported after deletion. Deleting an
account does not discard monitoring attempts or reset node cooldowns.

## Status and validation

The public status endpoint returns separate paid/free sections without exposing
node/provider identities or personal allowance. Existing top-level fields still
describe paid service. Free health observations and supply are distinct:
disabled, busy and quota-exhausted supply do not become a paid outage. Recent real
free successes can confirm health; sampled histories remain independent.

Synthetic checks retain shared six-hour schedules, tiny prompts and finite timeouts.
Free checks use the same node health claim and settlement as real calls.
Refreshing a page never runs inference. Cooling nodes skip checks. Stale health
and stale cached supply become unknown.

PostgreSQL integration checks cover pool isolation, final-turn contention,
membership admission and completion after expiry,
provider cooldowns, single recovery leases, uncertain usage,
transactional/idempotent finalization, active session selection fencing,
cancellation and monitoring cooldowns. Synthetic provider checks exercise free
routing without paid fallback. Historical upgrade and fresh-baseline paths
converge on the same schema and deterministic seeds.

The October 17, 2026 check of the simplified policy passed 842 tests; 25 opt-in
checks without their external fixtures were skipped. Synthetic streams accepted
a system prompt larger than the former input bound, retained the ordinary output
ceiling across five answer calls, and did not dispatch a paid fallback. Tool
execution beyond the former cap, cancellation after a hidden summary, and
preservation of configured limits and completed snapshots during upgrade were
also checked. API, runtime, web and admin type checks passed. Real supplier
execution and production deployment remain **unverified**.

The October 16, 2026 browser validation used the application's built pages, a
disposable PostgreSQL/Redis environment and a local synthetic provider. Three successful
free turns persisted, exhausted the allowance and produced no wallet transaction
or paid-provider call. An overdrawn synthetic account could use its remaining
free allowance. Source supplier permissions, real availability and production deployment
remain **unverified**; operator credentials have not been configured by this work.

The detailed [design decisions](benefit-model-pool-design.md) are background.

The October 16, 2026 check, before removal of manual upstream quotas and extra
free execution limits, passed 792 automated tests; 40 opt-in integration checks
without their external fixtures were skipped. API/runtime compilation and
both Next.js production exports passed. API lint reported zero errors and 103
existing-style warnings. The actual 360px conversation layout had no horizontal
overflow, and the final built application completed a fresh synthetic free turn.
That historical check used the previous local quota counters and execution budgets;
it does not validate the current simplified policy. Automatic node
cooldown and retry hints are covered by the current PostgreSQL/local-provider tests.
The earlier admin simplification was checked on a production export with a
synthetic metadata endpoint: adding and saving a node submitted neither quota
groups nor quota-group references. That browser check preceded removal of the
extra free execution policy fields.
