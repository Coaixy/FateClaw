# Contributing

Thank you for your interest in FateClaw. Contributions work best as small, verifiable changes: fixing specific issues, filling gaps in tests, improving documentation, or adding skills and integrations with a clearly defined scope.

## Before you start

Read these documents first:

- [README.md](README.md): Project introduction.
- [docs/development.md](docs/development.md): Local setup and validation.
- [docs/README.md](docs/README.md): Documentation by task.
- [docs/agent-architecture.md](docs/agent-architecture.md): Agents, Redis IPC, Pi Runtime, and request-scoped Skill resources.
- [docs/api-reference.md](docs/api-reference.md): HTTP API reference.
- [docs/openclaw-integration.md](docs/openclaw-integration.md): Current status of the WeChat OpenClaw/iLink integration.
- [AGENT.md](AGENT.md): Repository entry point for contributors and AI agents.

For frontend changes, also read [apps/web/AGENT.md](apps/web/AGENT.md). For API route changes, read [apps/api/src/interfaces/http/AGENT.md](apps/api/src/interfaces/http/AGENT.md).

## Local development

Follow [Local development](docs/development.md) for prerequisites, configuration, startup, and validation commands.

## Branches and commits

- Keep each pull request focused on one clearly defined problem.
- Keep formatting, renaming, directory moves, and feature changes separate.
- Do not commit `.env` files, private keys, model API keys, OpenClaw/iLink tokens, database exports, or user chat histories.
- If a change includes code or assets under a license other than GPLv3, document their source and license in the PR.

## Change guidelines

- Reuse existing modules and conventions; avoid adding abstractions for one-off requirements.
- When changing API contracts, also check `packages/contracts`, frontend API clients, and `docs/api-reference.md`.
- When changing agent capabilities, also check `apps/agent-runtime/src/pi-runtime/`, official `SKILL.md` files, Text Skill Bundle loading, and related tests.
- When changing chart-calculation skills, preserve local deterministic calculations. Do not replace base chart results with model-generated output.
- For WeChat OpenClaw/iLink changes, specify whether they affect backend polling for existing accounts, new QR-code bindings, automatic delivery, or deployment prerequisites.

## Testing and validation

Before submitting, run at least the checks relevant to your change:

```bash
pnpm run typecheck
pnpm run lint
pnpm test
```

You can narrow the commands to the affected scope:

```bash
pnpm --filter @fateclaw/api typecheck
pnpm --filter @fateclaw/agent-runtime exec tsc --noEmit
pnpm --filter fateclaw-web exec tsc --noEmit
pnpm --filter fateclaw-web build
```

For documentation changes, at least verify that Markdown links, commands, and paths still resolve.

## Pull request contents

A PR description should include:

- The problem being solved.
- The main changes.
- Validation commands you ran.
- Anything left unverified and why.
- Whether the change affects the database, environment variables, model providers, OpenClaw/iLink, or GPLv3 licensing boundaries.

Use [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) when submitting a PR: select the appropriate change type and provide the requested details.

## Security issues

Do not report security vulnerabilities in public issues. Follow the reporting process in [SECURITY.md](SECURITY.md).
