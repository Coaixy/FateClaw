# Official model pool

The platform exposes one official model alias and one pair of input/output token
prices. Administrators can supply that alias with multiple provider/model nodes,
including different underlying models. Users cannot configure providers or keys.
Users can also select the independently configured [free service](benefit-model-pool.md).
This document describes the paid pool; free limits and accounting are separate.

## Configuration and admission

The pool has one retained primary node and zero or more editable child nodes
(up to 20 nodes in total). The first configuration establishes its first submitted
node as primary. Existing installations retain their previous canonical node;
adding, reordering or deleting child nodes does not change the primary identity.
The primary configuration remains editable, but removing it is rejected by the
writer and a database foreign key. Every child can be removed, leaving the primary
on its own. The admin response identifies this role with read-only `is_primary`.

Pool settings and node changes commit together under a pool-scoped database lock.
Each node has its own protocol, model ID, endpoint, credential reference, enabled
state, context window and positive weight. Credentials remain in `system_secrets`;
metadata responses never include their values. Existing installations initially
enroll only their previously configured model and preserve its alias and prices.

Admission captures every eligible node and the common prices in one database
snapshot. The request uses the smallest context window and output allowance among
enabled, configured nodes so that switching models preserves the capacity contract.
Queued-request persistence omits every node credential; recovery rehydrates only
unchanged node revisions. Running requests are never replayed by recovery.

## Routing and failures

Each model call chooses a node by weighted random selection, without replacement
within that call. Equal weights distribute calls equally in expectation. Database
health state is shared by all resident processes. Disabled, removed, revised or
cooling nodes are skipped. An expired cooldown permits one leased recovery probe.

Provider authentication, quota, transport, timeout and server failures open a
30-second cooldown, doubling on consecutive failed probes up to five minutes.
Successful probes restore normal routing. Responses from an older configuration
or health generation cannot overwrite newer health state.

Failover is confined to one model call and only occurs before response content is
published. It never replays an agent session or already executed tools. Once text,
thinking or tool-call content has been published, a failed stream terminates that
call rather than mixing two model responses. Cancellation never triggers failover.
Input/context errors do not mark a provider unhealthy. Each node is attempted at
most once per call, with a 45-second first-content timeout, 60-second stream-idle
timeout and 180-second total attempt limit. Recovery-probe leases expire after
200 seconds. Health-result writes are best-effort and emit a trace event on failure;
a claim is required before contacting a node. If every
node is unavailable, the request fails explicitly.

The pool keeps the request's admitted public prices through switching and
recovery. Reported usage from failed attempts is included in settlement. Usage a
provider does not report remains unknown. Trace events identify attempted nodes
and outcomes without connection details or credentials. Failed attempts record
the protocol, provider key, model, HTTP status when captured, duration, whether
content was published, retry eligibility and a bounded, redacted upstream error.
Transport error causes are captured before SDK normalization. Warnings and errors
retain their severity as separate structured host logs at the default log level;
routine traces remain at debug. Every request-scoped diagnostic carries its
request ID and is also retained in the conversation trace.

A skipped node emits `model_pool_node_skipped` with `claim_denied`; the claim
contract does not distinguish cooldown, revision changes or other admission
conditions. `model_pool_exhausted` lists attempted and skipped node IDs and
distinguishes `no_claimable_nodes` from `all_attempts_failed`. Infrastructure
failures identify the execution phase and safe error codes without database
messages or row values. Public failure messages remain independent of these
operator diagnostics.

## Public failure reporting

Model-call failures carry an allowlisted `modelFailure.kinds` value alongside
Pi's readable `errorMessage`. The session preserves these categories in a typed
error, and the request boundary emits `publicErrorText` and `publicReasonCode`.
The web client displays that public text directly; it must not infer a cause
again from translated copy. Categories and copy are shared by the runtime and
API in `packages/contracts/src/model-settings/failure.ts`.

Public messages distinguish upstream authentication, permissions, quota,
shared-pool rate limits, model/endpoint availability, overload, timeouts,
network failures, context size, content filtering, incompatible requests,
empty responses and interrupted responses. Specific provider error types and
details take precedence over HTTP status: a 429 can report insufficient quota,
and a 403 can explicitly report content filtering. A bare 403 does not establish
that content was filtered. A reference to `token` alone does not establish that
the context is too long. Error shapes follow the supplier references for
[OpenRouter](https://openrouter.ai/docs/api-reference/errors-and-debugging),
[Claude](https://platform.claude.com/docs/en/api/errors) and
[Gemini](https://ai.google.dev/gemini-api/docs/troubleshooting).

When routing exhausts its candidates, the pool retains every distinct category
and reports mixed causes together. When no node can be claimed, it reports only
that no channel is available, without guessing whether cooldown or another
claim condition caused it. Unknown upstream failures and infrastructure
failures remain distinct. Public messages contain fixed explanations and next
steps, never provider payloads, credentials or connection URLs. Free-service
messages may offer switching to the official model; upstream account or
configuration problems direct users to an administrator. They do not ask users
to recharge their FateClaw balance or supply provider credentials.

## Validation

Regression checks cover retained primary membership, editable children,
mixed-model configuration, atomic updates, weighted
selection, cross-process cooldown/probe ownership, failover before content,
non-replay after content or cancellation, usage aggregation, credential omission
and queued recovery. Transport checks use local synthetic providers; database
checks use disposable PostgreSQL. Real supplier availability and production
deployment require separate operational verification.
