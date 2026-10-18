# Web frontend

This is the user-facing www frontend built with Next.js 16 App Router. It primarily serves as the user console rather than a marketing site. The admin app has been separated into `apps/admin`.

## Where to start

When first working on the frontend, read these files in order:

1. `apps/web/app/layout.tsx`
2. `apps/web/app/page.tsx`
3. `apps/web/features/auth/api.ts`
4. `apps/web/features/auth/hooks/use-auth.ts`
5. `apps/web/components/app-shell.tsx`
6. `apps/web/components/sidebar.tsx`
7. `apps/web/components/ai-chat/ai-chat-workspace.tsx`

For admin work, go directly to `apps/admin`.

## Structure

```text
apps/web/
├── app/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── login/page.tsx
│   ├── ai-chat/page.tsx
│   ├── discover/page.tsx
│   ├── clients/page.tsx
│   ├── membership/page.tsx
│   ├── profile/page.tsx
│   ├── wallet/page.tsx
│   ├── studio/
│   ├── settings/page.tsx
│   ├── skills/install/page.tsx
│   └── skills/bundle/install/page.tsx
├── components/
│   ├── app-shell.tsx
│   ├── sidebar.tsx
│   ├── chat/*.tsx
│   └── ui/*.tsx
├── lib/
│   ├── http/client.ts
│   ├── use-confirm.ts
│   ├── use-theme.ts
│   └── use-toast.ts
├── features/
│   ├── auth/
│   ├── accounts/
│   ├── billing/
│   ├── chat/
│   ├── paipan/
│   ├── skills/
└── utils/
```

## Development and production differences

- Development: `pnpm run dev` at the repository root starts API + www + admin; use `pnpm run dev:www` to run www alone.
- The Next development server runs on port `3001`.
- Development API calls are forwarded to `http://localhost:3000/api/*` through rewrites in `apps/web/next.config.ts`.
- Production: `next build` exports static files to `apps/web/out/`.
- Production deploys as an independent www static site, without a separate Next server.

When investigating behavior that works locally but fails in production, first identify whether the problem lies in:

- Next development mode.
- The static export output.
- Static-site hosting and fallback rules.

## Key modules

### Route pages

- `app/page.tsx`: Root entry point, directly rendering the new-conversation state in AI Chat.
- `app/login/page.tsx`: Login and registration.
- `app/dashboard/page.tsx`: Account overview, bindings, Soul, plans, and main entry points.
- `app/chat/page.tsx`: Chat history.
- `app/ai-chat/page.tsx`: Web AI chat interface.
- `app/discover/page.tsx`: Skill marketplace discovery.
- `app/studio/*`: Creator workspace and Skill/Bundle creation and editing.
- `app/skills/install/page.tsx`: Single-Skill installation.
- `app/skills/bundle/install/page.tsx`: Bundle installation.
- `app/wallet/page.tsx`: Wallet and recharge.
- `app/devices/page.tsx`: Device and account binding.
- `app/profile/page.tsx`: User profile.
- `app/settings/page.tsx`: Settings.

### API clients

- `features/*/api.ts`: API clients for regular-user business domains.
- `features/paipan/api.ts`: Direct chart-calculation API client.
- `features/auth/hooks/use-auth.ts`: Authentication-state hook.
- `features/auth/providers/auth-provider.tsx`: Authentication context.

Backend API changes usually require corresponding changes here.

### AI Chat workspace

The current main product entry point is `components/ai-chat/ai-chat-workspace.tsx`:

- Regular chat, user-pasted charts, manual chart calculation, and simple mode all run through AI Chat sessions.
- A successful `chatSessionsApi.send()` usually means only that the backend has queued the request, returning `accepted` and `request_id`. It is not the final reply.
- Live output first calls `chatSessionsApi.createStreamTicket()`, then connects to WebSocket through `buildChatSessionStreamUrl()`.
- Persisted server messages remain authoritative. After a WebSocket disconnect, reloading the message list should restore the display.
- `PaipanSheet` calls `/api/paipan/preview` and `/api/paipan/commit`; chart results enter the conversation as message `tool_context`.
- Simple mode starts through the unified AI Chat turn flow, with no separate workflow route or client.

## UI characteristics

- The current UI has a strong visual style, especially on the home page and dashboard, rather than a conventional admin-template appearance.
- CSS variables and `globals.css` define much of the theme.
- Components contain many animations, gradients, and visual states. Preserve the overall style when making small changes.

## Change conventions

- Reuse existing `features/*/api.ts` clients instead of scattering raw `fetch` calls across pages.
- Use the existing auth hooks and provider for authentication state.
- When changing routes, check the desktop sidebar, mobile navigation, and entry pages for related effects.
- When API fields change, check the dashboard, chat, settings, and related business pages, which depend heavily on them.
- Frontend Vitest test sources are kept in the repository. After frontend changes, run relevant `*.test.ts` tests first, then `pnpm --filter fateclaw-web exec tsc --noEmit`, and `pnpm --filter fateclaw-web build` when needed.

## Secure deployment requirements (required reading)

With `output: 'export'`, Next.js has **no runtime middleware**. Production deployments must apply basic protections at the reverse proxy (Nginx / Caddy / Traefik):

1. **API backend CORS allowlist**: The host enforces an allowlist through the `ALLOWED_ORIGINS` environment variable and refuses to start if it is missing.
2. **JWT storage**
   - User JWTs are stored in `localStorage` and depend on a strict CSP against XSS. Add `Content-Security-Policy: default-src 'self'` at the reverse proxy.
3. **Enforce HTTPS**: The reverse proxy should issue an HTTP-to-HTTPS 301 redirect to prevent plaintext token transmission.

For additional admin-site requirements, see `apps/admin/AGENT.md` and `SECURITY.md`.
