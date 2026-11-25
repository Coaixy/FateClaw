# Public service status

The user site exposes `/status` without requiring login or accepting the AI-use
notice. The sidebar links to this page on desktop and mobile. It displays network
reachability and latency for the paid and free pools, with independent seven-day
histories, alongside platform Token growth. Neither the page nor the API lists
node identities, node counts, models, providers, endpoints, credentials or
provider error messages.

## Probe budget and scheduling

The full API startup runs one shared check per pool no sooner than every six
hours. PostgreSQL reserves the next interval before probing, so additional
processes, restarts and failed checks cannot create immediate retries. A
five-minute local timer checks the shared due time. The API-only development
entry serves existing observations.

A check uses the enabled, configured nodes for its pool and sends an HTTP
`HEAD` request to each distinct origin (scheme, host and port), in pool order,
until one responds. It sends no credentials, routing session, body or model
request and does not follow redirects. Any HTTP response, including 400, 429
and 5xx, establishes reachability. Each attempt has an eight-second timeout. The
whole check has a three-minute budget and a five-minute fenced result lease.

Network checks run independently of free allocation and node cooldowns. They
consume no inference quota and make no changes to routing or cooldown state.

## Public results

`GET /api/service-status` only reads saved observations. Page visits, manual refresh
and the page's one-minute visible-tab refresh never trigger a probe. Each API
instance shares one successful response for 60 seconds and coalesces concurrent
cache misses into one batch of four database queries. Query parameters and
authorization headers do not create separate snapshots. Failed reads are not
cached, and an expired snapshot is not served as a new observation.

GET and HEAD requests share a Redis-backed limit of 60 requests per client IP per
minute, applied before reading even a cached response. A refused request returns
429 with `Retry-After`; an unavailable limiter returns 503. Failed and refused
responses use `no-store`.

Successful responses allow public HTTP caching for the snapshot's remaining
60-second lifetime, followed by a 60-second stale-while-revalidate window. Cache
hits preserve observation times and do not renew that lifetime. The route removes
the global API's conflicting private cache headers and user-specific `Vary`
dimensions while retaining origin and representation negotiation.

The response identifies the measurement with `probe_kind: "http_head"`. Results contain `status`,
`checked_at`, `latency_ms`, `check_interval_seconds`, `stale_after_seconds` and up to
28 public history samples. These legacy top-level fields continue to describe paid
service. The additional `services` collection contains the independently scoped
paid and free sections. History starts at the first network check. Previous
inference observations age out under the existing seven-day retention rule.

The additional `token_usage` contains `total_tokens`, `today_tokens`, `updated_at`
and seven ascending `daily` points shaped as `{ date, tokens }`. It sums the
canonical recorded `daily_usage.total_tokens` across all accounts in one database
statement, includes zero-usage days and uses UTC dates, matching the existing
usage recorder. Stored totals remain authoritative even when they differ from the
input/output split. All-time totals include records older than the weekly window;
they reflect retained usage and can decrease when usage records are removed.
The public projection contains no account identifiers, message counts, balances
or per-user usage. It shares the existing status cache, rate limit and read-failure
handling.

The page presents an animated cumulative counter, today's increase, seven-day
growth and a seven-day daily average. Paid and free service cards precede the
counter, each showing current reachability, measured latency and seven days of
check records. Individual records expose their observation time and result on
hover. Counter animation
spreads recorded increments across ninety seconds and continues from its current
value when the next minute's snapshot arrives. On first load it starts at the
recorded beginning-of-day total. The exact recorded total is available on hover
and to assistive technology; the moving display can lag it and never extrapolates
beyond it. Reduced-motion
preferences and hidden tabs finish the animation immediately. A failed refresh
preserves the previous totals with an awaiting-sync indicator and a notice; an
initial failure shows an unavailable value rather than zero usage.

- `operational` means at least one origin returned HTTP response headers.
- `unavailable` means every tested origin timed out or failed to connect.
- `unknown` covers missing observations, pools without a usable target,
  interrupted checks and results older than twelve hours.

Latency measures elapsed time from the FateClaw backend to the upstream HTTP
response headers, including connection setup when needed. Model authorization,
inference and agent tools have their own availability. The history shows one
sampled result per six-hour window, with unknown status for missing windows.

Free `supply` independently reports `available`, `busy`, `exhausted`,
`disabled`, or `unknown`. `supply_checked_at` dates the capacity read. The client
expires capacity evidence after ten minutes and network observations after twelve
hours. Anonymous supply describes shared capacity.
See [Free model service](benefit-model-pool.md) for admission and quota ownership.

A failed status read leaves previously fetched records visible with a notice;
the client independently expires their current state. Late results from a lost
lease and duplicate result deliveries cannot overwrite a newer check. Shutdown
cancels an active probe and does not start another one while waiting for a claim.

## Validation

Tests exercise first-response short-circuiting, all-candidate failure,
cancellation, shutdown during claim, overlapping ticks, stale-result handling,
public field whitelisting and anonymous read-only access. Local HTTP servers
exercise error responses, redirect handling and timeouts. Disposable PostgreSQL
checks concurrent ownership, the persisted six-hour interval, result fencing
and exclusion of previous inference observations.
PostgreSQL coverage also checks cross-account Token sums beyond 32-bit integers,
the UTC chart window, zero-filled days and empty usage.
