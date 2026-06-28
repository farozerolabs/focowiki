---
title: Admin Settings
---

# Admin Settings

Open the Admin UI, click the settings icon on the knowledge-base home page, and update runtime configuration without editing `.env` or restarting services. Saved values apply to later requests and later background jobs.

On first deployment, Focowiki initializes these settings from default values. After an administrator saves settings, later runtime behavior uses the saved values from the Admin UI.

Model API keys are protected after saving. The page shows a key identifier and never shows the full key again. Saved keys continue to work after service restarts when deployment data is kept intact. If protection data is deleted during maintenance, re-enter the affected model API keys from this page.

## Rate Limits

Rate limits protect Admin login, Admin API, upload requests, and Developer OpenAPI. Each group has the same two fields.

| Group | Field | Meaning | Recommended value |
| --- | --- | --- | --- |
| Admin login | Max requests | Maximum login attempts allowed in one counting window. | `8`, or 5 to 10 for public deployments. |
| Admin login | Window seconds | Counting window for login attempts. | `900`. |
| Admin API | Max requests | Maximum Admin UI API requests allowed in one counting window. | `600`. |
| Admin API | Window seconds | Counting window for Admin UI API requests. | `60`. |
| Upload | Max requests | Maximum Markdown upload requests allowed in one counting window. | `20`. |
| Upload | Window seconds | Counting window for Markdown upload requests. | `3600`. |
| Developer OpenAPI | Max requests | Maximum Developer OpenAPI requests allowed in one counting window. | `1200`, then tune by server capacity and traffic. |
| Developer OpenAPI | Window seconds | Counting window for Developer OpenAPI requests. | `60`. |

Tune these values together with reverse proxy, Cloudflare, or other edge-layer limits.

## Background Processing

Background processing settings control source-file concurrency, job claiming, retries, queue protection, and job-record retention. Current running jobs continue their current step. New jobs use the latest saved values.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Source file concurrency | Number of source files processed at the same time. | 2 to 4 on an 8C/32G server. |
| Claim batch size | Number of jobs claimed in one poll. | 10 to 50 and close to actual concurrency. |
| Poll interval ms | How often the background service checks pending jobs. | 1000 to 3000 ms. |
| Lock TTL seconds | How long a job lock stays valid. | Longer than normal file processing time, commonly 900 seconds. |
| Heartbeat interval ms | How often a running job refreshes its heartbeat. | 10000 to 30000 ms. |
| Job max attempts | Maximum attempts before a job moves to dead letter. | 3. |
| Job retry delay ms | Delay before retrying a failed job. | 30000 to 120000 ms. |
| Global queue limit | Global queued job limit. | 5000 to 20000 on larger servers. |
| Knowledge base queue limit | Queued job limit for one knowledge base. | Lower than the global limit. |
| Queue max age seconds | Oldest accepted queue age before uploads slow down. | 3600 to 7200 seconds. |
| Retry after seconds | Suggested wait time when the queue is busy. | 30 to 300 seconds. |
| Shutdown grace ms | Time allowed for background service shutdown. | 30000 to 120000 ms. |
| Completed retention days | Days to keep completed job records. | 7 to 30. |
| Failed retention days | Days to keep failed job records. | 30 or longer. |
| Dead-letter retention days | Days to keep dead-letter records. | 90. |
| Retention cleanup batch size | Rows removed in each cleanup pass. | 500 to 2000. |

Keep queue limits high enough for planned imports and low enough to preserve Admin UI and OpenAPI responsiveness. Increase concurrency gradually while observing CPU, memory, storage speed, processing speed, and model response time.

## Publication

Publication makes processed files visible in the current file tree and Developer OpenAPI reads. File processing can finish before publication makes generated files visible.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Mode | Publication strategy. `batch` groups completed files, `manual` waits for explicit publication work, and `per_file` publishes after each file. | `batch` for large knowledge bases, `per_file` for fast visibility, `manual` for controlled release. |
| Batch size | Files included in one publication job. | 100 to 500. |
| Interval seconds | Minimum interval between batch publications. | 120 to 600 seconds. |
| Index shard size | Entries per search index shard. | 1000 to 5000. |
| Link index shard size | Entries per link index shard. | 1000 to 5000. |
| Manifest shard size | Entries per manifest shard. | 1000 to 5000. |
| Graph edge shard size | Graph edges per shard. | 5000 to 20000. |
| Graph candidate limit | Candidate files considered for relationships. | 100 to 300. |
| Graph maintenance batch size | Files refreshed in each graph maintenance pass. | 200 to 1000. |
| Root summary limit | Items shown in the root summary and index. | 200 to 1000. |
| Log max entries | Recent update entries kept in `log.md`. | 50 to 200. |
| Log max bytes | Maximum generated `log.md` size. | 65536 or higher for active knowledge bases. |

The file-processing list shows both source-file processing state and generated-output visibility. Treat a file as fully readable when processing is completed and generated output is visible.

## Upload and Generation

Upload and generation settings control Markdown upload size, request size, and generation work batching.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Max upload bytes | Maximum total bytes accepted by one upload request. | `10485760` for 10 MB, or lower for small deployments. |
| Max upload files | Maximum Markdown files accepted by one upload request. | 50 on an 8C/32G server. |
| Generation batch size | Batch size used by generation, graph, indexing, and publication work. | 100 on an 8C/32G server. |
| File processing concurrency | Number of file processing operations inside one background job. | 1 for stable large imports. |
| Storage concurrency | Number of uploaded source files written to S3-compatible storage at the same time. | 4, or 6 when S3 is stable. |

Uploads accept Markdown files only. A source file can be uploaded successfully while processing and publication continue in the background.

## Models

Model assistance is optional. When no model is active, uploads continue with deterministic OKF generation and model suggestions are skipped.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Display name | Admin-facing model name. | Include provider and usage. |
| Base URL | OpenAI-compatible API base URL. | Include `/v1` when the provider requires it. |
| API key | Provider API key. | Use a scoped key and rotate it regularly. |
| Model name | Model identifier sent to the provider. | Match provider documentation exactly. |
| Context window tokens | Model context window size. | Set the real model context limit. |
| Request max timeout ms | Maximum request time. | 600000 ms or higher for long documents. |
| Request idle timeout ms | Idle timeout while waiting for model output. | 120000 to 300000 ms. |
| Suggestion concurrency | Parallel model suggestion requests. | Start with 1 to 2, then increase after observing stability. |
| Transient retry delay ms | Delay before retrying transient model failures. | 60000 ms. |
| Request min interval ms | Minimum delay between model requests. | 0 for stable providers, 1000 to 5000 ms for strict rate limits. |

Activating a model selects it for new source-file jobs. Pausing a model keeps the configuration and prevents new jobs from using it. Deleting a model is blocked while running work still uses that model.

## Operational Notes

- Saved settings continue to apply after services restart.
- Deleting deployment data also removes saved settings.
- Settings are Admin-only and are not exposed through Developer OpenAPI.
- Runtime changes apply to later requests and later background jobs. Some values affect long-running work after the next job or the next check.
