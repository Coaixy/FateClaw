# Runtime configuration

The owner administrator manages execution capacity, Skill limits, session-file maintenance and WeChat availability at `/system/runtime`. PostgreSQL `runtime_config` is the source of truth. Existing installations keep their stored limits when migration 0098 runs; new installations receive the database defaults below. Environment variables do not override these policies.

## API and ownership

`GET /api/admin/system-config/runtime` returns the policy fields, a positive `revision`, and `updated_at`. `PUT` accepts all policy fields and the revision read by the editor. Both endpoints require the owner administrator; the restricted user-manager role cannot read or change them.

A successful update increments the revision and writes a configuration audit record in the same transaction. A stale revision returns HTTP 409 without changing any field. Invalid, unknown or retired fields return HTTP 400. Failure to persist the audit rolls back the policy update.

| Field | New-install default | Allowed values |
| --- | --- | --- |
| `agent_concurrency_limit` | 10 | Integer 1–1000 |
| `agent_account_concurrency` | 1 | Integer 1–100 |
| `local_agent_max_processes` | 4 | Integer 1–100 |
| `local_agent_idle_ttl_ms` | 600000 | Integer 30000–86400000 ms |
| `pi_session_health_enabled` | false | Boolean |
| `pi_session_inactive_cleanup_days` | 30 | Integer 1–3650 days |
| `pi_session_orphan_grace_days` | 30 | Integer 1–3650 days |
| `skill_bundle_max_files` | 50 | Integer 1–500 |
| `skill_bundle_max_file_chars` | 100000 | Integer 1–2000000 characters |
| `skill_bundle_max_total_chars` | 500000 | Integer 1–10000000 characters; at least the single-file limit |
| `skill_bundle_max_zip_bytes` | 8388608 | Integer 1024–104857600 bytes |
| `user_skill_max_count` | 30 | Integer 1–500 |
| `wechat_claw_enabled` | false | Boolean |

## Application of changes

- The API scheduler and daemon cache concurrency policies for at most two seconds. Existing requests finish normally when a limit is reduced; new execution waits for capacity. A failed policy read does not silently substitute an environment value or a fixed limit.
- Resident-process capacity and idle timeout are read during process admission and idle scheduling. New policies apply to subsequent scheduling decisions; busy processes are not terminated to meet a reduced limit.
- Skill limits apply to subsequent limit reads, new Skill creation and file saves. Existing stored content is preserved.
- Session maintenance checks the database policy every minute. When enabled, successful cleanup runs at most once per day per API process under a distributed lock. It archives soft-deleted and inactive session files; orphan deletion remains an explicit administrator action. Manual cleanup uses the configured inactivity and orphan-grace defaults.
- WeChat availability is reconciled every ten seconds. An enabled account also requires an owner with active membership. Disabling the service stops account polling and its pinned IPC listeners while preserving accounts, billing and chat history. New binding requests check the current switch directly.

The lightweight API-only development entry does not run polling or maintenance workers. Use the full backend entry to validate worker behavior.

## Other configuration owners

Model nodes, provider credentials, thinking levels and model prices remain owned by the paid/free model configuration pages. Request watchdogs and absolute timeouts remain in the shared timeout chain described in [Deployment](deployment-split.md). Migration 0098 removes the former model-selection and request-timeout columns from `runtime_config` after their historical upgrade dependencies have run.

`FATECLAW_TEXT_SKILLS_DIR` is a deployment path, not an administrator policy. The host forwards it to spawned daemons, and both use the configured root for legacy imports or disposable Skill caches. See [Skill content architecture](skill-content-architecture.md).

## Upgrade work

The full backend runs pending `runtime_upgrade_tasks` after database and Redis initialization and before starting IPC consumers. Cleanup of the retired LIST concurrency queues commits a database receipt only after Redis deletion succeeds. Failure rolls back the receipt and fails startup so the operation can retry; later starts skip completed work. Supported upgrades must replace the old API and daemon processes together rather than leave old queue writers running alongside the new deployment.
