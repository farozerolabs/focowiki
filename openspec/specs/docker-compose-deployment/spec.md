# docker-compose-deployment Specification

## Purpose

Define Docker Compose deployment templates, production container builds, runtime configuration boundaries, and validation expectations for self-hosted Focowiki deployments.

## Requirements

### Requirement: Docker Compose deployment mode
Focowiki SHALL provide Docker Compose templates for running the application stack while preserving the pnpm local development workflow through explicit development templates.

#### Scenario: Existing local workflow is preserved
- **WHEN** the Docker Compose deployment files are added
- **THEN** `pnpm install`, `docker compose -f docker-compose.dev.yml up -d postgres redis`, `pnpm --filter @focowiki/api db:migrate`, `pnpm dev`, `pnpm verify`, and `pnpm build` MUST remain documented and usable
- **AND** the existing infrastructure-only development Compose behavior MUST move to committed template `docker-compose.dev.yml.example`
- **AND** real local `docker-compose.dev.yml` MUST be generated from that template and ignored by git
- **AND** the development env template MUST move to `.env.dev.example`

#### Scenario: Deployment Compose template is committed
- **WHEN** an operator prepares default Compose deployment commands
- **THEN** committed template `docker-compose.yml.example` MUST describe the application deployment stack
- **AND** real local `docker-compose.yml` MUST be generated from that template and ignored by git
- **AND** committed template `.env.example` MUST describe deployment configuration rather than local pnpm development-only configuration

#### Scenario: Real Compose files are not committed
- **WHEN** contributors commit deployment changes
- **THEN** `docker-compose.yml` and `docker-compose.dev.yml` MUST NOT be tracked git files
- **AND** `docker-compose.yml.example` and `docker-compose.dev.yml.example` MUST be tracked git templates
- **AND** documentation MUST tell operators to copy templates before running Compose

#### Scenario: Deployment Compose stack starts application services
- **WHEN** an operator starts the deployment Compose stack with a valid deployment environment file
- **THEN** Compose MUST run Admin UI, Admin API, public OpenAPI, PostgreSQL, and Redis services
- **AND** Admin UI, Admin API, and public OpenAPI MUST use distinct configured high ports
- **AND** PostgreSQL and Redis MUST use persistent volumes or externally configured persistent services
- **AND** S3-compatible storage MUST be provided as an external endpoint through runtime environment variables

#### Scenario: Deployment supports reverse proxy usage
- **WHEN** the deployment is configured behind a trusted reverse proxy
- **THEN** the deployment documentation MUST show how to configure public origins, allowed hosts, trusted origins, secure cookies, Admin API origin, public OpenAPI origin, and proxy trust settings
- **AND** public URLs MUST NOT expose internal Compose service names, S3 buckets, S3 prefixes, object keys, database URLs, Redis URLs, or credentials

### Requirement: Multi-stage minimal application images
Focowiki SHALL build application containers through multi-stage Docker builds that keep build dependencies and local-only files out of runtime images.

#### Scenario: API image is production runtime only
- **WHEN** the API image is built
- **THEN** the runtime stage MUST contain compiled API JavaScript, required runtime package metadata, production dependencies, migrations needed by the migration command, and compiled workspace package output
- **AND** it MUST NOT require TypeScript source execution, Vite dev server, pnpm workspace build cache, test files, local `.env` files, local datasets, OpenSpec reports, or repository `.git` metadata at runtime

#### Scenario: Admin image serves static assets
- **WHEN** the Admin UI image is built
- **THEN** the runtime stage MUST serve built static Admin UI assets from `apps/admin/dist`
- **AND** it MUST NOT run the Vite development server in deployment mode
- **AND** it MUST provide SPA fallback and security headers compatible with the existing Admin UI security baseline

#### Scenario: Docker build context is safe
- **WHEN** Docker builds application images
- **THEN** `.dockerignore` MUST exclude local environment files and real Compose files except committed examples, node_modules, git metadata, local legal datasets, validation reports, OpenSpec runtime artifacts, temporary output, and other local-only files
- **AND** Dockerfiles MUST NOT copy credentials, model keys, S3 secrets, session secrets, local paths, or raw validation data into images

### Requirement: Deployment environment and secrets
Focowiki SHALL provide deployment configuration templates that make production environment requirements explicit without committing secrets.

#### Scenario: Deployment env template is complete
- **WHEN** an operator copies the default deployment env template
- **THEN** the template MUST include Admin UI, Admin API, public OpenAPI, PostgreSQL, Redis, S3-compatible storage, upload limits, pagination, rate limits, security, public API auth, and optional model assistance fields
- **AND** placeholder values MUST be clearly marked as placeholders and MUST NOT be valid production secrets

#### Scenario: Production mode rejects unsafe defaults
- **WHEN** the Compose deployment runs with `APP_ENV=production`
- **THEN** startup MUST rely on the existing production runtime validation for strong session secrets, secure cookie settings, allowed hosts, trusted origins, public origins, and non-placeholder storage credentials
- **AND** container documentation MUST tell operators to generate deployment-specific secrets instead of using example values

#### Scenario: External S3-compatible storage is required
- **WHEN** an operator configures the Compose deployment
- **THEN** the Compose deployment MUST NOT start MinIO or any bundled S3-compatible storage service
- **AND** the API MUST use only the configured `S3_ENDPOINT`, bucket, region, credentials, prefix, and path-style mode
- **AND** upload parsing MUST fail through the normal storage error path if the configured external S3-compatible store is unavailable

### Requirement: Compose lifecycle and health validation
Focowiki SHALL provide deterministic lifecycle commands and checks for building, migrating, starting, validating, and stopping the Compose deployment.

#### Scenario: Migration runs as an explicit deployment step
- **WHEN** the deployment stack is prepared
- **THEN** Compose MUST provide a one-shot migration service or documented command that runs the API database migrations against the configured PostgreSQL service
- **AND** the API service MUST NOT be considered ready until PostgreSQL, Redis, and required migrations are ready

#### Scenario: Health checks cover runtime services
- **WHEN** the deployment stack is running
- **THEN** PostgreSQL, Redis, Admin API, public OpenAPI, and Admin UI MUST have health checks or validation commands
- **AND** external S3-compatible storage MUST be validated by upload/openAPI release-gate flows using the configured endpoint
- **AND** failures MUST be visible through `docker compose ps`, logs, or validation scripts without requiring shell access inside containers

#### Scenario: Deployment validation covers product flow
- **WHEN** deployment validation runs against the Compose stack
- **THEN** it MUST verify Admin UI is reachable, Admin API authentication behavior works, public OpenAPI is reachable, migrations have run, Redis is used for coordination, PostgreSQL is the durable source of truth, and S3-compatible storage persists raw and generated file bodies
- **AND** it MUST verify the deployment does not depend on process memory for task state, file trees, indexes, pagination cursors, sessions, rate limits, or upload progress

### Requirement: Deployment documentation
Focowiki SHALL document the Docker Compose deployment path clearly for open-source self-hosting.

#### Scenario: Operator follows local Compose deployment docs
- **WHEN** an operator follows the deployment documentation on a local machine
- **THEN** they MUST be able to copy `docker-compose.yml.example` to `docker-compose.yml`, copy `.env.example` to root `.env`, build images, run migrations, start the deployment stack, open Admin UI, and reach public OpenAPI without using pnpm directly on the host
- **AND** the Compose file MUST rely on the root `.env` file instead of temporary env files or inline fallback runtime defaults

#### Scenario: Operator follows production reverse proxy docs
- **WHEN** an operator deploys behind a domain reverse proxy
- **THEN** the documentation MUST describe required public origins, host allowlist, trusted proxy mode, HTTPS requirements, cookie security, public API auth, S3 exposure rules, and which internal ports should remain private
- **AND** it MUST state that Admin UI, Admin API, public OpenAPI, PostgreSQL, Redis, and external S3-compatible storage should not all be exposed blindly to the public internet

#### Scenario: Image and Compose validation is documented
- **WHEN** contributors modify deployment files
- **THEN** the repository MUST document validation commands for Docker build, Compose config validation, migration service execution, service startup, health checks, and smoke tests
- **AND** validation MUST include checks that deployment files do not introduce hardcoded credentials, local absolute paths, or private dataset names
