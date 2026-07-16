# Contributing to Focowiki

Thank you for contributing to Focowiki. The project is a Markdown-native, file-first knowledge base for people, applications, and agents. Contributions should keep it lightweight, modular, and safe for self-hosted deployments.

## Repository Workflow

`main` and `dev` are protected branches. All changes must reach them through pull requests, pass the required `Validate` check, and have every review conversation resolved.

- `main` contains stable, release-ready code.
- `dev` is the integration branch for the next release.
- Short-lived branches contain individual features, fixes, documentation updates, or maintenance work.
- Release tags are created only from commits already contained in `main`.

Use a branch name that describes the change:

- `feature/<name>` for product or API capabilities.
- `fix/<name>` for defect corrections.
- `docs/<name>` for documentation-only changes.
- `chore/<name>` for dependencies, CI, and repository maintenance.

Start new work from the latest `dev` branch:

```bash
git fetch origin
git switch dev
git pull --ff-only origin dev
git switch -c feature/short-description
```

External contributors can create the same branch from `upstream/dev` in their fork. Keep branches focused and avoid combining unrelated features, refactors, and documentation changes.

Commit the completed change and open a pull request against `dev`:

```bash
git add .
git commit -m "Describe the change"
git push -u origin feature/short-description
gh pr create --base dev --head feature/short-description
```

## Local Setup

Development requires Node.js 24, pnpm 11.7.0, and Docker with Docker Compose.

```bash
corepack enable
corepack prepare pnpm@11.7.0 --activate
pnpm install
cp .env.dev.example .env
cp docker-compose.local.yml.example docker-compose.local.yml
pnpm compose:local:up
pnpm --filter @focowiki/api db:migrate
pnpm dev
```

Local service URLs:

- Admin UI: `http://127.0.0.1:43100`
- Admin API: `http://127.0.0.1:43000`
- Developer OpenAPI: `http://127.0.0.1:43200`

Do not commit `.env`, credentials, local storage, logs, runtime secrets, or test data containing private information.

## Validation

Run the checks that cover the affected behavior before opening a pull request. The standard validation suite is:

```bash
pnpm verify
pnpm build
```

Run these additional checks when their corresponding surfaces change:

```bash
pnpm openapi:validate
pnpm docs:validate
pnpm test:validation
```

For Docker or deployment changes, validate every maintained Compose template:

```bash
pnpm compose:example:config
pnpm compose:dev:example:config
pnpm compose:local:example:config
```

Frontend changes require browser verification of the affected desktop and mobile workflows. API changes require request, response, authentication, and error-envelope verification. Database changes require migration testing against both a new database and an existing compatible database.

## Coding Guidelines

- Keep modules small, cohesive, and loosely coupled.
- Preserve file-first behavior and the public contracts that connect files, graph records, generated content, and OpenAPI responses.
- Prefer PostgreSQL, Redis, and S3-compatible storage for durable state, queues, pagination, caches, locks, and large data flows.
- Avoid full-corpus in-memory processing, unbounded lists, full-tree scans, and process-local cross-request state.
- Keep user-facing text in the English and Chinese i18n resources.
- Use English for source code, comments, tests, logs, error messages, and example data.
- Update documentation when public behavior, configuration, deployment, migrations, or OpenAPI contracts change.
- Add focused tests for defects and expand coverage when a change affects shared workflows or data contracts.

## Pull Requests

Open regular development pull requests against `dev`. Only maintainers should open release pull requests from `dev` to `main`.

Every pull request should include:

- A concise summary of the behavior being changed.
- The validation commands and manual checks performed.
- Compatibility, migration, deployment, or configuration notes when applicable.
- Screenshots for visible Admin UI or documentation changes.
- Related issues or proposals when they provide necessary context.

Before merging:

- The `Validate` check must pass against the latest target branch.
- Every review conversation must be resolved.
- The pull request must remain focused and free of unrelated generated files or local artifacts.

Use **Squash and merge** for short-lived branches entering `dev`. Use **Create a merge commit** for release pull requests from `dev` to `main`; this preserves the ancestry of the persistent integration branch.

## Releases

Release publishing is performed from `main` by maintainers. A `v*` tag triggers the Docker image and documentation publishing workflows. Do not tag a feature branch or an unmerged commit.

## Security Reports

Follow [SECURITY.md](SECURITY.md) for vulnerability reports. Do not disclose security issues in a public issue or pull request before the maintainer has reviewed them.
