# Popup announcements and polls

Site owners manage operational notices at `/announcements` in the admin app.
Notices have a title (1–120 characters), Markdown body (1–20,000 characters), and
one of three states: `draft`, `published`, or `archived`. Drafts and archived
notices are private to the admin API. Publishing is immediate; saving changes
to an already published notice publishes a new version. Archiving removes it
from the public response. An archived notice can be edited and published again.

The user site fetches the latest 20 published notices, newest first, after the
pre-use notice is accepted or was already snoozed for today. Announcements wait
for onboarding and other dialogs to finish. They appear globally, including
before login, except on `/status`, `/acknowledgements`, and `/announcements`.
The public `/announcements` page, linked from the sidebar and popup, shows the
same latest 20 published notices and allows users to revisit votes after
dismissing a popup. The existing responsive bottom sheet provides
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

## Single-choice and multiple-choice polls

A notice can optionally include one question (1–200 characters), 2–10 distinct
options (1–120 characters each), a single-choice or multiple-choice mode, an
optional deadline, and a manual closed state. Single-choice is the default.
Administrators create option UUIDs once and keep them stable when saving. Poll
results show counts and percentages in the popup, public announcement page, and
admin editor. Anyone can read aggregate results; only signed-in users can vote.
Public responses expose only the verified viewer's selection, never voter IDs.

Each account has one ballot per announcement. Single-choice ballots contain one
option; multiple-choice ballots contain one or more distinct options, up to all
available options. A submission replaces the account's complete selection until
the poll closes. Empty selections are rejected. Repeating the same selection,
including in a different order, never increments the count. Voting does not
increment the announcement revision or trigger
another popup. Lists refresh on navigation, visibility restoration, or explicit
refresh on the announcement page; results are not pushed live.

`total_votes` counts participating accounts, and each option's `vote_count`
counts accounts selecting that option. Percentages divide each option's count
by participating accounts, so multiple-choice percentages can sum above 100%.
The public `selected_option_ids` array contains only the viewer's saved choices;
it is empty for anonymous readers and administrators.

The database clock enforces the deadline. A manually closed, expired, draft, or
archived poll accepts no new or changed votes. Replaying an already committed
selection while its announcement remains published returns the stored result,
even if the poll has since closed. The write includes the displayed announcement
revision; a changed vote against a stale revision returns `409` and the client
refreshes before the user tries again.

Before any vote, administrators can change or remove the poll. Once votes exist,
the mode, question, option IDs, labels, and order are locked to preserve the meaning of
the result. Announcement text, deadline, and manual closed state remain editable.
Reopening an expired poll also requires removing or extending its deadline.
Archiving preserves the poll and its counts. Account deletion cascades that
account's vote and aggregate results reflect the remaining accounts.

## API and persistence

| Method | Path                                           | Access    | Result                                                                               |
| ------ | ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------ |
| GET    | `/api/announcements`                           | Public    | `{ items: AnnouncementDto[] }`, at most 20 published notices                         |
| PUT    | `/api/announcements/:id/vote`                  | User JWT  | Accepts `{ option_ids: string[], expected_revision }`; returns `AnnouncementPollDto` |
| GET    | `/api/admin/announcements?page=1&status=draft` | `admin:*` | Paginated admin list; optional status filter; 20 per page                            |
| PUT    | `/api/admin/announcements/:id`                 | `admin:*` | Creates or updates a notice and returns `AdminAnnouncementDto`                       |

Clients allocate a UUID for `:id`. PUT accepts `title`, `body_markdown`, `status`,
`expected_revision`, and optional `poll`. A poll contains `question`, boolean
`allow_multiple`, `options`
as `{ id, label }[]`, nullable ISO `closes_at`, and boolean `is_closed`. Omitting
`poll` preserves the existing configuration; explicit `null` removes an unvoted
poll. New notices use revision `0`; edits supply the last
returned revision. One transaction conditionally updates content, state,
revision, publication time, and poll configuration. Votes and
admin updates lock the same announcement row, so a racing first vote either
locks the existing options or sees the new revision and must refresh.
Concurrent stale edits return `409`;
editing an absent notice returns `404`. Retrying the exact last accepted PUT
returns the existing result without another revision or publication timestamp.
Changing input after a write with an uncertain outcome can return `409`; refresh
the list and reopen the persisted notice before retrying changed content.

Migration `0091_popup_announcements` creates `popup_announcements`.
`0100_announcement_polls` adds `announcement_polls`,
`announcement_poll_options`, and `announcement_poll_votes`. Composite foreign
keys keep votes within their poll. `0101_announcement_multiple_choice` adds
`allow_multiple` (default `false`) and extends the vote primary key to
announcement/account/option. Existing single-choice selections and announcement
revisions survive the upgrade. The shared announcement lock serializes complete
ballot replacement and mode changes. Polls and votes are separate from announcement revisions.
It does not
change frozen migrations or restore records removed by the retired banner
module's `0079_drop_announcements` migration. Frontends depend on this migration
being applied by normal API startup. Deploy the API, web, and admin together.
Definitions are shared through
`packages/contracts/src/announcements/index.ts`; routes, service and repository
are owned by their corresponding announcement modules.

## Validation

Focused HTTP tests cover input validation, public access and owner permissions.
The PostgreSQL integration suite covers draft/publish/archive visibility,
replayed writes, concurrent editors, pagination, account-scoped vote changes,
closed polls, complete multiple-choice replacements, unique participant counts,
concurrent submissions, and first-vote/configuration races. Migration integration
tests preserve existing single-choice data and verify repeated startup. It uses only the explicitly
provided disposable `FATECLAW_TEST_MIGRATIONS_DATABASE_URL`, creates its own
database and removes it afterward. Browser-state tests cover dismissal across
reloads, new revisions and blocked storage; rendering tests cover Markdown and
unsafe content in both the preview and user dialog. Frontend request ownership
tests cover account changes and list responses arriving after a confirmed vote.
