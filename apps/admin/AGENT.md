# Admin site

This is an independent static admin site built with Next.js 16 App Router. It is built and deployed
separately from `apps/web`. Use `admin.example.com` for production deployments.

## Where to start

When first working on the admin app, read these files in order:

1. `apps/admin/app/layout.tsx`
2. `apps/admin/app/page.tsx`
3. `apps/admin/app/(dashboard)/layout.tsx`
4. `apps/admin/components/admin-sidebar.tsx`
5. `apps/admin/lib/admin-api.ts`
6. `apps/admin/lib/admin-navigation.ts`

## Route conventions

The admin site's login page is at the domain root:

- `/`: Admin login
- `/overview`: Overview
- `/billing`: Billing management
- `/users`: Users
- `/messages`: Messages
- `/skills`: Skills
- `/issues`: issue management and private account attribution
- `/logs`: Logs
- `/system/runtime`: owner-only runtime policies and WeChat availability
- `/system/models`: Model configuration
- `/system/rewards`: RMB credit configuration
- `/system/registration-invites`: owner-only invitation policy, allowances, operational codes and completed-refund records

The backend `/api/admin/verify` endpoint returns `/overview` or `/users` for this independent app. `apps/admin/lib/admin-navigation.ts` handles trailing slashes and static document navigation. Keep these root-relative paths consistent with the backend principal contract.

## Development and production differences

- Development: `pnpm run dev:admin` starts the site at `http://localhost:3002`.
- Development API calls are forwarded to `http://localhost:3000/api/*` through rewrites in `apps/admin/next.config.ts`.
- Production: `next build` exports static files to `apps/admin/out/`.
- Production requires `NEXT_PUBLIC_API_BASE=https://api.example.com` or a reverse proxy forwarding the admin site's `/api/*` requests.

## Secure deployment requirements

The admin app is a static export; frontend pages are not a security boundary. Production deployments must meet these requirements:

1. `/api/admin/*` must continue to use backend `X-Admin-Key` authentication.
2. Protect `admin.example.com` with an IP allowlist, VPN, Basic Auth, or another access control.
3. The API's `ALLOWED_ORIGINS` must include the admin site's origin.
4. Admin keys must be entered by administrators; do not compile them into frontend environment variables or static files.
5. Enforce HTTPS to prevent plaintext transmission of admin keys.

## Runtime policies

The owner-only `/system/runtime` page reads and saves `/api/admin/system-config/runtime`. PostgreSQL owns the values; saves require the current revision and reject concurrent edits with 409. UI validation uses the shared numeric bounds. See [Runtime configuration](../../docs/runtime-configuration.md) for fields, defaults and application timing.
