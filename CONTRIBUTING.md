# Contributing to Focowiki

Thank you for your interest in contributing to Focowiki.

Focowiki is a Markdown-native, file-first knowledge base for people, applications, and agents. Contributions should keep the project lightweight, modular, and safe for self-hosted deployments.

## Development Flow

- Use `dev` for day-to-day development.
- Open pull requests into `main` only when the change is stable and release-ready.
- Release tags should be created from commits already contained in `main`.
- Keep pull requests focused. Avoid mixing unrelated refactors, feature work, and documentation updates.

## Local Setup

```bash
pnpm install
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
docker compose -f docker-compose.local.yml up -d postgres redis
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Local service URLs:

- Admin UI: `http://127.0.0.1:43100`
- Admin API: `http://127.0.0.1:43000`
- Developer OpenAPI: `http://127.0.0.1:43200`

## Validation

Before opening a pull request, run the checks that match your change:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm openapi:validate
pnpm docs:validate
```

For Docker or deployment changes, also validate the Compose templates:

```bash
cp .env.example .env
pnpm compose:example:config
cp .env.dev.example .env
pnpm compose:dev:example:config
pnpm compose:local:example:config
```

## Coding Guidelines

- Keep code modular and low-coupled.
- Prefer PostgreSQL, Redis, and S3-compatible storage for durable state, queueing, pagination, and large data flows.
- Avoid large in-memory lists, full-tree scans, and cross-request process memory state.
- Keep user-facing UI text in i18n resources.
- Use English for source code, comments, tests, logs, and example data.
- Update documentation when public behavior, configuration, deployment, or OpenAPI contracts change.

## Pull Requests

Every pull request should include:

- A clear summary of the change.
- Testing performed.
- Any migration, deployment, or compatibility notes.
- Screenshots for visible Admin UI changes.

The `Validate` GitHub Actions check must pass before a pull request can be merged into `main`.
