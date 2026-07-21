---
title: Admin Settings
---

# Admin Settings

Open **Settings** from the Admin UI knowledge-base page. Saved values apply to later requests and background work and remain available after service restarts.

## API Rate Limits

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Admin login / Max requests | Login attempts allowed in one window. | `8`; use 5 to 10 for public deployments. |
| Admin login / Window seconds | Length of the login counting window. | `900`. |
| Admin API / Max requests | Admin UI API requests allowed in one window. | `600`. |
| Admin API / Window seconds | Length of the Admin API counting window. | `60`. |
| Developer OpenAPI / Max requests | Developer OpenAPI requests allowed in one window. | `1200`, then tune by server capacity. |
| Developer OpenAPI / Window seconds | Length of the Developer OpenAPI counting window. | `60`. |

Upload registration follows the authenticated upload-session contract and has no separate product rate or logical file-count quota. Reverse proxies and storage providers can still enforce infrastructure limits outside Focowiki.

## Worker

Worker settings control source processing, durable dispatch, retries, retention, and asynchronous deletion. Hard and resume values form hysteresis: dispatch pauses at a hard value and resumes only after pressure falls below the lower resume value. Upload registration continues while dispatch is paused.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Source file concurrency | Source files processed concurrently. | 8 to 16 on an 8C/32G server after measuring database and storage latency. |
| Source object read concurrency | Source Markdown objects read concurrently by one source-worker process. | 8 to 16 and no higher than source file concurrency. |
| Graph query concurrency | Graph-candidate database queries running concurrently in one source-worker process. | 8 to 16 and no higher than source file concurrency. |
| Database mutation concurrency | Source-processing database mutation groups running concurrently in one source-worker process. | 4 to 8 and no higher than source file concurrency. |
| Claim batch size | Source jobs claimed per polling cycle. | At least source file concurrency; use 32 on an 8C/32G server. |
| Generation batch size | Source records committed in one bounded generation-input batch. | 50 to 200. |
| Poll interval ms | Delay between queue polls. | 1000 to 3000 ms. |
| Lock TTL seconds | Validity period for a claimed job lock. | Longer than normal processing time; commonly 900 seconds. |
| Heartbeat interval ms | Interval for refreshing a running claim. | 10000 to 30000 ms. |
| Job max attempts | Attempts allowed before a job becomes dead letter. | `3`. |
| Job retry delay ms | Delay before retrying a transient failure. | 30000 to 120000 ms. |
| Source queue hard depth | Queued source-job count that pauses new dispatch. | 5000 to 20000. |
| Source queue resume depth | Queued source-job count that permits dispatch to resume. | 50% to 70% of the hard depth. |
| Source queue hard age seconds | Oldest queued source-job age that pauses dispatch. | 3600 to 7200 seconds. |
| Source queue resume age seconds | Oldest queued source-job age that permits dispatch to resume. | About half of the hard age. |
| Shutdown grace ms | Time allowed for an orderly Worker shutdown. | 30000 to 120000 ms. |
| Completed retention days | Retention for completed job records. | 7 to 30 days. |
| Failed retention days | Retention for failed job records. | 30 days or longer. |
| Dead-letter retention days | Retention for dead-letter job records. | 90 days. |
| Retention cleanup batch size | Job rows removed in one maintenance page. | 500 to 2000. |
| Cleanup concurrency | Asynchronous deletion jobs processed concurrently. | `1` for most deployments. |
| Cleanup database batch size | Database rows deleted in one cleanup page. | 500 to 2000. |
| Cleanup object batch size | S3 objects deleted in one request page. | `1000`; the maximum is 1000. |
| Cleanup max attempts | Attempts allowed for asynchronous deletion. | `3`. |
| Cleanup retry delay ms | Delay before retrying asynchronous deletion. | 60000 to 300000 ms. |
| Cleanup failed retention days | Retention for failed cleanup evidence. | 30 days. |
| Versioned cleanup | Enables deletion of versioned S3 objects. | Leave disabled unless the storage lifecycle requires it. |

## Publication

Publication creates immutable generated objects, updates affected projection shards, validates the changed closure, and atomically switches the active generation. Later uploads can continue into one successor generation while the current generation is frozen.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Mode | `batch`, `per_file`, or `manual` publication scheduling. | `batch` for large imports; `per_file` for fast visibility. |
| Batch size | Completed source changes that make a batch immediately eligible. | 100 to 500. |
| Interval seconds | Maximum batching wait from the generation creation time. | 120 to 600 seconds. |
| Role concurrency | Publication jobs processed concurrently by the role. | `1` until database and S3 capacity are measured. |
| Generation assembly concurrency | Bounded generation-input pages assembled concurrently. | 1 to 2 and no higher than role concurrency. |
| Projection partition concurrency | Independent physical projection partitions processed concurrently. | 8 to 16 and no higher than impact concurrency. |
| Generated object write concurrency | Immutable generated objects uploaded and verified concurrently. | 8 to 16 and no higher than projection partition concurrency. |
| Directory materialization concurrency | Independent directory navigation outputs generated concurrently. | 4 to 8 and no higher than projection partition concurrency. |
| Claim batch size | Publication jobs claimed per polling cycle. | 1 to 4 and no lower than role concurrency. |
| Impact batch size | Projection impacts processed in one bounded page. | 100 to 500. |
| Dirty file hard count | Dirty source-file count that pauses source dispatch. | 2000 to 10000. |
| Dirty file resume count | Dirty count that permits source dispatch to resume. | Lower than the hard count. |
| Dirty age hard seconds | Oldest dirty-file age that pauses source dispatch. | 900 to 3600 seconds. |
| Dirty age resume seconds | Dirty age that permits source dispatch to resume. | Lower than the hard age. |
| Pending impact hard count | Pending projection-impact count that pauses source dispatch. | 20000 to 100000. |
| Pending impact resume count | Pending impact count that permits source dispatch to resume. | Lower than the hard count. |
| Generation retention days | Inactive generation references retained before garbage collection. | 7 to 30 days. |
| Index shard size | Search records assigned to one stable machine shard. | 1000 to 5000. |
| Link index shard size | Link records assigned to one stable machine shard. | 1000 to 5000. |
| Manifest shard size | Manifest records assigned to one stable machine shard. | 1000 to 5000. |
| Graph edge shard size | Graph edges assigned to one stable machine shard. | 5000 to 20000. |
| Graph candidate limit | Relationship candidates evaluated in one bounded projection operation. | 100 to 300. |
| Graph maintenance batch size | Graph records refreshed in one maintenance page. | 200 to 1000. |
| Root summary limit | Entries included in bounded root summaries. | 200 to 1000. |
| Directory index entries per page | Direct entries in one generated directory navigation page. | 100 to 500. |
| Directory index bytes per page | UTF-8 byte boundary for one directory navigation page. | 65536 to 262144. |
| Log max entries | Recent generation changes kept in `log.md`. | 50 to 200. |
| Log max bytes | UTF-8 byte boundary for `log.md`. | 65536 or higher. |

## Graph

Graph settings control body-grounded file relationship discovery, graph search, traversal bounds, generated graph shards, and short-lived query caching.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Graph candidate limit | Candidate files considered during relationship generation. | 100 to 300. |
| Accepted edge limit | Accepted relationships retained per file. | 20 to 80. |
| Default search depth | Graph expansion depth used when OpenAPI omits `depth`. | `1`. |
| Max search depth | Maximum graph expansion depth accepted by OpenAPI. | `2`. |
| Default search fanout | Related files followed per graph hop by default. | `10`. |
| Max search fanout | Maximum related files followed per graph hop. | `25`. |
| Model relationship review | Allows the active model to review candidate relationships. | Enable when the model service is stable. |
| Graph publication shard size | Graph nodes and edges assigned to one generated shard. | 5000 to 20000. |
| Graph cache TTL seconds | Redis cache lifetime for graph search and expansion. | 5 to 60 seconds. |
| Generic phrase threshold | Minimum normalized phrase length used by generic phrase filtering. | `4`. |

## Maintenance

Maintenance settings control bounded reconciliation of Focowiki-managed generated objects. Reconciliation runs only in the maintenance worker. It does not scan source uploads, upload-session objects, unrelated prefixes, or user-managed storage paths.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Storage reconciliation | Enables bounded generated-object reconciliation. | Keep enabled for normal deployments. |
| Scan interval seconds | Time between complete reconciliation cycles. | `21600` seconds. |
| Scan batch size | Generated-object metadata records listed in one bounded page. | `500`; maximum `1000`. |
| Deletion batch size | Confirmed orphan objects deleted in one bounded batch. | `100`; maximum `1000`. |
| Quarantine grace seconds | Minimum time an unregistered candidate remains quarantined before deletion. | `86400` seconds or longer. |
| Confirmation passes | Completed discovery passes required before deletion eligibility. | `2` or more. |
| Maximum attempts | Deletion attempts retained for one candidate. | `5`. |
| Retry delay ms | Delay after a transient reconciliation failure. | `30000` to `300000` ms. |
| Migration backfill concurrency | Bounded source and projection pages processed concurrently during compatible optimization migration. | 1 to 2. |
| Projection compaction concurrency | Independent projection partitions compacted concurrently. | 1 to 2. |

The status section reports aggregate scan, quarantine, deletion, retry, and registered-but-missing counts. It does not return object keys, checksums, storage credentials, SQL, Redis keys, or internal worker payloads.

## Models

Model assistance is optional. Source processing continues with deterministic metadata, navigation, search, and graph inputs when no model is active. One model can be active at a time.

| Field | Meaning | Recommended value |
| --- | --- | --- |
| Display name | Name shown in Admin UI. | Include provider and purpose. |
| API mode | `responses` or `chat_completions` provider protocol. | Match the provider endpoint. |
| Base URL | OpenAI-compatible API base URL. | Include `/v1` when required. |
| API key | Credential sent only by the backend. | Use a scoped, regularly rotated key. |
| Model name | Provider model identifier. | Match provider documentation exactly. |
| Context window tokens | Model context-window capacity. | Use the provider's real limit. |
| Request max timeout ms | Maximum total model request time. | 600000 ms or higher for long documents. |
| Request idle timeout ms | Maximum time without model response activity. | 120000 to 300000 ms. |
| Suggestion concurrency | Concurrent model suggestion requests. | Start with 1 to 2. |
| Transient retry delay ms | Delay before retrying a transient provider failure. | 60000 ms. |
| Request min interval ms | Minimum interval between model requests. | 0 for stable providers; 1000 to 5000 ms for strict limits. |

Saved API keys remain hidden after creation. Pausing a model prevents new jobs from selecting it. Deletion is blocked while running work still references the model.

## Apply and Observe

Saved runtime settings are durable. Running jobs keep their captured settings where consistency requires a stable snapshot. Later claims and requests use the new values. Startup-only ports, origins, credentials, database pools, storage credentials, and log paths remain in `.env` and require service restart when changed.
