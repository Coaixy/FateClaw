# Popup announcements

Site owners manage operational notices at `/announcements` in the admin app.
Notices have a title (1–120 characters), Markdown body (1–20,000 characters), and
one of three states: `draft`, `published`, or `archived`. Drafts and archived
notices are private to the admin API. Publishing is immediate; saving changes
to an already published notice publishes a new version. Archiving removes it
from the public response. An archived notice can be edited and published again.

The user site fetches the latest 20 published notices, newest first, after the
pre-use notice is accepted or was already snoozed for today. Announcements wait
for onboarding and other dialogs to finish. They appear globally, including
before login, except on `/status`. The existing responsive bottom sheet provides
a centered desktop dialog and a mobile bottom sheet. Multiple unread notices
appear in sequence. Markdown supports tables and internal links; raw HTML,
images, and unsafe URL schemes are not rendered.

Closing a notice or advancing to the next records its ID and revision in browser
local storage. The same revision stays dismissed across reloads and tabs. A new
published revision appears again. If storage is blocked, dismissal lasts for the
current page session. Dismissal is not shared across devices or browser profiles.
Notices refresh on initial load, route changes, and returning to a visible tab;
publication and withdrawal are not pushed live to an already visible page.
Fetch failures leave the main application usable and retry on the next refresh
trigger. There is no individual notification inbox or targeting.

## API and persistence

| Method | Path | Access | Result |
| --- | --- | --- | --- |
| GET | `/api/announcements` | Public | `{ items: AnnouncementDto[] }`, at most 20 published notices |
| GET | `/api/admin/announcements?page=1&status=draft` | `admin:*` | Paginated admin list; optional status filter; 20 per page |
| PUT | `/api/admin/announcements/:id` | `admin:*` | Creates or updates a notice and returns `AdminAnnouncementDto` |

Clients allocate a UUID for `:id`. PUT accepts `title`, `body_markdown`, `status`,
and `expected_revision`. New notices use revision `0`; edits supply the last
returned revision. A single conditional database write updates content, state,
revision and publication time together. Concurrent stale edits return `409`;
editing an absent notice returns `404`. Retrying the exact last accepted PUT
returns the existing result without another revision or publication timestamp.
Changing input after a write with an uncertain outcome can return `409`; refresh
the list and reopen the persisted notice before retrying changed content.

Migration `0091_popup_announcements` creates `popup_announcements`. It does not
change frozen migrations or restore records removed by the retired banner
module's `0079_drop_announcements` migration. Frontends depend on this migration
being applied by normal API startup. Definitions are shared through
`packages/contracts/src/announcements/index.ts`; routes, service and repository
are owned by their corresponding announcement modules.

## Validation

Focused HTTP tests cover input validation, public access and owner permissions.
The PostgreSQL integration suite covers draft/publish/archive visibility,
replayed writes, concurrent editors, and pagination. It uses only the explicitly
provided disposable `FATECLAW_TEST_MIGRATIONS_DATABASE_URL`, creates its own
database and removes it afterward. Browser-state tests cover dismissal across
reloads, new revisions and blocked storage; rendering tests cover Markdown and
unsafe content in both the preview and user dialog.
