---
title: Admin Settings
---

# Admin Settings

Open **Settings** from a knowledge-base page in Admin UI. Saved values remain available after a restart. Changes affect new requests and newly started jobs; a job that is already running may finish with the values it started with.

The values below match the fields currently shown in Admin UI. Start with the defaults and increase concurrency only after checking CPU, memory, PostgreSQL, the selected search provider, and S3 latency.

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

Use **Maintain index** only to establish the first semantic contract for an existing knowledge base, adopt a changed model, prompt, schema, vector dimension, or search provider, or run an explicit repair, recovery, or full rebuild. Automatic maintenance does not adopt those changes. Once a knowledge base has a current semantic contract, ordinary uploads and body replacements run GraphRAG, semantic reconciliation, embedding generation, affected graph and generated-content updates, and final search publication as part of normal file processing. Rename, move, metadata update, and delete operations update only their affected scope and do not require **Maintain index**. Existing readable files remain available while maintenance runs. The status panel shows progress, retries, recent activity, and any failure that needs attention, and a running maintenance operation can be cancelled from the same panel.

The current semantic extraction contract ships only in the clean breaking storage baseline described in [Docker Compose Deployment](./docker-compose.md#update-an-existing-deployment). Knowledge bases and content from an earlier release are not migrated or available for index maintenance in this release; import the source Markdown again into the empty target deployment. **Maintain index** applies only to knowledge bases created inside the current baseline without a semantic contract and to later current-baseline model, contract, dimension, provider, repair, recovery, or full-rebuild operations.

## Search

The same settings remain visible for both providers; changing `SEARCH_PROVIDER` does not add, remove, or rename a field.

| Setting | Meilisearch behavior | OpenSearch behavior | Default |
| --- | --- | --- | --- |
| Search request timeout milliseconds | Bounds the complete application search request. | Bounds the complete application search request. | `3000` |
| Search service timeout milliseconds | Native search cutoff and client deadline. | Provider request/query deadline and application cutoff. | `1000` |
| Result refill factor | Overfetches candidates before hydration. | Overfetches collapsed candidates before hydration. | `3` |
| Index update document count | Maximum documents in one indexing task. | Maximum documents in one Bulk request. | `10000` |
| Index update compressed bytes | Maximum serialized indexing batch bytes. | Maximum serialized Bulk request bytes. | `8388608` |
| In-flight search tasks | Concurrent pending indexing tasks. | Concurrent Bulk or provider operations. | `8` |
| Search task poll interval milliseconds | Delay between task-status checks. | Delay between retry or final visibility checks. | `500` |
| Search task timeout milliseconds | Total indexing-task deadline. | Total Bulk, indexing, and visibility deadline. | `600000` |
| Search task maximum attempts | Maximum task and request retries. | Maximum transient request and item retries. | `5` |
| Search retry delay milliseconds | Delay before a task or request retry. | Delay before a transient retry, with a limited random adjustment. | `2000` |
| Search cleanup batch size | Durable old-index cleanup claim size. | Durable exact-index cleanup claim size. | `1000` |
| Incomplete index retention hours | Failed or replaced candidate retention. | Failed or replaced candidate retention. | `24` |
| Search result excerpt length | Native crop length. | Maximum highlighted fragment and normalized excerpt length. | `1200` |

Keep the search-service timeout below the total request timeout. Reduce update size or in-flight tasks when the selected provider's memory or disk latency rises.

## Semantic Search

Semantic settings are shared by OpenSearch and Meilisearch. They bound optional entity, relationship, community, and vector enrichment without changing the generated file tree or source Markdown.

| Setting | Purpose | Default |
| --- | --- | --- |
| Maximum chunk characters | Maximum characters in one extraction chunk. | `8000` |
| Maximum chunks | Maximum extraction chunks from one source revision. | `32` |
| Maximum evidence targets | Maximum source evidence targets retained for one semantic unit. | `64` |
| Maximum community partitions | Maximum community partitions handled for one operation. | `256` |
| Maximum community entities | Maximum entities assembled for one community partition. | `10000` |
| Maximum community relationships | Maximum internal relationships assembled for one community partition. | `20000` |
| Maximum community boundary relationships | Maximum boundary relationships assembled for one community partition. | `10000` |
| Maximum community summary characters | Maximum characters retained in one community summary. | `8000` |
| Community adapter timeout milliseconds | Maximum time for one community-analysis request. | `30000` |
| Semantic search lane cutoff milliseconds | Independent cutoff for optional semantic search lanes. Must not exceed the total search request timeout. | `2500` |
| Query embedding concurrency | Maximum concurrent query-embedding requests per process. | `4` |
| Query embedding cache entries | Maximum query-embedding cache entries per process. | `1000` |

Start with the defaults. Lower chunk, community, or query-embedding limits when source-worker CPU or memory, model latency, or search latency rises. A failed optional semantic lane reports a safe semantic status while completed exact and lexical lanes can still return results.

For a contracted knowledge base, the existing file-processing list reports GraphRAG processing, semantic reconciliation, embedding generation, affected graph and generated-content updates, and search publication. Search publication is the final required indexing gate: the file is not reported ready or visible until that stage succeeds. A knowledge base without a semantic contract remains usable for the base file-first workflow and reports that semantic maintenance is required instead of indexing only later uploads into a partial semantic corpus.

## Embeddings

Embedding configurations are managed in their own Settings tab and apply to both supported search providers. Use authenticated HTTPS endpoints for cloud services. Authentication mode `none` is limited to trusted local or private-network endpoints.

| Setting | Purpose | Default or starting value |
| --- | --- | --- |
| Display name | Name shown in Admin UI. | Include provider and purpose. |
| Authentication mode | `api_key` sends a server-side key; `none` uses no credential. | `api_key` |
| Base URL | OpenAI-compatible embedding API base URL. | `https://api.openai.com/v1` |
| API key | Server-side provider credential for `api_key` mode. | Required for `api_key`; never shown in full after save. |
| Model name | Provider embedding-model identifier. | Match provider documentation exactly. |
| Requested dimension | Optional output dimension requested from a compatible provider. | Empty to use the model's resolved dimension. |
| Normalization | Vector normalization applied by Focowiki. | `l2`; `none` is also supported. |
| Maximum input tokens | Maximum input budget declared for one embedding input. | `8192` |
| Batch size | Maximum embedding inputs sent in one request. | `32` |
| Timeout milliseconds | Maximum time for one embedding request. | `30000` |
| Retry count | Maximum retries after a temporary provider failure. | `2` |
| Minimum interval milliseconds | Minimum interval between provider requests. | `0` |
| Concurrency | Maximum concurrent embedding requests. | `4` |
| Maximum response bytes | Maximum accepted provider response size. | `8388608` |

Create a configuration, use **Test** to validate the endpoint and resolved vector dimension, then use **Activate**. One exact active configuration revision is pinned to new semantic work. Editing a saved configuration creates a new revision; existing knowledge bases adopt that revision only after **Maintain index** completes. Compatible immutable embedding artifacts can be reused during provider-only maintenance without making the same model calls again.

The table shows the resolved dimension, validation state, and lifecycle state as read-only status. Pause prevents new work from selecting the configuration. Resume makes a paused revision selectable again. Delete is blocked while a configuration revision is still referenced by active or in-progress work. Secrets remain redacted in lists, status, errors, logs, and API responses.

## Reranker Models

Reranking is optional and query-time only. The Reranker Settings tab stores the model connection, credential, identity, validation, lifecycle, timeout, retry, minimum interval, and concurrency. Create a configuration, use **Test**, then **Activate** it. Pausing, replacing, or deleting a Reranker does not rebuild a knowledge base or change its semantic generation. Missing, paused, or failed reranking leaves search available through deterministic hybrid ranking.

Enter the provider base URL, such as `https://provider.example/v1`. Focowiki appends `/rerank` and sends the standard rerank request to `https://provider.example/v1/rerank`. Do not enter `/rerank` or `/v1/chat/completions` in this field; Chat Completions is not a supported Reranker protocol.

The final result `limit`, `rerankTopK`, and `rerankScoreThreshold` are Developer OpenAPI request fields. They are intentionally absent from Admin Settings. `rerank` defaults to `false`; when enabled, the API sends only title, path, and limited source-grounded excerpts from already authorized candidates. The embedding cosine relevance threshold remains part of the active embedding query policy and is independent of the Reranker score threshold.

## Models

Generation-model assistance is optional for the base file-first workflow. File upload, navigation, exact and lexical search, and deterministic relationships continue without an active model. Semantic enrichment requires both an active generation model and an active, validated embedding configuration. Only one generation model can be active at a time.

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
