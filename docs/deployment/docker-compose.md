---
title: Docker Compose Deployment
---

# Docker Compose Deployment

This guide starts Focowiki from the production Docker Compose template and GitHub Container Registry images.

## Requirements

Production deployment requires:

| Service | Purpose |
| --- | --- |
| PostgreSQL | Product records, source-file processing records, graph nodes, graph edges, releases, generated file records, OpenAPI key records, and audit evidence. |
| Redis | Sessions, rate limits, cursors, coordination, locks, and short-lived source-file refresh state. |
| S3-compatible storage | Uploaded source files and generated public bundles, including `_graph/` files. |
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

## Upgrade Sequence

Use this sequence for an existing deployment:

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
docker compose -f docker-compose.yml ps
```

After startup, open Admin UI and verify knowledge-base lists, file previews, Worker status, and Developer OpenAPI health.

## Run Migration Check

```bash
docker compose -f docker-compose.yml run --rm migrate
```

The migration container uses the API image and exits after database migration completes. This command is a useful explicit check before startup. The production Compose template also wires the `api` service to the `migrate` service, so `docker compose -f docker-compose.yml up -d` runs migration before the API starts.

Existing deployments use the same migration path during upgrades. The migration adds runtime settings tables and preserves existing knowledge-base data. On the first startup after upgrade, Focowiki seeds Admin Settings from startup defaults when saved Admin UI settings do not already exist.

After upgrading from a release that used env-provided session signing, existing Admin UI sessions may require signing in again. Knowledge bases, OpenAPI keys, files, and saved runtime settings remain in place.

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

4. Run migration and start the stack.

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

5. Verify Admin UI login, knowledge-base list, file preview, Developer OpenAPI health, and Worker status.

## Graph Processing Notes

Focowiki stores file graph nodes, graph edges, and graph job records in PostgreSQL. Redis coordinates locks and pagination state during processing. Generated graph files are published to S3-compatible storage with the active bundle.

Keep graph processing bounded by Admin UI runtime settings. Avoid custom scripts that load the full source corpus or full graph into process memory.

See [Admin Settings](./admin-settings.md) for Worker, publication, upload generation, rate-limit, and model configuration.

For unreleased development deployments, data can be rebuilt destructively. Stop the stack, run `pnpm compose:clean`, remove the local `data`, `runtime-secrets`, and `logs` directories when needed, start the stack again, run migrations, and upload Markdown files to regenerate graph-backed bundles.
