# Free model pool design

Status: Historical design, implemented October 16, 2026. The current operating
contract is [Free model service](benefit-model-pool.md). Manual upstream quota groups,
provider limits, approvals and reset settings described below were removed on
October 17, 2026. Node cooldowns now follow provider errors and retry hints; the
historical quota-ledger design is superseded. Free-only input/output budgets,
model/tool-call limits, queue bounds and shorter deadlines were also removed on
October 17. The current free policy contains only `daily_turns` and
`concurrency_limit`; one active request per user and shared runtime rules still
apply. Capability-tier descriptions below have been updated to the current UI
copy. Other historical policy and quota proposals are not current requirements.

## Outcome and acceptance

FateClaw will offer a daily free AI service supplied by approved free API capacity.
Users choose between **免费模型** and **付费模型**.
Administrators configure these services on separate pages. The public status page
reports their availability separately.

Success means that a logged-in user can complete a bounded free turn without a
wallet charge, concurrent submissions cannot overspend the allowance, exhausted
upstream capacity stops new calls, and no failure or recovery changes a free
request into a paid request. The UI explains the service level before submission.

The first release covers on-site ordinary chat, pasted boards and simple-mode
interpretation through the existing shared turn admission. Deterministic charting
continues to work without spending a free AI turn. Open API and WeChat do not offer
free execution in this release.

## Current source and constraints

- [Official pool](official-model-pool.md): one public alias, shared prices,
  weighted multi-node routing, shared circuit state, and switching before content.
- [Runtime selection](../apps/api/src/modules/system/system-config.ts): current
  platform requests resolve to `source: 'official'`, `billingMode: 'metered'`.
  Configuration travels through the existing request-level `llmRuntime` snapshot.
- [Turn admission](../apps/api/src/modules/chat/chat-session-service.ts): the wallet
  arrears check currently runs before runtime selection for all on-site AI turns.
- [Billing](../apps/api/src/modules/billing/plans.ts): non-metered requests skip
  wallet reservation/settlement. A metered platform model with both prices at zero
  is rejected as misconfigured.
- [Status](service-status.md): the local worker ticks every five minutes, while
  PostgreSQL permits a real shared probe only every six hours. Public reads do not
  trigger inference. Results become unknown after twelve hours.
- Current service-status storage has one `ai` schedule and history. The admin
  model form and public model-settings contract expose one pool.
- [The current composer](../apps/web/components/ai-chat/ai-chat-composer.tsx)
  renders chart insertion, message input and send/stop actions, with no model
  picker. The current model-settings panel displays one platform model. A model
  switcher on another deployed version is **unverified**; this proposal does not
  assume an existing selector component in this checkout.

These observations come from source inspection. Real-provider availability,
account entitlements, quotas and production behavior are **unverified**.

## User experience

The existing warm canvas, terracotta accent, Chinese typography and shared
components remain the visual system. Labels communicate the service and cost;
there are no invented intelligence scores or guarantees of correctness.

| Location | Proposed Chinese copy and behavior |
| --- | --- |
| Free choice | A compact **免费模型 ▾** control beside the composer actions; 今日剩余 3 次 alongside it. |
| Free explanation | 免费使用，不扣积分，仅限制每日次数与并发。 |
| Free cost notice | 本次使用免费额度，不扣积分。额度用完或服务不可用时会停止，不会自动切换为付费。 |
| Paid choice | **付费模型** / 按实际 Token 用量和当前账户单价计费。 |
| Paid submit | Keep the existing **发送** action; show the admitted input/output prices and applicable member pricing beside the model control before submission. |
| Free submit | Keep the existing **发送** action; the control shows the remaining turns, with reset time in its expanded menu. |
| Personal allowance exhausted | 今日免费次数已用完，明日 00:00 恢复。 / 查看付费模型 |
| Shared upstream allowance exhausted | 本轮免费额度已用完，供应恢复后可继续使用。 / 查看服务状态 |
| Pool busy or request expired | 免费服务繁忙，请稍后重试。本次未扣免费次数。 |
| Provider failure | 免费服务暂不可用，请稍后重试。本次免费次数已返还。 |
| Partial answer interrupted | 本次回答中断，免费次数已返还。已生成内容可保留查看。 |
| Context does not fit | 当前对话超出所选模型的上下文范围，请精简内容或新建对话。 |

Use one compact shared model selector in the composer toolbar. It is available
before typing and after typing; submitting uses the current selection immediately.
The new-conversation flow keeps its existing chart/plain-question choices. There
is no separate model-selection page, choice-card section, post-input dialog or
required selection step for each message.

The expanded selector contains the free and paid options, each with a short
cost/limit description and its relevant allowance or prices. Its collapsed
state shows the chosen service and a brief persistent line: `剩余 3 次 · 不扣积分`.
Full explanations belong in the menu and settings. Show a larger inline notice
only for actionable exhaustion, failure, context mismatch or a changed service
policy; do not keep a promotional/educational banner above every message input.
Message metadata identifies the service, and free messages show
`免费额度 · 未扣积分` rather than ordinary paid prices.

| Entry | Shared selector behavior |
| --- | --- |
| Home and `/ai-chat` | Both use the same workspace/composer control; creating a chat adds no model-choice step. |
| Existing conversation | Show its selected pool in the composer; switching applies to subsequent turns. |
| Deterministic chart preview/commit | No model control is needed for calculation or chart insertion. The resulting conversation inherits the selected/default pool before its first AI message. |
| Pasted-board interpretation | This submission calls AI directly. Reuse the same control next to its submit action and bind it to the owning session/draft selection; opening the sheet does not reset the choice. |
| Simple-mode AI interpretation | Inherit the same selection through shared turn admission; use the shared control only where this flow actually submits an AI request. |
| Client-profile entry into chat | Carry the user's new-conversation default to the destination, without adding another selection step to the profile form. |
| Model settings | Show the same service descriptions/default preference, not an independently maintained choice. |

The user's last explicit selection supplies the default for new conversations;
the server owns this preference. An existing session owns its own selected pool.
The shared control resolves that session selection when present, otherwise the
new-conversation preference. A deliberate session switch can update the session
and the new-conversation default in one transaction, but changing a default never
rewrites unrelated or running sessions. Local UI state is a draft, not another
authoritative preference store. All entry points use the same owner and contract.

Existing conversations keep their selected pool. Without a remembered explicit
preference, new conversations initially select paid models, whether or not the
free service is enabled. The selector lists paid models first and free models
second. A remembered choice takes precedence. If the selected free service is
temporarily unavailable, it stays visible and disabled with its reason; switching
to paid execution requires an explicit selection followed by a paid submit.

The selected pool belongs to the server-side session. Changing it affects future
turns only and is rejected while a turn is active. Each admitted turn records its
own pool and policy version. A switch to a smaller context validates the complete
request, including system instructions, boards, skills and tool results; it cannot
silently discard relevant content. Anonymous public status omits personal usage.

## Separate administration

Keep `/system/models` as the paid configuration route and label it **付费模型**.
Add `/system/benefit-models` labeled **免费模型** to the same admin navigation group.
Both routes reuse the node editor, but have independent reads, drafts, validation,
revision checks, save actions, dirty-state prompts and pool-scoped transactions.
Saving either page cannot submit or overwrite the other page's settings.

The paid page retains the public alias, member prices, thinking level and retained
primary-node rules. The free page contains:

1. An enable switch, display name, persistent cost/limit explanation and daily
   allowance policy. Free price is a read-only `免费 / 不扣积分` label.
2. Per-user active-request limit, queue limit/deadline, pool concurrency, context,
   generated-token, model-call and tool-execution bounds.
3. Free nodes and quota groups. Show credential presence, approval state,
   expiry, known/estimated/unknown remaining capacity, cooldown and reset time.
4. Recent turn outcomes, upstream attempts, refunded turns and unknown usage.
   Show diagnostic reason codes; do not show credentials or user prompt content.

An empty or disabled free pool is a valid saved state. Enabling it requires at
least one approved, configured node and a finite policy. A node belongs to exactly
one pool; an active attempt or a queued snapshot cannot migrate between pools.
Edits use revision checking to reject stale drafts. Existing opaque credential
storage remains the only credential source; metadata and new ledgers use references.

## Supply, quota groups and routing

Separate the public service policy from its upstream supply:

| Entity | Durable contract |
| --- | --- |
| Pool | Stable key `official` or `benefit`, enable state, revision, capability floor and policy. Preserve the existing paid public alias. |
| Node | Pool, provider protocol, model, endpoint, opaque credential reference, revision, weight and approval. |
| Quota group | Real provider account/project/organization/model scope, rate limits, daily limits, timezone/reset rule, expiry and no-overage boundary. Nodes may share a group; a call must satisfy every applicable shared limit. |
| Free usage | User, local allowance date, admitted policy, reserved/used turns and daily token budget. |
| Model preference | User's last explicit pool choice for new conversations; existing sessions retain their scoped selection. |
| Free reservation | Unique request ID, session/user, quota date, immutable limits and durable lifecycle state. |
| Upstream attempt | Unique request/call/attempt identity, node and quota-group references, reservations, dispatch marker, outcome, actual usage or explicit unknown usage. |

Generalize the existing single-pool configuration and its locking boundary. Do
not add a second gateway, credential path or independent runtime configuration.
Both pools use `source: 'official'`; the free pool uses `billingMode: 'none'` plus a
required free reservation. `none` alone is not authorization to run free requests.
Public pool availability and allowance fields never contain connection details.

At admission, resolve the selected pool before applying its gates. Paid requests
retain wallet admission and request-time prices. Free requests require login,
an enabled policy and a free reservation; wallet debt does not block free requests.
The snapshot includes pool key/revision, capability limits, free reservation ID
and policy version. Queued persistence omits credentials, and recovery only
rehydrates unchanged permitted nodes, following the established recovery path.

For every model call:

1. Filter to its admitted pool and approved nodes satisfying the full capability,
   context, data-use, expiry and no-overage contract.
2. Use the existing weighted ordering after eligibility filtering; every admitted
   node must support the common capacity contract.
3. Fence node health and reserve short-window/daily quota in one PostgreSQL
   transaction before dispatch. Every dispatch also requires an active durable
   free request and its execution slot. All callers use one quota-ledger owner
   with consistent lock ordering; check-then-increment in separate code paths is
   prohibited. Redis keeps transport and global scheduling, without a transaction
   spanning Redis and PostgreSQL.
4. Reserve the provider-defined token budget, including reasoning output where
   applicable. Reconcile using headers or authoritative usage when supplied.
   Estimated local counters are not authoritative provider balances.
5. Retry only before content publication, within a bounded attempt count and
   remaining turn budget. A retry consumes another upstream request allocation.
   Agent tools and whole sessions are never replayed as failover.

Distinguish short rate limiting, daily exhaustion, authorization failure and
transport failure. Honor trustworthy provider reset/retry hints. Daily exhaustion
blocks the whole affected quota group until its reset; rotating keys inside that
group cannot restore capacity. A platform admission rejection is not evidence of
an unhealthy provider. Multiple nodes sharing a quota cannot receive independent
copies of that capacity.

Approved supply must permit this application and user regions, and its data terms
must allow the full submitted context. A provider that forbids personal data is
ineligible for personal consultations; a consent checkbox cannot change that
restriction. Trial credits and automatic paid overage require a provider-enforced
hard stop to enter the initial free-only supply pool. A soft budget alert or a
locally estimated remainder does not establish zero supplier charges.

Relevant primary references, consulted October 16, 2026:

- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits): project-level limits and provider-specific reset rules.
- [Groq rate limits](https://console.groq.com/docs/rate-limits): organization-level limits and response-header semantics.
- [OpenRouter limits](https://openrouter.ai/docs/api/reference/limits): additional accounts/keys do not independently multiply capacity.
- [Gemini terms](https://ai.google.dev/gemini-api/terms): unpaid-service data restrictions and available-region requirements.

## Accounting, concurrency and recovery

PostgreSQL owns personal allowances, short-window/daily upstream budgets, request
reservations and attempt outcomes. Redis handles transport and existing global
concurrency leases. Losing Redis cannot reset quota usage or bypass the durable
active-session fence; ambiguous execution is never replayed.

Create the free reservation and durable request intent in one transaction under
the user's allowance-row lock. Use the request ID as an idempotency key. Dispatch
then follows the existing durable request/outbox path. Reserving one personal turn
does not reserve an upstream request for every possible agent step in advance.

The personal reservation lifecycle is `reserved -> running -> consumed | released`.
State transitions are conditional and idempotent. A complete answer consumes one
turn. An upstream/platform failure releases the turn, including when partial text
was shown. Cancellation before dispatch releases it; cancellation after answer
text has been published consumes it. Daily token/attempt abuse limits still account
for failed and cancelled work, so repeated partial failures do not provide unlimited
capacity. Personal refunds never restore already-used upstream capacity.

A dispatched upstream attempt is `settled` with authoritative usage, or
`usage_unknown` when dispatch/usage cannot be confirmed. Unknown usage retains a
conservative reservation until its applicable quota window expires or authoritative
reconciliation resolves it. Do not retry an ambiguous dispatched attempt after a
process crash. Do not release a running turn merely because a wall-clock lease
expires: first fence/confirm the durable request terminal state. Only queued,
never-dispatched work can resume through existing recovery.

Persist the reply and terminal free settlement at the owning result boundary
before reporting completion. They must share a transaction, or use a required
durable reconciliation record where the current result boundary cannot share one.
Unexpected settlement failure fails/retries finalization; it cannot silently mark
the request complete. UI notifications are best-effort after durable state.

## Initial policy

These are starting limits for a small rollout, subject to real supply validation.
They are configuration defaults, not promises of provider capacity.

| Limit | Initial value |
| --- | --- |
| Feature state on migration | Disabled, with no prepopulated suppliers |
| Personal turns | Configurable; source default 3 per active member per day, no carryover, Asia/Shanghai midnight |
| Personal daily input/output budget | 196,608 input and 12,288 generated tokens, including attributable failed/cancelled work |
| Active free requests per user | 1, including queueing |
| Pool concurrency | 2, also subject to the existing global concurrency ceiling |
| Queue | FIFO, at most 20 waiters and 30 seconds waiting |
| Execution deadline | 180 seconds after queue admission; every external/tool wait is cancellable and bounded |
| Input per model call | 16,384 conservative input budget units including complete runtime context; no silent truncation |
| Per-turn aggregate input/output | 65,536 input and 4,096 generated tokens across attempts and agent steps |
| Output per model call | At most 2,048 generated tokens, further reduced to the remaining turn budget |
| Model attempts / tool executions | At most 4 each per turn; model attempts include failover and provider retries |
| Provider attempt | At most 20 seconds to first content, 30 seconds idle and 60 seconds total, bounded by the remaining turn deadline |

Provider SDK retries and background model calls must be disabled or pass through
the same budget owner. The runtime enforces aggregate bounds before further calls
and tools; a UI limit is insufficient. An incomplete answer caused by a limit is
reported as such and settled under the failure policy, not advertised as complete.

Global/pool execution slots are acquired only for execution, never while sleeping
for a long upstream reset. Queue expiry releases personal reservations. Free traffic
has its own cap so it cannot fill the global pool. Daily personal quotas use
Asia/Shanghai; upstream quota windows use the provider's actual rule and timezone.
Requests crossing midnight retain their admitted allowance date.

## Public status

Display **付费模型服务** and **免费模型服务** as peer sections, each with its own
observation time and sampled history. The initial free section can display
`暂未开放`. Personal remaining turns appear only in authenticated product UI.

Keep service health separate from supply admission:

| Layer | Values and meaning |
| --- | --- |
| Health | `operational`, `unavailable`, `unknown`; describes observed model reachability, not answer quality. |
| Supply | `available`, `busy`, `exhausted`, `disabled`, `unknown`; describes capacity for new turns. |
| Public label | 正常供应 / 服务繁忙 / 免费额度已用完 / 暂未开放 / 暂不可用 / 状态待确认, derived from fresh observations and admission state. |

Precedence is disabled, known exhausted, fresh service outage, busy, fresh available,
then unknown. Exhaustion and provider errors update the affected pool's supply
state at the admission/attempt boundary; page rendering cannot infer health from
an empty wallet or from an enabled node alone. Individual-user exhaustion never
changes the anonymous pool status. Show a restoration estimate only when supported
by an authoritative reset or a conservative known bound; otherwise show no ETA.

Maintain independent fenced schedules and history by pool. Preserve the existing
paid history and its public read contract; add a `services` collection for the two
pool sections and update all in-repository consumers together. The existing
top-level status/history fields continue to describe the paid service during this
additive transition. Do not backfill pre-launch free history as healthy or fold
quota exhaustion into a paid availability sample.

Use six-hour shared synthetic probes with the existing timeout and output bounds,
plus recent successful real-call observations for current status. A free probe
uses the same upstream quota owner and a bounded monitoring allowance: at most
four attempted probe calls per day per quota group, within its total free budget.
Skip disabled/exhausted groups and stop on first success. Record an unknown probe
result if the monitoring allowance cannot support a check; quota exhaustion remains
its separate supply condition. No synthetic probe creates a user turn or wallet
charge. Public reads/refreshes cannot dispatch probes. Independent observations
expire to unknown; a tiny `OK` probe does not prove tool competence.

Expose only whitelisted status, reason codes, observation times, sampled history
and supported reset estimates. Providers, models, node counts, group identifiers,
endpoints, credentials and detailed errors stay admin-only. The page does not claim
continuous uptime from sampled records. Public caching must not cache personal data.

## Implementation sequence and validation

1. Extend contracts and schema for pool identity, pool-scoped configuration and
   history, quota ownership and durable free allowances. Preserve old paid data, prices,
   primary-node identity, and historical billing/recovery snapshots. Free starts
   disabled; rollback disables new free admission and finishes admitted work.
2. Add the shared admission/accounting owner and per-call runtime guards. Integrate
   cancellation, timeout, outbox finalization and recovery before exposing controls.
3. Add independent admin routes/forms and quota-group diagnostics. Enabling validates
   approval, enforceable free boundaries and finite execution policy.
4. Add one shared compact selector and selection owner for the composer and direct
   AI-submit surfaces, with remembered defaults, concise Chinese explanations,
   quota states, message attribution and translated equivalents. Deterministic
   charting and the existing new-conversation flow do not gain a selection step.
5. Add pool-scoped status observations, aggregation and the two public sections.
   Update current topic docs only after the behavior is implemented.

Retain focused tests only for distinct regression risks. Required evidence:

- An existing paid turn uses the same wallet gate, price snapshot, failover and
  settlement before/after migration. Historical snapshots still recover.
- Two simultaneous admissions for the final personal turn produce one reservation.
  Duplicate sends, results, cancellations and recoveries never double settle.
- Two nodes sharing the last upstream allowance cannot both dispatch. Redis loss,
  expired/unknown reservations and cross-midnight requests do not reset daily usage.
- Provider retries, failed attempts, probes, thinking output and agent steps all
  consume the appropriate budgets. Exhausted/expired groups stop before dispatch.
- Partial streams and already-executed tools are never replayed. The hard deadline
  and call/tool/token bounds work against a synthetic streaming provider.
- A free request never charges a wallet, requires a funded wallet, or contacts a
  paid node, including recovery, configuration changes and all-exhausted failures.
- Saving one admin page preserves the other pool byte-for-byte; stale forms fail
  visibly. Credential values never appear in snapshots, logs or metadata responses.
- Status samples, leases, stale handling and histories remain pool-scoped. Public
  refreshes do not call a provider. Exhaustion is not an outage, and unknown stays
  unknown. Public DTOs omit operator/private fields.
- Browser inspection at 360px and desktop covers selection, disabled/exhausted/
  busy/error/unknown states, visible pricing, separate save actions, keyboard access,
  mobile navigation, dark appearance and long Chinese copy.
- Typing, changing the model and submitting preserve the same message draft. A
  remembered choice works across new-conversation entry points, current-session
  sheets share their session selection, and unrelated/running sessions retain
  their own pool. No page introduces a second mandatory selector or selects a
  model after the user has already submitted the question.

Implementation preserves the existing page layout and start flow. Per-call short
windows and daily quota accounting share PostgreSQL's atomic owner; Redis keeps
its existing request transport and global scheduling role. The initial context
bound was increased after the actual application rejected a basic synthetic turn
whose complete input budget measured 13,979. The operating document records the
implemented contract and validation. Real supplier permissions, free capacity and
model quality must be verified before activation; production was not modified.

## Design artifact verification

The accompanying interactive mockup uses synthetic data and local state only.
The compact selector replaces the model-choice cards and permanent explanation
banner. Its menu is available directly from the composer before submission.
The revised prototype was checked on desktop and at 320px: changing the selected
service preserves the typed question, the menu closes after selection, the mobile
menu expands without clipping its options, and allowance exhaustion keeps free
selected with sending disabled. Cross-page server preference persistence remains
an implementation acceptance criterion, not a behavior verified by this mockup.
Browser checks confirmed decrement-to-zero without automatic paid selection,
public availability remaining independent of personal exhaustion, separate paid
and free save actions, a disabled free service on the status page, and
visible applicable prices after an explicit paid selection. Desktop, 360px and
320px layouts were inspected; the two narrow checks showed no horizontal overflow.
The fragment's JavaScript syntax and this document's local source links were also
checked. These checks validate the proposed interaction, not application runtime,
supplier capacity, real billing or the future quota/recovery implementation.
