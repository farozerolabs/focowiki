## Why

Focowiki currently supports local pnpm development and a Compose file for infrastructure dependencies, but it does not provide a production-oriented Docker Compose deployment path for the application services. Adding a Compose deployment option makes the project easier to self-host while preserving the existing lightweight local workflow.

## What Changes

- Move the current development infrastructure Compose content into a committed development template.
- Add a committed deployment Compose template for running Admin UI, Admin API, public OpenAPI, PostgreSQL, and Redis as separate services while using an externally configured S3-compatible store.
- Keep real local Compose files out of git; operators copy templates to local Compose files before running them.
- Add multi-stage Docker builds for application images so build dependencies stay out of runtime images.
- Keep runtime images minimal, production-oriented, and free of source-only/dev-only files where practical.
- Keep the existing pnpm local development workflow unchanged.
- Add deployment environment templates and documentation for reverse proxy, high ports, persistence volumes, migrations, health checks, and secrets.
- Add validation that Compose deployment builds, starts, migrates, serves Admin UI/Admin API/public OpenAPI, and keeps storage/database/Redis state outside process memory.

## Capabilities

### New Capabilities

- `docker-compose-deployment`: Production-oriented Docker Compose deployment for Focowiki using multi-stage minimal application images and persistent service dependencies.

### Modified Capabilities

- None.

## Impact

- Renames the current local development Compose file to committed template `docker-compose.dev.yml.example` and the current local development env template to `.env.dev.example`.
- Adds Dockerfile or Dockerfiles, `.dockerignore`, committed deployment template `docker-compose.yml.example`, deployment `.env.example`, and deployment documentation.
- Adds `.gitignore` coverage so real local `docker-compose.yml` and `docker-compose.dev.yml` are not committed.
- May add package scripts for Compose build/start/stop/logs/migration validation.
- May add lightweight static serving for the built Admin UI if the current Vite dev server is unsuitable for production containers.
- Must not remove or break existing `pnpm install`, development infrastructure startup from a copied `docker-compose.dev.yml`, `pnpm --filter @focowiki/api db:migrate`, `pnpm dev`, `pnpm verify`, or `pnpm build` workflows.
- Must keep secrets in environment files or Compose secrets and avoid baking `.env`, credentials, local paths, S3 keys, model keys, or session secrets into images.
- Compose templates must rely on the root `.env` file for runtime configuration and must not inline temporary env blocks or fallback defaults for application configuration.
