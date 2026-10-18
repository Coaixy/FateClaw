# Runtime transport and isolation

The API authenticates and encrypts Redis inbox, cancel, outbox and AI Chat stream
messages with AES-256-GCM. HKDF-SHA256 derives a separate 256-bit key for each
runtime account from the existing server JWT secret, using a distinct IPC domain.
Only the derived account key crosses the child environment as `FATECLAW_IPC_KEY`;
the root secret and stream-ticket control key stay in the API. Stream tickets use
a separate control domain, so an account key cannot mint login stream tickets.
Neither keys nor plaintext provider credentials belong in Redis envelopes or logs.

The authenticated metadata binds the protocol version, exact queue/channel and
expiry. Inbox lifetime is bounded by the shared request timeout; cancel and stream
events expire after 60 seconds. Durable result envelopes expire after 24 hours;
the database/result spool remains the source for recovery and can retransmit with
a fresh envelope. The inbox sweeper may authenticate expired input only to retire
its transport copy. It cannot execute expired work. Plaintext or tampered work is
rejected, and malformed reliable outbox entries are quarantined.

Queue identity, pending request identity and supplied account/session/user/message
identifiers must agree before side effects. Durable delivery additionally checks
the admitted request context under its row lock. Session message writes atomically
require a matching session account and, when supplied, owner. Archiving a session
preserves ownership so admitted results can still commit and settle while the
session remains archived. New turns use the existing active-session checks.
Intermediate messages persist before stream publication and retain stable IDs
across transport retries.
Only successfully handled responses release concurrency slots. Stream subscribers
check the authenticated account/session and discard repeated event IDs.
Legacy inbox execution and external message delivery claim database receipts
before effects. Execution deduplication uses the account/request ID, and final
external delivery uses the account/response request ID, so re-enveloping the same
work does not authorize a second execution or send. Ambiguous external sends are
not retried. Receipts outlive the maximum envelope lifetime and expire after 25
hours, with indexed, bounded cleanup on subsequent claims.

## Deployment

Deploy contracts, API and agent runtime together and restart resident runtimes.
Mixed plaintext/encrypted runtime versions are unsupported. Drain accepted work
before upgrading; durable database results remain recoverable. Keep the existing
server JWT secret stable across API instances and restarts. Changing it rotates
the derived IPC keys as well and requires restarting all resident runtimes.

## Remaining process boundary

Transport authentication protects against Redis message forgery and disclosure of
queued provider credentials. It does not make a compromised runtime a safe tenant
boundary. The local runner still starts children as the API's OS user and passes
the existing database and Redis connection sources. Production role grants, Redis
ACLs and host isolation have not been inspected or changed (unverified).

Completing that boundary requires moving runtime data access behind host-owned,
request-scoped operations, removing the business database credential from children,
and issuing account-scoped Redis principals or moving transport access to the host.
Any Redis ACL must cover command permissions, inbox/outbox/cancel keys, heartbeat
and history keys, and Pub/Sub channels. A shared restricted database role alone
does not enforce tenant ownership; mutable session variables must not serve as
tenant authentication. Runtime OS users or containers must also be unable to read
the API environment, credential files, sibling processes or other tenants' files.

The acceptance check for that separate deployment change is an isolated runtime
that can finish its own requests and recover results while database, Redis and
filesystem attempts against another tenant or the host credential source fail.
Use synthetic principals and stores for those checks. Production credential and
ACL changes remain an operator action; this patch does not provision credentials.

Implementation reference: [Node.js 24 crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html).
