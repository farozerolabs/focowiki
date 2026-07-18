---
title: Docker Compose Deployment
---

# Docker Compose Deployment

This guide starts Focowiki from the production Docker Compose template and GitHub Container Registry images.

## Requirements

Production deployment requires:

| Service | Purpose |
| --- | --- |
| PostgreSQL | Source revisions, durable role jobs, publication generations, projection records, OpenAPI keys, settings, and audit evidence. |
| Redis | Sessions, rate limits, cursors, short-lived caches, notifications, and scoped coordination. |
| S3-compatible storage | Uploaded source revisions and content-addressed generated Markdown and projection objects. |
| Reverse proxy | HTTPS public origins for Admin UI, Admin API, and Developer OpenAPI. |

The Compose template starts PostgreSQL and Redis. Configure an external S3-compatible service in `.env`.

## Prepare Files

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis runtime-secrets logs backups
```

Fill `.env` before starting the stack. See [Environment Configuration](./environment.md) for every startup variable, required values, optional values, and production examples. Runtime values changed from Admin UI are documented in [Admin Settings](./admin-settings.md).

Keep real `.env` files and copied Compose files out of git.

## Runtime Logging

`APP_ENV=production` uses production-safe runtime behavior. API error responses keep internal diagnostics out of the response body, and Admin UI production builds remove product-authored `console.log`, `console.debug`, `console.info`, and `debugger` statements.

See [Environment Configuration](./environment.md#runtime) for file logging, log rotation, and Docker log limits.

## Pull Images

```bash
docker compose -f docker-compose.yml pull
```

The template uses these images by default:

| Image | Default tag |
| --- | --- |
| `ghcr.io/farozerolabs/focowiki-api` | `latest` |
| `ghcr.io/farozerolabs/focowiki-admin` | `latest` |

To pin a release, set the image variables in `.env`.

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

## Backup Before Upgrade

Create a cold backup before pulling new images or running migrations on an existing deployment. Run the command from the deployment directory that contains `.env` and `docker-compose.yml`.

```bash
docker compose -f docker-compose.yml down
backup_id="$(date +%Y%m%d-%H%M%S)" && mkdir -p backups data/postgres data/redis runtime-secrets logs && tar -czf "backups/focowiki-$backup_id.tar.gz" .env docker-compose.yml data runtime-secrets logs
```

This archive contains the Compose file, `.env`, PostgreSQL data, Redis data, runtime secrets, and product log files for the local deployment.

Back up the external S3-compatible bucket or prefix with your storage provider snapshot, replication, export, or S3-compatible copy tool. PostgreSQL and S3 backups should come from the same deployment point.

Keep previous application images with the matching PostgreSQL and S3 backups until the new deployment has been verified. Rollback requires restoring the image, PostgreSQL data, Redis data, runtime secrets, and S3 prefix from the same deployment point.

Check the backup file before continuing.

```bash
ls -lh "backups/focowiki-$backup_id.tar.gz"
```

The directory backup applies to deployments using the current Compose template. Older deployments that still use Docker named volumes can continue using their existing Compose file, or create a database dump before moving to directory mounts.

For database-only backups, use `pg_dump`.

```bash
docker compose -f docker-compose.yml exec -T postgres \
  sh -lc 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "backups/postgres-$(date +%Y%m%d-%H%M%S).dump"
```

Restore database-only backups with `pg_restore` after starting PostgreSQL.

## Deploy the Current Data Generation

This release uses a new data generation and does not perform an in-place upgrade from an earlier schema. Keep the coordinated backup, clear the local data directories, and use an empty dedicated S3 prefix before starting this release.

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml down
mv data "data-before-incremental-publication-$(date +%Y%m%d-%H%M%S)"
mkdir -p data/postgres data/redis
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
```

Use a new `S3_PREFIX` or empty the dedicated test prefix through the storage provider before migration. Re-upload retained source Markdown through Admin UI or Developer OpenAPI. After startup, verify the knowledge-base list, file preview, source queue, publication progress, active file tree, search, graph, and Developer OpenAPI health.

## Run Migration Check

```bash
docker compose -f docker-compose.yml run --rm migrate
```

The migration container uses the same API image as the HTTP and Worker roles and exits after database initialization. The production template starts the API and all three Worker roles only after migration completes.

The migration command initializes the database schema and default Admin settings required by the current application.

### Incompatible Schema Generation

The current release requires the schema generation shipped with its migration image. When the migration command reports an incompatible schema generation, keep the existing deployment stopped and retain its coordinated PostgreSQL and S3 backup. Start the current release with an empty deployment data directory and an empty configured S3 prefix, then upload the retained source Markdown through the supported Admin or Developer OpenAPI workflow.

Do not start the new runtime against an incompatible database, and do not delete the previous backup until generated files, source rows, search, graph exploration, and file reads have been verified.

## Start Services

```bash
docker compose -f docker-compose.yml up -d
```

Default service URLs depend on your `.env` ports:

| Service | Local URL pattern |
| --- | --- |
| Admin UI | `http://127.0.0.1:${ADMIN_UI_PORT}` |
| Admin API | `http://127.0.0.1:${ADMIN_API_PORT}` |
| Developer OpenAPI | `http://127.0.0.1:${PUBLIC_OPENAPI_PORT}` |

For public deployment, place Admin UI, Admin API, and Developer OpenAPI behind HTTPS origins configured in `.env`.

## Common Commands

```bash
pnpm compose:config
pnpm compose:pull
pnpm compose:migrate
pnpm compose:up
pnpm compose:ps
pnpm compose:logs
pnpm compose:down
pnpm compose:clean
```

Use `docker compose logs -f` for container stdout/stderr logs. See [Environment Configuration](./environment.md#runtime) for product runtime log files.

`pnpm compose:clean` removes deployment containers, Docker-managed named volumes, orphans, and local image copies used by the production Compose stack. Directory-mounted data under `data`, `runtime-secrets`, and `logs` remains in the deployment directory. Remove those directories manually only when you intentionally want to delete local deployment data.

## After Startup

1. Open Admin UI.
2. Sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
3. Create a knowledge base.
4. Create or copy an OpenAPI key from the Admin UI.
5. Use the key with Developer OpenAPI.

Continue with [Developer OpenAPI](../openapi/index.md).

## Publication Failure Diagnosis

The source-file list exposes one lifecycle state, current stage, safe failure details, and authorized actions. A row with `state=failed` identifies the terminal stage and includes a correlation ID suitable for matching product logs.

Use **Retry processing** for a source-processing failure. Use **Retry publication** for required projection validation or generation activation failure. Publication retry keeps completed source facts and resumes the coalesced generation. A deterministic validation failure requires an explicit retry after its cause is corrected.

Generated content becomes readable only after the row reaches `state=visible`. A candidate generation remains hidden until changed projections pass validation and activation succeeds. The previous active generation remains readable when a candidate fails.

## Restore From Backup

Restore only into the intended deployment directory. Create a fresh backup of the current state before continuing.

1. Stop the stack.

   ```bash
   docker compose -f docker-compose.yml down
   ```

2. Extract the backup archive in the deployment directory.

   ```bash
   tar -xzf backups/focowiki-<backup-id>.tar.gz
   ```

3. Restore or copy the external S3-compatible bucket or prefix to the location configured in `.env`.

4. Set the API and Admin image tags to the versions captured by the backup.

5. Run migration and start the stack.

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

6. Verify Admin UI login, knowledge-base list, file preview, Developer OpenAPI health, and Worker status.

## Graph Processing Notes

Focowiki stores body-grounded graph facts and active graph projections in PostgreSQL. Redis provides short-lived coordination and query caching. Generated graph Markdown and machine shards are immutable S3 objects referenced by the active generation.

Keep graph processing bounded by Admin UI runtime settings. Avoid custom scripts that load the full source corpus or full graph into process memory.

See [Admin Settings](./admin-settings.md) for API rate limits, Worker, publication, graph, and model configuration.
