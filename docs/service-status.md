# Public service status

The user site exposes `/status` without requiring login or accepting the AI-use
notice. The sidebar links to this page on desktop and mobile. It displays one
aggregate AI service state, the last check time, measured response latency and
seven days of sampled history. It never lists node identities, node counts,
models, providers, endpoints, credentials or provider error messages.

## Probe budget and scheduling

The full API startup runs one shared check no sooner than every six hours. A
PostgreSQL singleton reserves the next interval before probing; additional
processes, restarts and failed checks cannot create immediate retries. A five-minute
local timer only checks the shared due time. The API-only development entry does
not start background probes.

A check uses the canonical official model runtime snapshot. It tries enabled,
configured nodes sequentially and stops after the first valid response. The request
contains only `Reply OK.`, no conversation history or tools, and a maximum of 16
output tokens. It stops reading after the first text/thinking delta or a valid
completion. SDK retries are disabled. Each attempt has an eight-second timeout;
the whole check has a three-minute budget and a five-minute fenced result lease.
A healthy first candidate therefore needs four tiny requests per day. Failed
candidates can require additional attempts in that check. These are platform
monitoring calls and do not use user wallets or agent-session execution.

The monitor does not update model-pool routing/circuit state. Its small probe has
a different purpose and token allowance from a real chat turn.

## Public results

`GET /api/service-status` only reads saved observations. Page visits, manual refresh
and the page's five-minute visible-tab refresh never trigger inference. The endpoint
allows public HTTP caching for 60 seconds. Results contain only `status`,
`checked_at`, `latency_ms`, `check_interval_seconds`, `stale_after_seconds` and up to
28 public history samples. Seven-day retention is pruned with successful result
persistence.

- `operational`: at least one candidate returned a valid generated response.
- `unavailable`: no configured candidate is available, or every candidate failed.
- `unknown`: no result yet, an interrupted/incomplete check, or a result older than
  twelve hours. Stale results never retain a green current status or current latency.

Latency measures the successful lightweight probe's first response, including
connection setup. It does not represent a full answer, a browser-to-server ping or
agent/tool availability. The history shows one sampled result per six-hour window;
missing windows remain unknown. The displayed pass percentage uses observed checks,
not continuous uptime or an SLA.

A failed status read leaves previously fetched records visible with a notice;
the client independently expires their current state. Late results from a lost
lease and duplicate result deliveries cannot overwrite a newer check. Shutdown
cancels an active probe and does not start another one while waiting for a claim.

## Validation

Tests exercise first-success short-circuiting, all-candidate failure, cancellation,
shutdown during claim, overlapping ticks, stale-result handling, public field
whitelisting and anonymous read-only access. Local synthetic HTTP providers cover
all four configured protocols, the output bound and timeout/retry limits. Disposable
PostgreSQL checks concurrent ownership, the persisted six-hour interval, result
fencing and bounded history. Real-provider connectivity and production deployment
require separate operational verification.
