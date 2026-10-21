# Registration invitations

Public phone registration is open without an invitation. Image CAPTCHA, SMS
verification, password rules and registration rate limits still apply. An optional
valid invitation grants the new user 72 hours of the existing `membership` identity,
starting at successful registration. Omitting or blanking the code creates an
ordinary account without membership. A supplied invalid code fails explicitly;
the user can clear it and continue with ordinary registration.

The trial uses the existing membership entitlements, daily free-model limits and
expiry checks. Paid model usage remains metered; no wallet credit is granted and
no subscription fee is charged. Expiry returns the account to non-member access.
Membership alone does not qualify the user to invite others: the existing recharge
thresholds still apply. Membership sales being disabled does not disable invitation
trials. Existing users and consumed invitations receive no retrospective grant;
previously issued unused codes grant the trial when redeemed after this change.

Existing login and password recovery remain available without an invitation.
Google sign-in stays disabled.
Authorized administrative user provisioning remains a separate privileged path.

## Policy and allowance

The default cumulative allowance is three invitations at CNY 30 in net paid
recharges, five at CNY 100 and ten at CNY 300. Each invitation lasts seven days.
The owner administrator can edit the increasing threshold/total-allowance ladder
and code lifetime. Historical successful recharge orders count; wallet balance,
bonus grants and administrative balance adjustments do not. The current payment
adapter charges one yuan per purchased coin, so paid order amounts provide the
current monetary basis. A future exchange-rate change must preserve each order's
actual paid currency amount before changing this calculation.

Eligibility uses paid orders less recorded completed refunds. The highest current
qualifying tier determines the automatic total, rather than adding another grant
at every crossing. Upgrading from CNY 30 to CNY 100 changes the total from three
to five, adding two slots. Previously used and reserved slots count against that
total. Repeated payment notifications and refund/recharge cycles cannot reset usage.
Spending wallet credit does not change qualification.

Administrator adjustments are stored separately and survive tier changes. Current
capacity is the automatic total plus that adjustment, bounded to 0–1000. Successful
invitations are never undone: the displayed total is at least the historical used
count. If a downgrade leaves more used slots than current capacity, no new slots
are available. Administrators cannot deliberately reduce the displayed total below
used and reserved slots. Saving only a suspension change preserves the existing
adjustment even when the displayed total is held up by historical usage.

Generating an invitation reserves one slot. Codes are random, single-use and
returned only once; only a hash and a display suffix are stored. Expiration and
revocation release the reservation. Successful registration permanently consumes
the slot, even if the invited user is subsequently deleted. Previewing a code or
sending an SMS does not consume it.

Creation accepts a client-generated UUID `request_key`. Repeating the same request
returns the existing invitation with `code: null` and never reserves another slot.
After a lost creation response, the user can revoke that code and issue a new one;
the plaintext code cannot be recovered from storage.

Administrators can issue operational codes without a user allowance, revoke any
unused code, and suspend an inviter. Suspension blocks both generation and
redemption of that user's outstanding codes. A refund that takes net recharge
below a tier reduces current automatic capacity without deleting invited accounts.
If outstanding codes exceed the remaining allowance, the newest excess codes are
revoked; older invitations keep their reservations. Below the first tier all
unused codes are revoked, and manual adjustments do not bypass the recharge gate.
Code generation and redemption recheck the current ladder. Policy edits reconcile
the owner's allowance on its next account operation; completed refunds and payment
qualification reconcile in the same database transaction.

## Transaction and failure boundaries

The inviter's user row serializes code creation, redemption, allowance changes,
payment qualification and refund registration. An invitation is rechecked after
locking its owner and before creating the user. User creation, invitation
attribution, the 72-hour membership grant and code consumption commit in one
PostgreSQL transaction. Concurrent redemptions produce one account and one trial;
failed user creation or trial issuance rolls everything back and leaves the code
unused. Retrying a successful registration cannot grant another trial.
The existing phone uniqueness constraint remains authoritative.
The serialization lock is `FOR NO KEY UPDATE`: recharge inserts already hold
foreign-key `KEY SHARE` locks, so upgrading them to `FOR UPDATE` can deadlock
concurrent orders for the same user.
The account transaction also holds a shared lock on the singleton policy row.
Policy updates wait until its qualification, summary and reservation reads finish,
so a response cannot mix an old allowance with a newer ladder or code lifetime.

Registration SMS issuance and registration submission both validate a supplied
non-empty code on the server; neither requires one. Public preview and submission
are rate-limited. Registration failures
are reported without exposing an inviter's identity, phone or payment history.
Invitation responses are never cached and plaintext codes never enter logs.

Completed-refund registration is an administrative accounting operation for
invitation eligibility. It does not send funds or change wallet balances. The
operator must only record a refund already completed through the payment channel.
A unique refund reference makes retries idempotent; a reused reference with
different details fails, as does an amount exceeding the unrefunded paid order.
The refund record and resulting invitation revocation commit together.

## HTTP contract

Types are owned by `@fateclaw/contracts/auth`.

| Method | Path | Result |
| --- | --- | --- |
| POST | `/api/auth/invites/preview` | Validate `{ inviteCode }`; return validity and expiry only |
| GET | `/api/auth/invites/me` | Current user's policy, eligibility, allowance and recent invitations |
| POST | `/api/auth/invites` | Generate one code; return `{ invite, code }` once |
| POST | `/api/auth/invites/:id/revoke` | Revoke an owned unused code; return updated summary |
| GET | `/api/admin/registration-invites/policy` | Read policy |
| PUT | `/api/admin/registration-invites/policy` | Save policy with `expected_revision` |
| GET | `/api/admin/registration-invites/users/:userId` | Read a user's invitation summary |
| PATCH | `/api/admin/registration-invites/users/:userId` | Set total allowance and suspension with `expected_revision` |
| GET | `/api/admin/registration-invites` | List recent operational and user codes, optionally by `user_id` |
| POST | `/api/admin/registration-invites` | Issue an operational code; return `{ invite, code }` once |
| POST | `/api/admin/registration-invites/:id/revoke` | Revoke any unused code |
| POST | `/api/admin/registration-invites/refunds` | Record a completed refund |
| GET | `/api/admin/registration-invites/refunds?user_id=…` | List recent recorded refunds |

All administrative invitation routes require the owner scope. Anonymous signup
accepts optional `inviteCode` in both `POST /api/auth/register` and registration-type
`POST /api/auth/send-sms-captcha` requests. Password recovery does not accept or
require an invitation. User invite links open `/login#invite=…` in registration
mode. The browser reads the fragment locally, so the code is absent from static
host requests and access logs. Invitation values must not be echoed into diagnostics.

## Validation

Required checks cover SMS and ordinary registration without a code, invalid codes
before SMS, exact 72-hour trial issuance, trial-failure rollback, expiry, revocation,
ownership, suspension, concurrent creation and redemption, failed-registration
rollback, paid-order qualification, partial refunds, refund retry conflicts,
tier boundaries, cumulative allowance accounting,
manual adjustment preservation, coherent policy reads and owner-only
administration. Database integration uses a disposable PostgreSQL instance with
synthetic users and orders; application database configuration is never used.
Web and admin checks include type checking, static builds and visual review of
registration, invitation management and administrative controls.

Real PostgreSQL checks exercise qualification, issuance and redemption races,
tier upgrades and downgrades, used-slot preservation, manual adjustments and
concurrent policy writes. The migration suite compares fresh bootstrap and
historical upgrades. Isolated browser checks cover desktop and 390px mobile
layouts with synthetic API responses. Production deployment and real
SMS/payment-channel execution were not exercised (unverified).
Fragment-link browser checks also confirmed the code is absent from GET request
URLs and Referer headers while SMS and signup still receive it in their POST bodies.

User deletion detaches recharge orders instead of removing them, including their
completed refund records. Skill access invitations cascade with their creator.
A payment received after deletion records `status=paid` and
`credit_status=reconciliation_required` without crediting a wallet. The admin
billing list exposes this state for manual reconciliation. Payment settlement,
completed-refund recording and deletion lock the user before the order to avoid
lock inversions. Invitation code consumption remains durable when an invitee is removed.

Migration `0093_registration_invite_tiers` upgrades the single-threshold policy
to the new ladder, preserves code lifetimes, used invitations and manual
adjustments, and reconciles existing paid users. Deploy the API and both clients
together because the policy contract now exposes `tiers` instead of
`threshold_yuan` and `default_slots`.
