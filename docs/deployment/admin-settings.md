---
title: Admin Settings
---

# Admin Settings

Open **Settings** from a knowledge-base page in Admin UI. Saved values remain available after a restart. Changes affect new requests and newly started jobs; a job that is already running may finish with the values it started with.

The values below match the fields currently shown in Admin UI. Start with the defaults and increase concurrency only after checking CPU, memory, PostgreSQL, Meilisearch, and S3 latency.

## API Rate Limits

| Setting | Purpose | Default |
| --- | --- | --- |
| Admin login / Maximum requests | Login attempts allowed during one window. | `8` |
| Admin login / Window seconds | Length of the login window. | `900` |
| Admin API / Maximum requests | Admin UI API requests allowed during one window. | `600` |
| Admin API / Window seconds | Length of the Admin API window. | `60` |
| Developer OpenAPI / Maximum requests | Developer OpenAPI requests allowed during one window. | `1200` |
| Developer OpenAPI / Window seconds | Length of the Developer OpenAPI window. | `60` |

These limits apply inside Focowiki. Configure compatible limits at the reverse proxy or edge service.

## Worker

| Setting | Purpose | Default or starting value |
| --- | --- | --- |
| Source file concurrency | Files processed at the same time. | `2`; increase gradually after measuring. Maximum `32`. |
| Source file read concurrency | Uploaded Markdown files read from storage at the same time. | `2`; must not exceed source file concurrency. |
| Files claimed per poll | Files selected during one queue check. | `10`; must be at least the source file concurrency. |
| Poll interval milliseconds | Delay between queue checks. | `1000` |
| Processing lock seconds | Time before an abandoned file can be picked up again. | `900` |
| Heartbeat interval milliseconds | How often active work reports that it is still running. | `15000` |
| Processing maximum attempts | Attempts allowed before a file remains failed. | `3` |
| Processing retry delay milliseconds | Delay before retrying a temporary failure. | `30000` |
| Completed record retention days | Days to keep completed processing records. | `7` |
| Cleanup concurrency | File-deletion cleanup jobs processed at the same time. | `1` |
| Cleanup database batch size | Database rows handled in one cleanup batch. | `1000` |
| Cleanup storage batch size | Stored files handled in one cleanup request. | `1000`; maximum `1000`. |
| Cleanup maximum attempts | Attempts allowed for a cleanup job. | `3` |
| Cleanup retry delay milliseconds | Delay before retrying cleanup after a temporary failure. | `60000` |

Lower source file and storage-read concurrency first when CPU, database latency, or storage latency rises during large imports.

## Publication

| Setting | Purpose | Default or starting value |
| --- | --- | --- |
| Mode | `batch` groups updates, `per_file` publishes each completed file quickly, and `manual` waits for manual publication. | `batch` |
| Interval seconds | Maximum wait between batch publication checks. | `300` |
| Publication concurrency | Publication jobs processed at the same time. | `1` |
| Jobs claimed per poll | Publication jobs selected during one queue check. | `1`; must be at least publication concurrency. |
| Generated-file write concurrency | Generated files written to storage at the same time. | `8`; maximum `32`. |
| Directory entries per page | Direct entries listed on one generated directory page. This does not limit files in a directory. | `200` |
| Directory page bytes | Maximum UTF-8 size of one generated directory page. | `65536` |

Use `batch` for large imports, `per_file` when fast visibility matters, and `manual` when publication must be explicitly controlled.

## Graph

| Setting | Purpose | Default |
| --- | --- | --- |
| Candidate file limit | Files considered when discovering relationships for one file. | `200` |
| Accepted relationship limit | Relationships kept for one file. | `50` |
| Default search depth | Relationship depth used when an API request omits it. | `1` |
| Maximum search depth | Highest relationship depth accepted by the API. | `2` |
| Default search fanout | Related files explored at each step when omitted by the request. | `10` |
| Maximum search fanout | Highest fanout accepted by the API. | `25` |
| Model relationship review | Allows the active model to review relationship suggestions. | Enabled |
| Generic phrase threshold | Minimum normalized phrase length used to ignore overly broad shared phrases. | `4` |

Default depth and fanout must not exceed their maximum values. Model review is optional; relationship discovery continues when no model is active.

## Maintenance

| Setting | Purpose | Default or starting value |
| --- | --- | --- |
| Knowledge-base maintenance mode | `manual` runs only when requested; `automatic` also checks on a schedule. | `manual` |
| Automatic maintenance interval seconds | Time between scheduled checks in automatic mode. | `21600` |
| Knowledge-base maintenance concurrency | Knowledge bases maintained at the same time. | `1`; maximum `16`. |
| Storage consistency checks | Periodically finds storage entries that can be safely cleaned up. | Enabled |
| Storage scan batch size | Stored entries checked in one batch. | `500`; maximum `1000`. |
| Storage deletion batch size | Confirmed unused entries deleted in one batch. | `100`; maximum `1000`. |
| Storage cleanup grace seconds | Minimum time an unused entry must remain before deletion. | `86400` |
| Storage cleanup maximum attempts | Attempts allowed for a cleanup action. | `5` |
| Storage cleanup retry delay milliseconds | Delay after a temporary cleanup failure. | `30000` |
| Generated-content repair concurrency | Generated-content repair jobs processed at the same time. | `4`; maximum `16`. |
| Generated-content repair database batch size | Records handled in one repair batch. | `2000`; range `100` to `10000`. |
| Generated-content repair storage-write concurrency | Repaired files written to storage at the same time. | `4`; maximum `32`. |
| Search rebuild concurrency | Search rebuild jobs processed at the same time. | `4`; maximum `16`. |
| Search rebuild source-read concurrency | Source Markdown files read at the same time during rebuild. | `2`; maximum `32`. |
| Search rebuild memory limit bytes | Maximum source Markdown bytes held during active rebuild reads. | `67108864`; range 1 MiB to 512 MiB. |

Use **Maintain index** on a knowledge-base page to repair navigation, search, relationships, and generated content for that knowledge base. Existing readable files remain available while maintenance runs. The status panel shows progress, retries, recent activity, and any failure that needs attention.

## Search

| Setting | Purpose | Default |
| --- | --- | --- |
| Search request timeout milliseconds | Maximum total time for one search request. | `3000` |
| Search service timeout milliseconds | Maximum time for one search-service request. It must be lower than the total timeout. | `1000` |
| Result refill factor | Extra results requested when unavailable files are removed before returning a page. | `3` |
| Index update document count | Maximum documents sent in one search update. | `10000` |
| Index update compressed bytes | Maximum compressed size of one search update. | `8388608` |
| In-flight search tasks | Search updates waiting for completion at the same time. | `8` |
| Search task poll interval milliseconds | Delay between task-status checks. | `500` |
| Search task timeout milliseconds | Maximum time allowed for one search update before retry handling. | `600000` |
| Search task maximum attempts | Attempts allowed for a search update or cleanup action. | `5` |
| Search retry delay milliseconds | Delay before retrying a temporary search failure. | `2000` |
| Search cleanup batch size | Old search records removed in one cleanup batch. | `1000` |
| Incomplete index retention hours | Time to retain an unsuccessful or replaced index before cleanup. | `24` |
| Search result excerpt length | Maximum excerpt characters requested for one search result. | `1200` |

Keep the search-service timeout below the total request timeout. Reduce update size or in-flight tasks when Meilisearch memory or disk latency rises.

## Models

Model assistance is optional. File processing, navigation, search, and relationships continue without an active model. Only one model can be active at a time.

| Setting | Purpose | Recommended value |
| --- | --- | --- |
| Display name | Name shown in Admin UI. | Include provider and purpose. |
| API mode | Provider protocol. | `responses` or `chat_completions`, matching the provider. |
| Base URL | OpenAI-compatible API base URL. | Include `/v1` when required by the provider. |
| API key | Server-side provider credential. | Use a dedicated key and rotate it regularly. |
| Model name | Provider model identifier. | Match provider documentation exactly. |
| Context window tokens | Model context capacity. | Use the provider's published limit. |
| Request maximum timeout milliseconds | Maximum total time for one model request. | `600000` or higher for long files. |
| Request idle timeout milliseconds | Maximum time with no response activity. | `120000` to `300000`. |
| Suggestion concurrency | Model requests made at the same time. | Start with `1` or `2`. |
| Temporary-error retry delay milliseconds | Delay before retrying a temporary provider failure. | `60000` |
| Request minimum interval milliseconds | Minimum delay between model requests. | `0` for stable providers; increase for strict rate limits. |

The complete API key is not displayed after creation. Pausing a model prevents new jobs from selecting it. A model still used by running work cannot be deleted until that work finishes.

## Applying Changes

Admin Settings are stored by Focowiki and do not belong in `.env`. Ports, domains, infrastructure credentials, database connection limits, storage credentials, and log paths remain startup configuration. Restart the affected service after changing startup configuration.
