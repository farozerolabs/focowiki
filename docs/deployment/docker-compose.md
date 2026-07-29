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
| Meilisearch | File, graph-seed, and hybrid search indexes. Search data can be restored from backup or rebuilt from PostgreSQL and S3-compatible storage. |
| S3-compatible storage | Uploaded source revisions and content-addressed generated Markdown and projection objects. |
| Reverse proxy | HTTPS public origins for Admin UI, Admin API, and Developer OpenAPI. |

The Compose template starts PostgreSQL, Redis, and a private Meilisearch service. Configure an external S3-compatible service in `.env`.

## Prepare Files

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis data/meilisearch data/meilisearch-snapshots data/meilisearch-dumps runtime-secrets logs backups
```

Fill `.env` before starting the stack. See [Environment Configuration](./environment.md) for every startup variable, required values, optional values, and production examples. Runtime values changed from Admin UI are documented in [Admin Settings](./admin-settings.md).

Keep real `.env` files and copied Compose files out of git.

The default `COMPOSE_PROFILES=bundled-search` starts the included Meilisearch service without publishing its port to the host. Authenticated metrics are enabled so the Worker can pause new indexing submissions under resource pressure. To use a managed or separately deployed Meilisearch service, leave `COMPOSE_PROFILES` empty, enable its metrics endpoint, and set its private endpoint and scoped runtime key in `.env`.

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

## Update an Existing Deployment

Read the release notes before updating. They state whether the release changes the database, requires asynchronous work to finish first, or changes knowledge-base indexes.

1. Back up PostgreSQL, Meilisearch, and the configured S3-compatible storage.
2. Update the image tags in `.env`, then pull the images.
3. Follow any drain requirement in the release notes before stopping the current services.
4. Run the database migration command.
5. Start the updated services.

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

The migration command updates the database structure and is safe to run again after it succeeds. It does not rebuild knowledge-base indexes or process source files.

When a release changes generated indexes, the knowledge-base page reports whether maintenance is required. The existing active content remains readable while maintenance is waiting or running. In manual mode, start maintenance for each affected knowledge base from its settings. In automatic mode, Focowiki can schedule affected knowledge bases in bounded background work, and the manual action remains available when that knowledge base is idle.

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

## Backup

From the deployment directory that contains `.env` and `docker-compose.yml`, stop the services and archive the local persistent directories.

```bash
docker compose -f docker-compose.yml down
backup_id="$(date +%Y%m%d-%H%M%S)" && mkdir -p backups data/postgres data/redis runtime-secrets logs && tar -czf "backups/focowiki-$backup_id.tar.gz" .env docker-compose.yml data runtime-secrets logs
```

Back up the external S3-compatible bucket or prefix separately with the storage provider's snapshot, replication, or export feature. PostgreSQL and S3 backups should represent the same point in time.

The bundled search service writes one snapshot per day to `data/meilisearch-snapshots`. Snapshots are for same-version recovery. Create and retain a Meilisearch dump before changing the Meilisearch version, and keep copied snapshots or dumps outside the deployment server.

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

6. Verify Admin UI login, knowledge-base list, file preview, search, Developer OpenAPI health, and Worker status.

If the search data directory, snapshot, or dump is unavailable, restore PostgreSQL and S3-compatible storage first, start the services, then run **Maintain index** for each affected knowledge base. Existing files remain readable while search data is rebuilt.

## Graph Processing Notes

Focowiki stores body-grounded graph facts and active graph projections in PostgreSQL. Redis provides short-lived coordination and query caching. Generated graph Markdown and machine shards are immutable S3 objects referenced by the active generation.

Keep graph processing bounded by Admin UI runtime settings. Avoid custom scripts that load the full source corpus or full graph into process memory.

See [Admin Settings](./admin-settings.md) for API rate limits, Worker, publication, graph, and model configuration.
