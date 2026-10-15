# Membership identity, entitlements and billing

This document describes the current implementation. Historical plans under `archive/` are not current contracts.

## Identity and display name

The system has one membership identity: `membership`. Its constants and literal type are owned by [the shared membership contract](../packages/contracts/src/membership/index.ts).

`membership_config.id` and `user_memberships.plan_key` use this identity. Database checks reject other identities, and the existing primary key permits at most one membership row per user. HTTP inputs accept only this identity; omitted `plan_key` in a subscription request selects the same membership. There are no tier ranks, minimum-tier comparisons, legacy aliases or unknown-key normalization.

The default UI name is **卦师使用权**. A configured `membership_config.name` takes precedence. The membership name does not determine permissions.

[Migration 0082](../apps/api/src/infrastructure/migrations/versions/0082-unify-membership-identity.ts) renames the stored identity in place and changes the old built-in display name to the default name. Configured prices, sale status, custom names, membership status, period boundaries, timestamps and balances are preserved. Historical wallet records and billing snapshots retain their original audit data. Purchase deduplication is scoped to the user and does not depend on an old plan identifier in wallet metadata.

Deploy the API and both web clients together: old identifiers are rejected by current HTTP inputs. Published migration SQL and archived plans remain frozen; runtime code does not translate old identifiers.

## Entitlements

[The runtime entitlement snapshot](../apps/api/src/modules/billing/entitlements.ts) owns the request's membership state and capabilities:

- `membershipActive`: whether the user has an active membership.
- `hasPriorityQueue`: equals `membershipActive`.
- `canUseWechatClaw`: always false while the centralized feature switch is disabled.
- `wallet`: purchased, bonus, reserved and available coins, plus the arrears flag.

| Capability | Non-member | Active member |
| --- | --- | --- |
| On-site deterministic charting | Available without model billing | Same |
| On-site AI interpretation and follow-up | Available; platform model token prices are multiplied by 1.5 | Available at the configured member prices |
| Global execution queue | Standard queue | Priority queue |
| Create an Open API key | Forbidden | Allowed |
| Use an existing valid Open API key | Allowed while not in arrears; AI uses non-member pricing | Allowed while not in arrears; AI uses member pricing |
| WeChat Claw | Disabled | Disabled |

Membership includes no free AI usage. Subscription fees and model usage are charged separately. Disabling membership sales does not revoke an existing user's membership.

## Request gates and billing

All on-site AI entry points converge on `prepareOwnedChatSessionTurn()` in [chat-session-service.ts](../apps/api/src/modules/chat/chat-session-service.ts). Its billing gate rejects an overdrawn wallet with HTTP 402; membership is not required to send a request.

[API key creation](../apps/api/src/interfaces/http/api-keys-routes.ts) requires active membership. [API key authentication](../apps/api/src/interfaces/http/api-key-auth.ts) validates the key and its expiry, applies the per-key rate limit, and rejects an overdrawn wallet. Membership expiry alone does not revoke a previously issued key.

[The IPC worker](../apps/api/src/runtime/ipc-worker.ts) applies non-member pricing to the request's platform model snapshot. That snapshot supplies token prices to reservation, settlement and recovery, so all three paths use the same request-time prices. Model usage is charged in full according to actual tokens. Historical custom-model snapshots are still understood by billing recovery; current requests use the [official model pool](official-model-pool.md). Public prices stay fixed across provider switches, and reported usage from failed attempts is included.

Arrears are calculated from the raw spendable balance (`purchased + bonus - reserved < 0`). The displayed available balance is clamped to zero and must not be used as a substitute for this check.

## Priority scheduling

Requests enter one of two Redis sorted sets, ordered by admission time. A Lua script atomically checks the active slot count, selects the member queue head before the standard queue head, and assigns the slot. Waiters retry every 500 ms; a queue head with no heartbeat for 15 seconds is eligible for removal.

The current global concurrency policy returns 10 slots. Membership priority applies when assigning an available slot and does not preempt an executing request. Strict member priority provides no reserved share for standard requests. Queue waiting and execution share the request's overall timeout, which defaults to 30 minutes for web chat.

Source and automated tests establish these contracts. Production deployment and provider-backed execution require separate verification.
