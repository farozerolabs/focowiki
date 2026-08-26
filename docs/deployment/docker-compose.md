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
| OpenSearch or Meilisearch | One search index for each knowledge base. OpenSearch 3.8.0 is the bundled default. |
| S3-compatible storage | Uploaded Markdown and generated knowledge-base files. |
| Reverse proxy | HTTPS access to Admin UI, Admin API, and Developer OpenAPI. |

The template starts PostgreSQL, Redis, and the selected private search service. Configure an external S3-compatible service in `.env`. An external OpenSearch or Meilisearch service can replace the bundled search container. One `worker` service handles document indexing, semantic enrichment, deletion, repair, and maintenance.

## Prepare Files

```bash
cp .env.example .env
cp docker-compose.yml.example docker-compose.yml
mkdir -p data/postgres data/redis data/opensearch data/meilisearch data/meilisearch-snapshots data/meilisearch-dumps opensearch-security runtime-secrets logs backups
```

Fill `.env` before starting. See [Environment Configuration](./environment.md) for every production variable. Settings changed after startup are documented in [Admin Settings](./admin-settings.md).

Keep the real `.env` and copied `docker-compose.yml` out of git.

## Select a Search Provider

The copied environment template starts bundled OpenSearch 3.8.0 by default:

```dotenv
SEARCH_PROVIDER=opensearch
COMPOSE_PROFILES=opensearch
OPENSEARCH_URL=https://opensearch:9200
OPENSEARCH_AUTH_MODE=basic
```

Set one strong administrator password in `.env`:

```dotenv
OPENSEARCH_ADMIN_PASSWORD=<generate-an-opensearch-admin-password>
```

No TLS files need to be prepared. Before bundled OpenSearch starts, `search-init` makes `./data/opensearch` writable by the bundled container, creates a deployment-unique private CA and certificates, a complete OpenSearch Security configuration, and exactly two internal identities: the configured administrator and a generated runtime identity limited to `SEARCH_INDEX_PREFIX`. It stores the private security state in `./opensearch-security` and the runtime password and trusted CA in `./runtime-secrets`. A complete valid set is reused without changes on every restart. Missing, partial, corrupt, unsafe, near-expiry, or configuration-mismatched state stops startup instead of replacing the deployment identity. The OpenSearch demo security installer remains disabled for the entire startup. No manual `chown` is required for the template-managed data directory.

API and worker containers receive only the generated runtime identity and trusted CA; they do not receive the administrator password or private keys. The same `search-init` service prepares Meilisearch runtime access when the Meilisearch profile is selected.

To use bundled Meilisearch instead, first uncomment the complete `meilisearch` service block in the Compose template, then set:

```dotenv
SEARCH_PROVIDER=meilisearch
COMPOSE_PROFILES=meilisearch
MEILI_HOST=http://meilisearch:7700
```

To use an external service, leave `COMPOSE_PROFILES` empty and set the selected provider's external endpoint and authentication fields. OpenSearch supports basic authentication with optional private CA trust and AWS SigV4 with service `es` or `aoss`. No bundled search container or init service starts in external mode.

## Services Started by the Template

| Compose service | Description |
| --- | --- |
| `admin` | Admin UI. |
| `api` | Admin API and Developer OpenAPI. |
| `worker` | Processes document jobs and runs lower-priority deletion, repair, and maintenance work. |
| `migrate` | Checks and updates the database before application services start. |
| `postgres` | PostgreSQL database. |
| `redis` | Redis service. |
| `search-init` | Prepares the selected bundled search service; for OpenSearch it prepares the data directory and generates or validates TLS, internal identities, and prefix-scoped authorization before OpenSearch starts. |
| `opensearch` | Bundled OpenSearch 3.8.0, enabled by `COMPOSE_PROFILES=opensearch`. |
| `meilisearch` | Bundled Meilisearch alternative, enabled by `COMPOSE_PROFILES=meilisearch`. |

The production template publishes Admin UI, Admin API, and Developer OpenAPI only on `127.0.0.1`. PostgreSQL, Redis, and both bundled search services remain private to the Compose network. Only the selected search profile starts.

## Pull Images

```bash
docker compose -f docker-compose.yml pull
```

The image variables default to `latest`. Pin both images to the same release tag in production. The `worker` service uses the API image.

```text
FOCOWIKI_API_IMAGE=ghcr.io/farozerolabs/focowiki-api:<release-tag>
FOCOWIKI_ADMIN_IMAGE=ghcr.io/farozerolabs/focowiki-admin:<release-tag>
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
docker compose -f docker-compose.yml logs --tail=200 api worker admin
```

All long-running services should report healthy. If startup fails, check the first error from `migrate`, the selected provider init service, or the affected service. Common causes are unreachable infrastructure, incorrect credentials, invalid TLS trust, invalid public origins, or an unsupported database from an older release.

After startup:

1. Open Admin UI and sign in with `ADMIN_USERNAME` and `ADMIN_PASSWORD`.
2. Review Admin Settings.
3. In **Model configuration**, create and test a generation model and an embedding model, then activate both. Upload completion requires both configurations.
4. Create a knowledge base and upload a small Markdown file.
5. Confirm that the file progresses to `available`, then read it and find it through search.
6. Later uploads and body replacements follow the same automatic processing path. Run **Maintain index** after changing the model, embedding dimension, or search provider for existing content, or when an explicit repair or rebuild is required.
7. Create an OpenAPI key and check Developer OpenAPI.

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

`pnpm compose:clean` removes containers, Docker-managed volumes, orphans, and local image copies for this stack. Directory data under `data`, `opensearch-security`, `runtime-secrets`, and `logs` remains on disk. Delete those directories only when you intend to remove the deployment data.

## Update an Existing Deployment

For an in-place update, keep API, worker, and Admin services stopped while the database command runs. The update preserves content that was already available and its active generated paths, source revisions, relationships, and search ownership. Unfinished final-publication coordination is reset to the current worker contract; completed model, GraphRAG, embedding, source-storage, and search-preparation results are retained. The migration does not call external providers, rewrite S3 objects, or rebuild a knowledge base.

To update an existing deployment:

1. Create a backup.
2. Stop `api`, `worker`, and `admin`. Do not run old and new workers against the same database.
3. Update all image tags in `.env` and pull the images.
4. Complete any preparation described in the release notes.
5. Run the database command while the application services remain stopped.
6. Start the updated services and verify existing reads before accepting writes.

```bash
docker compose -f docker-compose.yml pull
docker compose -f docker-compose.yml stop api worker admin
docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

The database command can be run again after a successful completion. It does not process uploaded files or rebuild search indexes. If rollback is required, stop the updated services and restore the coordinated backup with the image versions recorded for that backup. After the new deployment is running, changing a model, embedding dimension, output format, or search provider for existing content may require **Maintain index**. Existing readable files remain available while maintenance runs.

## Processing Failures

The source-file list shows the current state, current step, failure information, and available actions.

- Use **Retry processing** when file processing failed.
- Correct configuration or service errors before retrying a repeatable failure.

Generated content is available after the file reaches `state=available`. Previously available content remains readable if a replacement fails.

A file is reported available only after its required processing finishes and its generated content is readable and searchable. Correct the model, embedding, search, or resource-limit problem shown in Admin before retrying. Use **Maintain index** after a relevant configuration change, or for an explicit repair, recovery, or full rebuild.

## Backup

Run backup from the directory containing `.env` and `docker-compose.yml`. Stop services that can change Focowiki data and keep PostgreSQL running.

An archive can be restored only with the same storage schema generation and matching image versions. A backup made by an earlier release is rollback material for that earlier release and cannot seed this breaking target release.

```bash
docker compose -f docker-compose.yml stop api worker admin
pnpm compose:backup
```

The command refuses to continue while one of those services is running. It creates a checksum-protected archive containing the PostgreSQL backup, required S3 files, deployment settings, `.env`, the Compose file, and `runtime-secrets`. Store the archive and its `.sha256` file outside the server.

For bundled OpenSearch, also copy the complete stopped `opensearch-security` directory into encrypted deployment backup storage. Keep it together with the matching `.env`, `runtime-secrets`, and OpenSearch data backup. The generated private keys are not included in the standard backup archive.

Redis and search-provider indexes can be recreated. To include a compatible Meilisearch snapshot, pass both `--meilisearch-snapshot` and `--meilisearch-snapshot-sha256`. The bundled backup command does not package OpenSearch snapshots; use your OpenSearch provider's snapshot procedure if you need one, or rebuild each knowledge-base index after restore.

If the deployment uses an explicit Compose project name, pass the same `--project-name <name>` option to both backup and restore commands.

## Restore From Backup

Restore a backup created by this storage baseline into an empty target and keep a separate backup of any existing target data. Earlier-release backups must be restored only with their matching earlier images as a rollback deployment.

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

4. If bundled OpenSearch data is being restored, restore its matching complete `opensearch-security` directory before starting OpenSearch. Do not combine its files with assets from another deployment.

5. Use the same API and Admin image versions recorded for the backup.

6. Run the database command and start the stack.

   ```bash
   docker compose -f docker-compose.yml run --rm migrate
   docker compose -f docker-compose.yml up -d
   ```

7. If no compatible selected-provider snapshot was restored, run **Maintain index** for each knowledge base.

Before accepting new writes, verify knowledge-base counts, file paths, previews, search, relationship navigation, Admin UI login, Developer OpenAPI health, and worker health.

## Switch Search Providers

Switching providers does not copy or automatically rebuild indexes.

1. Stop the stack and preserve the current provider data until validation finishes.
2. Change `SEARCH_PROVIDER`, the matching endpoint and authentication fields, and `COMPOSE_PROFILES` (`opensearch`, `meilisearch`, or empty for an external service).
3. Start the stack and verify service health.
4. Existing knowledge bases continue to support tree, content, generated-file, graph, settings, and non-search Developer OpenAPI reads. Search reports a temporary unavailable response until adoption finishes.
5. Use **Maintain index** once for each existing knowledge base. A new validated index is built in the selected provider before it becomes active. Compatible stored embedding artifacts are reused, so a provider-only switch does not repeat the same model calls.
6. Verify search and normal document availability, then retire the old provider data according to your backup policy.

Switching back follows the same steps. An old physical index is never reactivated automatically. The Developer OpenAPI request and response schemas do not change when the provider changes.

If search remains unavailable, confirm that the runtime reports the intended provider, the endpoint is reachable from every container, TLS and credentials are valid, and **Maintain index** completed for that knowledge base. Do not repeatedly restart workers while a maintenance operation is running.

## Rotate Bundled OpenSearch TLS

Ordinary restarts never rotate certificates. To rotate them, stop the complete stack and back up `opensearch-security`, `runtime-secrets`, and OpenSearch data. Move the existing `opensearch-security` directory, `runtime-secrets/opensearch-password`, and `runtime-secrets/opensearch-ca.pem` together to protected backup storage, then create a new empty `opensearch-security` directory. Keep every unrelated file in `runtime-secrets` unchanged. Start the stack once and verify OpenSearch health, Admin search, and Developer OpenAPI search before retiring the previous matching security backup.

If startup reports `OpenSearch security assets are incomplete or invalid`, keep the failed state unchanged for diagnosis. The initializer does not repair an incomplete security-directory and runtime-password pair. Restore the matching security directory, password file, and CA file from one backup, or follow the stopped-stack rotation procedure. Do not remove only one generated file or copy certificates between deployments.

## Capacity Notes

The production template caps `worker` at 2 CPUs, 2 GiB memory, and 128 processes or threads by default. Adjust those startup ceilings in `.env`. After measuring the deployment, tune Worker, Generated Knowledge Base, Maintenance, Search, Graph, and Semantic Search under **Settings**, and manage embedding models under **Model configuration**. Avoid scripts that read every source file or every relationship into memory at once. See [Environment Configuration](./environment.md#worker-startup-limits) and [Admin Settings](./admin-settings.md).
