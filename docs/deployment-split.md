# Three-site deployment: www / admin / api

For production, deploy FateClaw as three independent sites:

```text
https://www.example.com      -> www user-facing static site (apps/web)
https://admin.example.com    -> admin static site (apps/admin)
https://api.example.com      -> Fastify API (apps/api)
```

Both www and admin use `NEXT_PUBLIC_API_BASE=https://api.example.com` to call the API.
In production, the API must include both frontend origins in `ALLOWED_ORIGINS`:

```dotenv
ALLOWED_ORIGINS=https://www.example.com,https://admin.example.com
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_WEB_BASE_URL=https://www.example.com
```

The admin site is static and cannot replace server-side authentication. In production,
protect `admin.example.com` with an IP allowlist, VPN, or additional authentication at the reverse proxy.

Payment callbacks also follow this split: the Epay asynchronous notification `notify_url` points to
`https://api.example.com/api/billing/recharge/notify`, while the post-payment
`return_url` points to `https://www.example.com/wallet`.

## User skill storage

User-created skill content is stored as immutable revisions in PostgreSQL. `user_custom_skills.current_revision_id` selects the latest content; local files under `FATECLAW_TEXT_SKILLS_DIR` (default `.fateclaw/text-skills`) are disposable caches and do not need to be included in deployment archives. API, agent-runtime, and web must all run the updated version because editor saves require `base_revision_id`.

Before moving an existing installation, stop old writers and start the updated API where the complete original skill files are available. Startup applies migration `0081_skill_content_revisions` and imports legacy content separately. Keep the original files until this query returns zero:

```sql
SELECT COUNT(*) FROM user_custom_skills
WHERE deleted_at IS NULL AND current_revision_id IS NULL;
```

Inspect unresolved imports without reading their content:

```sql
SELECT skill_id, status, error_code, checked_at
FROM skill_content_imports WHERE status <> 'complete';
```

Restore missing or mismatched original files and restart the updated API to retry. Completed imports are skipped and concurrent importers cannot overwrite current content. Empty databases cannot infer ownership and skill IDs from orphan directories; they require an explicit import mapping. After import completes, deployments can restore skill content from PostgreSQL alone. Back up the database to preserve all revisions.

Each runtime needs a writable cache directory. It owns a namespace under `cache-v1/`, retains active request snapshots, and evicts inactive snapshots above 64 MiB or after seven idle days. Exited process namespaces are reclaimed on subsequent cache use. Active requests may temporarily exceed the budget. Replacing a runtime causes a cold cache; PostgreSQL retains the content.

Deployments using the same PostgreSQL database share revisions without file synchronization. Separate regional databases require operator-configured replication, with update visibility subject to replication consistency and lag. The feature does not perform bidirectional filesystem synchronization. See [Skill content architecture](skill-content-architecture.md).

## Packaging

```bash
pnpm run pack
```

By default, this produces three archives:

```text
fateclaw-backend-v<version>-runtime.tar.gz
fateclaw-www-v<version>-static.tar.gz
fateclaw-admin-v<version>-static.tar.gz
```

Packaging builds shared contracts once, then builds and archives the backend,
www, and admin in parallel with up to three workers. Use `pnpm run pack --jobs 2`
to limit concurrency or `pnpm run pack --jobs 1` for sequential packaging.
Successful builds print archive paths, sizes, and elapsed time; failed builds
print their captured logs and stop the remaining workers.

You can also package each target separately:

```bash
bash scripts/pack.sh backend-runtime
bash scripts/pack.sh backend-source
bash scripts/pack.sh backend
bash scripts/pack.sh www
bash scripts/pack.sh admin
```

The legacy arguments `api-runtime`, `api-source`, and `api` remain aliases for backend packages;
the legacy `web` argument remains an alias for the `www` static package.

### License materials

Backend runtime and frontend static archives include `LICENSE`, `NOTICE`, and
`THIRD_PARTY_NOTICES.txt`. The frontend Webpack build collects packages whose
modules contribute to emitted browser chunks and preserves their upstream
license and copyright text, including nested notices for embedded components.
Packaging copies the generated notices to the static site's root. The backend
archive contains compiled project source; its npm dependencies are installed
separately and retain the notices accompanying those upstream packages.

Install the locked dependencies before packaging. Missing license text for a
bundled package fails the frontend build; missing generated notices fail static
packaging. Backend source archives retain the project license and notice from
the source tree; third-party dependencies are installed separately.

Retain these files when deploying or redistributing the output. Publish a link
to the matching complete repository revision, including its build and install
scripts, alongside each release. The project's GPL declaration does not replace
third-party licenses.

## API deployment

`TRUST_PROXY` defaults to `loopback`; no additional configuration is required
when the reverse proxy connects over a loopback address. Legacy positive numeric
values also use this default because Fastify no longer supports hop-count-only
trust. `false` and `0` disable proxy trust. Deployments whose proxy connects from
a different address must use the actual trusted proxy IP/CIDR allowlist.

Use the backend runtime package in production. It includes `apps/api/dist` and
`apps/agent-runtime/dist`, so the server does not need to build TypeScript.
The packaged `.npmrc` sets `package-lock=false` to prevent a leftover
`package-lock.json` in an existing 1Panel project directory from affecting installation.
Packaging also copies the workspace security overrides into the runtime root
`package.json`, so npm applies the same version constraints during installation.

```bash
mkdir -p fateclaw-api
tar xzf fateclaw-backend-v<version>-runtime.tar.gz --strip-components=1 -C fateclaw-api
cd fateclaw-api
npm install --omit=dev -f
npm run start
```

In a 1Panel Node.js runtime environment, use this startup command:

```bash
rm -rf node_modules/@fateclaw/contracts && npm install --omit=dev -f && npm run start
```

The existing command without `--omit=dev` is also supported; it additionally
installs development dependencies. Removing the old contracts link allows npm
to recreate it against the `packages/contracts/dist` shipped in the new archive.
These commands target the backend runtime archive, not an unbuilt source checkout.

For a server with 2 GB of RAM, also configure these limits in 1Panel / Docker:

- FateClaw API container memory limit: `768MiB`.
- FateClaw API container `pids_limit`: `128`.
- Give PostgreSQL and Redis separate resource limits so they do not compete with agent-runtime under the same limit.
- Before first deploying a version with runtime reclamation, manually clean up orphaned `agent-runtime` processes from the previous version.

A production `.env` should include:

```bash
NODE_ENV=production
LOCAL_AGENT_ENTRY_MODE=dist
LOG_PRETTY=0
LOCAL_AGENT_NODE_MAX_OLD_SPACE_MB=128
ALLOWED_ORIGINS=https://www.example.com,https://admin.example.com
PUBLIC_API_BASE_URL=https://api.example.com
PUBLIC_WEB_BASE_URL=https://www.example.com
# Optional operations alert webhook (POSTs JSON for inbox/outbox backlogs, child-process crashes, or billing closed at zero)
ALERT_WEBHOOK_URL=https://your-webhook-endpoint.example.com/alert
```

### Running under PM2 (optional)

The repository root includes `ecosystem.config.cjs`, which reads `.env`. With PM2, run:

```bash
pm2 start ecosystem.config.cjs
```

The configuration sets `kill_timeout: 45000`: graceful API shutdown waits for all agent-runtime child processes
to drain in-flight requests (daemon drain allows up to 30 seconds; forced termination occurs at 35 seconds).
PM2's default 1.6-second kill window interrupts this flow, so keep this setting. You can also run
`npm run start` under 1Panel/systemd, provided the process manager waits at least 40 seconds after SIGTERM before sending SIGKILL.

### Health checks and runtime observability

- Liveness: `GET /api/health`; readiness (checks PostgreSQL and Redis): `GET /api/ready`.
  Integrate these with Nginx/load balancers and the process manager.
- The admin Runtime Status page shows an infrastructure snapshot (agent-runtime child processes,
  IPC queue depths, runtime heartbeats, and concurrency gates) from `GET /api/admin/runtime-status`.
- Request timeouts are derived centrally in `apps/api/src/shared/timeout-chain.ts`. Usually, you only need
  to optionally configure `AGENT_RUNTIME_REQUEST_TIMEOUT_MS` (the daemon's hard per-request timeout,
  eight minutes by default) and `AGENT_REQUEST_TIMEOUT` / `AI_CHAT_REQUEST_TIMEOUT`
  (API fallback timeouts, 30 minutes by default). Backlog cleanup thresholds and session-lock TTLs
  follow automatically; invalid combinations fail at startup.

Configure execution capacity and resident-process policy at admin `/system/runtime`; PostgreSQL values take priority. See [Runtime configuration](runtime-configuration.md) for application timing, session maintenance and the default-off WeChat switch.
For a 2 GB server, start with `1` concurrent request, `2` resident runtimes, and `120000` ms before idle reclamation.

To rebuild from source on the server, run `bash scripts/pack.sh api` to generate
`fateclaw-backend-v<version>-source.tar.gz`, then deploy with
`pnpm install && pnpm run build && pnpm run start`.

## www deployment

```bash
mkdir -p /var/www/fateclaw-www
rm -rf /var/www/fateclaw-www/*
tar xzf fateclaw-www-v<version>-static.tar.gz -C /var/www/fateclaw-www
```

The www package contains the contents of the user-facing static site's root directory, including `index.html`,
`_next/static/*`, and page directories. Clear the destination before extracting so deleted or renamed pages
and old route data do not remain online.

## admin deployment

```bash
mkdir -p /var/www/fateclaw-admin
rm -rf /var/www/fateclaw-admin/*
tar xzf fateclaw-admin-v<version>-static.tar.gz -C /var/www/fateclaw-admin
```

The admin package contains the independent admin site. Its login page is at `/`, with management pages at
`/overview`, `/users`, `/system/models`, and other routes.

## Nginx example

```nginx
server {
  listen 80;
  server_name api.example.com;
  client_max_body_size 64m;

  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
  }
}

server {
  listen 80;
  server_name www.example.com;
  root /var/www/fateclaw-www;

  location ^~ /_next/static/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
  }

  location ~ ^/(.+)\.txt$ {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    try_files $uri /$1/index.txt =404;
  }

  location / {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    try_files $uri $uri/ /index.html;
  }
}

server {
  listen 80;
  server_name admin.example.com;
  root /var/www/fateclaw-admin;

  # In production, add allow/deny rules, Basic Auth, or VPN access controls here.
  location ^~ /_next/static/ {
    add_header Cache-Control "public, max-age=31536000, immutable" always;
    try_files $uri =404;
  }

  location ~ ^/(.+)\.txt$ {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    try_files $uri /$1/index.txt =404;
  }

  location / {
    add_header Cache-Control "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0" always;
    try_files $uri $uri/ /index.html;
  }
}
```

For HTTPS, add the appropriate `listen` and certificate settings to each server block.

Caching policy:

- `/_next/static/*` filenames include build hashes, so their URLs change when content changes. They can be cached for one year with `immutable`.
- Do not apply long-lived caching to page entry points, `*.html`, or the `*.txt` route data generated by Next App Router static exports. Otherwise, browsers or CDNs may keep serving old page shells and route data.
- If you use a CDN, disable caching for page entry points and HTML/TXT files there as well, or explicitly purge them after deployment.
