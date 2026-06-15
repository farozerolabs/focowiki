## 1. Existing Deployment Review

- [x] 1.1 Inspect existing `docker-compose.yml`, `.env.example`, `.gitignore`, package scripts, API entrypoints, Admin UI build/runtime behavior, env templates, and README deployment guidance.
- [x] 1.2 Confirm the current pnpm local workflow remains the baseline developer workflow and identify docs/tests that must move to `docker-compose.dev.yml.example` and `.env.dev.example`.
- [x] 1.3 Confirm API runtime requirements for compiled workspace packages, migrations, Admin API port, public OpenAPI port, PostgreSQL, Redis, S3-compatible storage, and optional model assistance.
- [x] 1.4 Confirm Admin UI runtime requirements for static serving, SPA fallback, security headers, Admin API base URL, and reverse proxy behavior.

## 2. Red Tests And Safety Checks

- [x] 2.1 Add focused tests that assert committed `docker-compose.dev.yml.example` defines PostgreSQL and Redis for local development.
- [x] 2.2 Add focused tests for committed `docker-compose.yml.example` deployment structure before implementation: Admin UI, API, migrate, PostgreSQL, Redis, external S3 configuration, health checks, high ports, volumes, and service dependencies.
- [x] 2.3 Add focused tests for Dockerfile multi-stage targets: dependency/build stage, API runtime target, Admin runtime target, no Vite dev server in Admin runtime, and no test/local files copied into runtime.
- [x] 2.4 Add focused tests for `.dockerignore` excluding local env files, real Compose files, node_modules, git metadata, local datasets, OpenSpec reports, build cache, and temporary output.
- [x] 2.5 Add focused tests for `.env.dev.example` and default deployment `.env.example` completeness without production-valid secrets.
- [x] 2.6 Add focused tests that `docker-compose.yml` and `docker-compose.dev.yml` are gitignored and that only their `.example` templates are tracked.

## 3. Docker Build Implementation

- [x] 3.1 Add `.dockerignore` with explicit exclusions for secrets, local paths, datasets, node_modules, git metadata, OpenSpec reports, test output, and build cache.
- [x] 3.2 Add a root multi-stage Dockerfile using pnpm and the lockfile for reproducible workspace installs.
- [x] 3.3 Implement the build stage so it runs TypeScript/Vite builds for the API, Admin UI, and workspace packages.
- [x] 3.4 Implement the API runtime target with compiled JavaScript, production dependencies, required package metadata, migration files, and compiled workspace package output.
- [x] 3.5 Ensure the API runtime can execute the server and migration entrypoints without TypeScript source execution.
- [x] 3.6 Implement the Admin runtime target with only built static assets and a minimal static server configuration.
- [x] 3.7 Configure Admin runtime SPA fallback and security headers that match the product security baseline.

## 4. Compose Deployment Implementation

- [x] 4.1 Rename the current development Compose file to committed template `docker-compose.dev.yml.example` and keep its PostgreSQL/Redis local-development behavior.
- [x] 4.2 Add committed deployment template `docker-compose.yml.example` for the application stack.
- [x] 4.3 Define `api` service that exposes configured Admin API and public OpenAPI high ports from one runtime container.
- [x] 4.4 Define `admin` service that serves the production Admin UI build on its configured high port.
- [x] 4.5 Define `migrate` one-shot service that runs database migrations using the same API image and deployment env.
- [x] 4.6 Define PostgreSQL and Redis services with persistent named volumes and health checks.
- [x] 4.7 Require external S3-compatible storage through environment configuration instead of starting bundled object storage.
- [x] 4.8 Wire Compose dependencies so application services wait for healthy infrastructure and migrations where Compose supports it.
- [x] 4.9 Support external S3-compatible storage through env configuration without starting bundled S3.
- [x] 4.10 Update `.gitignore` so real local `docker-compose.yml` and `docker-compose.dev.yml` are ignored while `docker-compose.yml.example` and `docker-compose.dev.yml.example` remain trackable.

## 5. Deployment Configuration And Documentation

- [x] 5.1 Rename the current local development env template to `.env.dev.example` and update local setup docs.
- [x] 5.2 Add default deployment `.env.example` with all required Admin UI, Admin API, public OpenAPI, PostgreSQL, Redis, S3, upload, pagination, rate-limit, security, public API auth, and model fields.
- [x] 5.3 Ensure deployment env examples use placeholders and do not contain real credentials, local absolute paths, private dataset names, or production-valid weak secrets.
- [x] 5.4 Add package scripts or documented commands for copying Compose templates and running deployment Compose build, migrate, up, down, logs, ps, and validation.
- [x] 5.5 Update README with local Compose deployment steps that copy `docker-compose.yml.example` to local `docker-compose.yml` and do not require pnpm on the host after images are built.
- [x] 5.6 Update README with reverse proxy guidance for origins, allowed hosts, trusted origins, secure cookies, exposed ports, private internal services, and public OpenAPI base URL.
- [x] 5.7 Document rollback and pre-release destructive reset commands for deployment volumes.

## 6. Compose Validation

- [x] 6.1 Run `pnpm verify` after adding deployment files and tests.
- [x] 6.2 Run `pnpm build` to confirm the normal local build remains valid.
- [x] 6.3 Run `docker compose -f docker-compose.yml.example config` to validate deployment Compose template syntax and env interpolation.
- [x] 6.4 Run `docker compose -f docker-compose.dev.yml.example config` to validate development Compose template syntax and env interpolation.
- [x] 6.5 Run Docker image builds for API and Admin runtime targets.
- [x] 6.6 Run the migration service against the Compose PostgreSQL service.
- [x] 6.7 Start the deployment Compose stack and verify health for PostgreSQL, Redis, Admin API, public OpenAPI, and Admin UI.
- [x] 6.8 Verify Admin UI login page is reachable, Admin API protected routes reject unauthenticated requests, and public OpenAPI root/file behavior responds through configured ports.
- [x] 6.9 Upload at least one real `.md` file through the deployed stack or run an existing bounded validation flow against the Compose deployment with configured external S3 to prove PostgreSQL, Redis, and S3 persistence boundaries.
- [x] 6.10 Inspect built images or metadata to confirm local `.env`, credentials, local paths, raw Markdown datasets, OpenSpec reports, and `.git` metadata are not present in runtime images.
- [x] 6.11 Confirm `git status --short` does not include real local `docker-compose.yml` or `docker-compose.dev.yml` after validation.

## 7. Final Verification

- [x] 7.1 Run `pnpm validate:no-local-paths`.
- [x] 7.2 Run OpenSpec validation for `add-docker-compose-deployment`.
- [x] 7.3 Review final diff for hardcoded secrets, local paths, floating unsafe production defaults, broken existing commands, and overgrown deployment logic.
- [x] 7.4 Record any Docker/Compose validation warnings, image size observations, manual reverse-proxy follow-up, and unresolved deployment risks in the implementation summary.
