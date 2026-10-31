# Issues

The user site exposes `/issues/` and a static-export-compatible detail page at `/issues/detail/?id=123`. Logged-in users create bug reports and feature requests, edit their own content, and comment. Owner administrators handle issues at the admin site's `/issues/` page.

## Identity and permissions

Public responses contain only per-issue participant numbers: zero is the issue author; subsequent numbers are allocated under the issue row lock. Numbers are independent across issues. Explicit public DTO allowlists exclude account IDs, phone numbers, request keys, fingerprints and moderation records. Viewer-specific `is_self` flags require `Cache-Control: no-store` on every response.

Writing uses the existing JWT authentication and token-version check. Identity comes from the authenticated request; unknown body fields are rejected. Only the owner administrator can view private attribution or change status, labels, visibility, locks and account-wide issue muting. Existing account attribution is not verified legal-name identity; OAuth-only accounts can have no phone number.

Hidden issues return 404 through public detail and new-write paths and are excluded from public lists, including the author's list. Hidden comments are excluded from public timelines and counts. Locked discussions reject new user comments and edits. Muting rejects new issues, comments and edits. Replaying an already committed request can still acknowledge its original ID. Closing does not lock discussion. Closing requires a reason; reopening clears the current reason while the timeline preserves the earlier closure reason.

## In-site notifications

Each participant row stores `read_entry_id`, the newest timeline entry that participant has seen. An issue is unread for a participant when a visible official entry (reply, close, reopen, label or lock change) follows that marker. Other users' comments do not notify. New participants start at the issue's current newest entry, so earlier official activity is not reported to them. Loading the newest detail page (`before=0`) advances the marker to its newest visible entry; the guard never moves it backwards. Older pages and anonymous reads leave it unchanged. Marker storage is best effort: a failed write is logged and the discussion is still returned. Hidden issues and hidden official entries never count as unread.

An issue awaits an official reply when it is open, visible, and no visible official comment follows its newest visible user comment. A new issue without comments awaits a reply. Status, label and lock changes do not answer it; hiding the official reply restores the waiting state.

The user site polls the unread count every 60 seconds and on focus or navigation, showing a count badge on the sidebar issues entry and a dot on the mobile menu button. The list marks unread rows and offers an unread view that includes closed issues. The admin sidebar polls the awaiting-reply count on the same schedule for owner sessions, and moderation actions refresh it immediately.

## Abuse and content boundaries

| Boundary | Limit |
| --- | --- |
| Public requests, per source IP | 120 per fixed minute |
| User writes, per source IP / account | 30 / 20 per fixed minute |
| New issues, per account | 60-second interval; 5 per rolling 24 hours |
| Comments, per account | 10-second interval; 50 per rolling 24 hours |
| Admin requests, per source IP | 120 per fixed minute |
| Title / description / comment | 120 / 10,000 / 2,000 UTF-16 code units at API validation |
| Issue / comment body | 64 / 16 KiB; smaller limits for moderation |
| List / timeline page | At most 50 entries |
| Search / page index | 100 characters / at most 10,000 pages |

Fastify's existing `TRUST_PROXY` must reflect the actual proxy topology. Routes use `request.ip`, never a directly read forwarded header. Distributed request budgets use an atomic Redis counter-and-expiry script. Redis errors refuse requests with 503 and a finite retry delay; exhausted budgets return 429. This fixes the previous fixed-window limiter's failure-open behavior for chart calculation and external API requests. Payment callbacks have a separate availability policy.

PostgreSQL transaction advisory locks serialize account budgets, edits and muting across API instances. Issue row locks serialize participant allocation and discussion changes. Hidden content still consumes budgets. Required content, participant and timeline mutations commit together. Transaction statement and lock waits are bounded at five and three seconds.

Create and comment bodies carry a UUID `request_key`. Replaying the same account's key and original payload returns the original ID without consuming publication quotas; conflicting reuse returns 409. Separate hashes reject identical content by the same author within ten minutes. Repeating an edit or moderation operation with the current desired state has no additional effect.

All SQL values use parameters; title search treats wildcard characters literally. Input cannot select SQL identifiers or sort expressions. Public and admin renderers allow a small Markdown element set, ignore raw HTML, allow only absolute HTTP(S) links without userinfo, and omit images, embeds and attachments. Neither server nor browser automatically fetches issue links. Issue content never enters the agent runtime, templates or commands. Search text and database error details stay out of request/error logs.

## API

Public reads accept optional JWT authentication; invalid supplied credentials are rejected. Mutations require JWT authentication. All input is strictly validated.

| Method | Route | Behavior |
| --- | --- | --- |
| GET | `/api/issues` | Filters: `q`, `state`, `kind`, `label`, `mine=true`, `unread=true`, `page`, `page_size`; `unread_ids` lists the viewer's unread issues on the page |
| GET | `/api/issues/unread-count` | Authenticated viewer's `unread_count` |
| POST | `/api/issues` | Create: `title`, `body`, `kind`, `request_key` |
| GET | `/api/issues/:id` | Newest 50 timeline entries; `before` loads older entries |
| PATCH | `/api/issues/:id` | Author edits `title`, `body` |
| POST | `/api/issues/:id/comments` | Comment: `body`, `request_key` |
| PATCH | `/api/issues/:id/comments/:entryId` | Author edits `body` |
| GET | `/api/admin/issues` | Owner list, including hidden issues; `awaiting=true` filter; `awaiting_reply_ids` |
| GET | `/api/admin/issues/summary` | `awaiting_reply_count` |
| GET | `/api/admin/issues/:id` | Private detail, current page's identities and hidden-entry markers |
| PATCH | `/api/admin/issues/:id` | Set `state`, `close_reason`, `labels`, `locked`, `hidden` |
| POST | `/api/admin/issues/:id/comments` | Official reply: `body`, `request_key` |
| PATCH | `/api/admin/issues/:id/comments/:entryId` | Set `hidden` |
| PATCH | `/api/admin/issues/:id/participants/:participant` | Set account-wide issue `muted` |

## Persistence and validation

Migration `0086_issues` adds issues, participants, timeline entries and account moderation after the frozen baseline. Deleting an account cascades its issues, comments and participation, preserving the existing account deletion contract. Migration `0099_issue_read_markers` adds participant read markers and marks existing history as seen. Email or push notifications, uploads and GitHub synchronization are outside this version.

The PostgreSQL/Redis integration suite uses only `FATECLAW_TEST_ISSUES_DATABASE_URL` and `FATECLAW_TEST_ISSUES_REDIS_URL`, both explicitly disposable. Redis is flushed between cases; a dedicated PostgreSQL database is created and dropped. Application configuration is never read. Tests cover concurrent quotas, idempotency, anonymous DTOs, moderation, paging, SQL syntax as literal input, forwarded-header abuse and Redis outages. Render tests protect both public and admin XSS boundaries.
