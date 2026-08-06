---
title: Docker Compose Deployment
---

# Docker Compose Deployment

This guide starts Focowiki from the production Docker Compose template and the published GitHub Container Registry images.

## Requirements

Production deployment requires:

| Service | Purpose |
| --- | --- |
| PostgreSQL | Knowledge bases, file records, processing state, settings, OpenAPI keys, and relationship data. |
| Redis | Login sessions, rate limits, pagination, and short-lived task state. |
| Meilisearch | One search index for each knowledge base. |
| S3-compatible storage | Uploaded Markdown and generated knowledge-base files. |
| Reverse proxy | HTTPS access to Admin UI, Admin API, and Developer OpenAPI. |

The template starts PostgreSQL, Redis, and an optional private Meilisearch service. Configure an external S3-compatible service in `.env`.

## Prepare Files

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis data/meilisearch data/meilisearch-snapshots data/meilisearch-dumps runtime-secrets logs backups
```

Fill `.env` before starting. See [Environment Configuration](./environment.md) for every production variable. Settings changed after startup are documented in [Admin Settings](./admin-settings.md).

Keep the real `.env` and copied `docker-compose.yml` out of git.

## Services Started by the Template

| Compose service | Description |
| --- | --- |
| `admin` | Admin UI. |
| `api` | Admin API and Developer OpenAPI. |
| `source-worker` | Processes uploaded Markdown files. |
| `publication-worker` | Makes completed file updates available to readers. |
| `maintenance-worker` | Runs search and storage maintenance. |
| `migrate` | Checks and updates the database before application services start. |
| `postgres` | PostgreSQL database. |
| `redis` | Redis service. |
| `meilisearch` | Optional included search service, enabled by `COMPOSE_PROFILES=bundled-search`. |
| `meilisearch-init` | Prepares search access during startup. |

The production template publishes Admin UI, Admin API, and Developer OpenAPI only on `127.0.0.1`. PostgreSQL, Redis, and Meilisearch remain private to the Compose network.

## Pull Images

```bash
docker compose -f docker-compose.yml pull
```

The image variables default to `latest`. Pin both images to the same release tag in production.

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:0.0.1
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:0.0.1
```

## Start Services

Run the database command once before the first start, then start the stack.

```bash
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

Default local addresses use the ports from `.env`:

| Service | Local URL |
| --- | --- |
| Admin UI | `http://127.0.0.1:${ADMIN_UI_PORT}` |
| Admin API | `http://127.0.0.1:${ADMIN_API_PORT}` |
| Developer OpenAPI | `http://127.0.0.1:${PUBLIC_OPENAPI_PORT}` |

Expose these services through the HTTPS origins configured in `.env`.

## Check Startup

```bash
docker compose -f docker-compose.yml ps
docker compose -f docker-compose.yml logs --tail=200 api source-worker publication-worker maintenance-worker
```

All long-running services should report healthy. If startup fails, check the first error from `migrate`, `meilisearch-init`, or the affected service. Common causes are unreachable infrastructure, incorrect credentials, invalid public origins, or an unsupported database from an older release.

After startup:

1. Open Admin UI and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Review Admin Settings.
3. Create a knowledge base and upload a small Markdown file.
4. Confirm the file becomes visible and can be read and searched.
5. Create an OpenAPI key and check Developer OpenAPI.

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

Use `docker compose logs -f` for container output. Product log files are stored in `./logs`; limits are documented in [Environment Configuration](./environment.md#runtime).

`pnpm compose:clean` removes containers, Docker-managed volumes, orphans, and local image copies for this stack. Directory data under `data`, `runtime-secrets`, and `logs` remains on disk. Delete those directories only when you intend to remove the deployment data.

## Update an Existing Deployment

Read the release notes before every update. The current storage release cannot reuse a database created by releases from before the breaking storage change. For that upgrade, keep a verified backup of the old deployment, start with empty PostgreSQL, Redis, Meilisearch, and S3 locations, and import the Markdown files again. Keep the previous deployment until file counts, paths, previews, search, relationships, and API access have been checked.

For a later release that supports the current database format:

1. Create a backup.
2. Update both image tags in `.env` and pull the images.
3. Complete any preparation described in the release notes.
4. Run the database command.
5. Start the updated services.

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

The database command can be run again after a successful completion. It does not process uploaded files or rebuild search indexes. When an update requires index maintenance, the knowledge-base page shows the maintenance action. Existing readable files remain available while maintenance runs.

## Processing Failures

The source-file list shows the current state, current step, failure information, and available actions.

- Use **Retry processing** when file processing failed.
- Use **Retry publication** when processing completed but the update did not become visible.
- Correct configuration or service errors before retrying a repeatable failure.

Generated content is available after the file reaches `state=visible`. Previously visible content remains readable if a newer update fails.

## Backup

Run backup from the directory containing `.env` and `docker-compose.yml`. Stop services that can change Focowiki data and keep PostgreSQL running.

```bash
docker compose -f docker-compose.yml stop api source-worker publication-worker maintenance-worker
pnpm compose:backup
```

The command refuses to continue while one of those services is running. It creates a checksum-protected archive containing the PostgreSQL backup, required S3 files, deployment settings, `.env`, the Compose file, and the private files needed by the deployment. Store the archive and its `.sha256` file outside the server.

Redis and Meilisearch data can be recreated. To include a compatible Meilisearch snapshot, pass both `--meilisearch-snapshot` and `--meilisearch-snapshot-sha256`.

If the deployment uses an explicit Compose project name, pass the same `--project-name <name>` option to both backup and restore commands.

## Restore From Backup

Restore into an empty target and keep a separate backup of any existing target data.

1. Stop the stack.

   ```bash
   docker compose -f docker-compose.yml down
   ```

2. Configure `.env` for an empty PostgreSQL database and an empty S3 prefix. Start PostgreSQL only.

   ```bash
   docker compose -f docker-compose.yml up -d postgres
   ```

3. Run restore with the archive and checksum files.

   ```bash
   pnpm compose:restore -- \
     --archive backups/focowiki-<backup-id>.tar.gz \
     --checksum backups/focowiki-<backup-id>.tar.gz.sha256
   ```

   Restore validates the archive and refuses a non-empty database, S3 prefix, or `runtime-secrets` target.

4. Use the same API and Admin image versions recorded for the backup.

5. Run the database command and start the stack.

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

6. If no compatible Meilisearch snapshot was restored, run **Maintain index** for each knowledge base.

Before accepting new writes, verify knowledge-base counts, file paths, previews, search, relationship navigation, Admin UI login, Developer OpenAPI health, and worker health.

## Capacity Notes

Adjust Worker, Publication, Maintenance, Search, and Graph settings from Admin UI after measuring the deployment. Avoid scripts that read every source file or every relationship into memory at once. See [Admin Settings](./admin-settings.md).
