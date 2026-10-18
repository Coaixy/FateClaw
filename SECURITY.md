# Security policy

FateClaw handles user accounts, chat content, knowledge libraries, model keys, payment and wallet records, and OpenClaw/iLink credentials. Understand these data boundaries before deploying.

## Reporting vulnerabilities

If you discover a security issue, do not open a public issue. Use the security reporting channel or private contact details published by the project maintainer on the code hosting platform. Where possible, include:

- The affected version or commit.
- Steps to reproduce.
- The scope of the impact.
- A proof of concept or log excerpts that you have confirmed will remain private.

Do not test vulnerabilities on third-party systems without authorization or export real user data.

## Sensitive information

Do not commit:

- `.env` files, database connection strings, JWT secrets, `MANAGER_KEY`, or `USER_MANAGER_KEY`.
- OpenAI, Anthropic, Gemini, or other model API keys.
- OpenClaw/iLink Bot tokens, QR-code login artifacts, or WeChat account data.
- Alibaba Cloud SMS keys or payment gateway keys.
- User chat histories, knowledge-library content, billing transactions, or database dumps.

## Minimum production deployment requirements

- Use strong random values for `JWT_SECRET` and any configured admin keys.
- Set `ALLOWED_ORIGINS` in production to include both the www and admin site origins. Do not use permissive CORS.
- Protect the admin site with an IP allowlist, VPN, or additional authentication at the reverse proxy.
- Enforce HTTPS site-wide to prevent plaintext transmission of JWTs, admin keys, and model configuration.
- Do not expose PostgreSQL or Redis to the public internet.
- Rotate model API keys, SMS keys, payment keys, and OpenClaw/iLink credentials regularly.

## Known boundaries

- Both www and admin are static exports. The admin frontend cannot replace server-side authentication: backend `/api/admin/*` routes rely on `x-admin-key`, and production deployments should also protect the admin entry point at the reverse proxy.
- WeChat OpenClaw/iLink is currently disabled. The backend retains listener and poller code, while new web bindings remain closed. Reopening the full flow requires reassessing message-delivery permissions, account isolation, rate limits, and log redaction.
- Agent output may contain model-generated content. Add disclaimers, moderation, and risk controls appropriate to the deployment context.
