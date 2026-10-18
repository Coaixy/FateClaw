# Documentation

For coding tasks, start with the [Agent guide](../AGENT.md). For a first local run, use [Local development](development.md).

## Choose a topic

| Need | Document | Scope |
| --- | --- | --- |
| Install, configure, run, or validate locally | [Local development](development.md) | Prerequisites, startup, model setup, and checks |
| Locate code for a change | [Agent guide](../AGENT.md) | Task-to-source map and subsystem boundaries |
| Understand agent execution | [Runtime architecture](agent-architecture.md) | Host, Redis IPC, resident processes, Pi Runtime, and knowledge resources |
| Secure host/runtime transport | [Runtime security](runtime-security.md) | Authenticated Redis IPC envelopes, identity binding and the remaining process boundary |
| Change or consume internal HTTP APIs | [API reference](api-reference.md) | Routes, authentication, request and response contracts |
| Change access or charging behavior | [Entitlements and billing](membership-entitlement-current.md) | Membership gates and reservation/settlement behavior |
| Control new account registration | [Registration invitations](registration-invites.md) | Paid-user allowances, single-use codes, refund accounting and owner controls |
| Check public AI availability | [Public service status](service-status.md) | Six-hour shared probes, public results and resource bounds |
| Manage public feedback | [Issues](issues.md) | Anonymous discussion, private attribution, moderation and abuse limits |
| Publish operational notices | [Popup announcements](announcements.md) | Admin publishing, versioned user dialogs and browser dismissal |
| Configure model supply and failover | [Official model pool](official-model-pool.md) | Mixed-model nodes, weighted routing, circuit recovery and billing |
| Configure daily free AI usage | [Free model service](benefit-model-pool.md) | Separate pools, user allowance, shared upstream budgets, activation and status |
| Change schema or generate a database baseline | [Database migrations](database-migrations.md) | Empty database bootstrap, existing database upgrades, and snapshot validation |
| Integrate an external client | [Open API](open-api.md) | API keys, chart endpoints, and agent sessions |
| Deploy the three apps | [Deployment](deployment-split.md) | API, user site, and admin site deployment |
| Work on the retained WeChat integration | [OpenClaw/iLink](openclaw-integration.md) | Integration status and restoration boundaries |
| Contribute or report a vulnerability | [Contributing](../CONTRIBUTING.md), [Security](../SECURITY.md) | Contribution and disclosure procedures |

## Use and maintain these references

The index is navigation, not a second copy of the architecture or API contracts. Check the owning source and focused tests before relying on a behavior claim. Topic documents retain their own review dates; this navigation update does not imply every endpoint or operational procedure was revalidated.

When behavior changes, update its topic document and affected links. Add a new document only when it owns a distinct topic, then link it here. Keep setup commands in the development guide and code navigation in the Agent guide.

Keep this directory focused on current product behavior, integration references, deployment, and maintenance. Do not retain obsolete drafts, review reports, implementation plans, or unfinished-work records here.
