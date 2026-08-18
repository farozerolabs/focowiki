---
title: Admin Settings
---

# Admin Settings

Open **Settings** from the Admin sidebar for runtime controls. Open **Model configuration** for generation, embedding, and reranker models. Saved values remain available after a restart. Changes affect new requests and newly started jobs; a job that is already running may finish with the values it started with.

The values below match the fields currently shown across those two Admin pages. Start with the defaults and increase concurrency only after checking CPU, memory, PostgreSQL, the selected search provider, and S3 latency.

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
| Document concurrency | Maximum document jobs processed at the same time. Model, GraphRAG, embedding, storage, database, and search limits can reduce effective concurrency. | `2`; increase gradually after measuring. Maximum `32`. |
| Processing maximum attempts | Attempts allowed before a file remains failed. | `3` |
| Processing retry delay milliseconds | Delay before retrying a temporary failure. | `30000` |
| Completed record retention days | Days to keep completed processing records. | `7` |

Lower document concurrency first when CPU, database latency, provider latency, or storage latency rises during large imports.

## Generated Knowledge Base

| Setting | Purpose | Default or starting value |
| --- | --- | --- |
| Directory entries per page | Direct entries listed on one generated directory page. This does not limit files in a directory. | `200` |
| Directory page bytes | Maximum UTF-8 size of one generated directory page. | `65536` |
| Root summary characters | Maximum knowledge-base description characters shown in root `index.md`. | `500` |
| Log entries | Maximum recent document events kept in `log.md`. | `100` |
| Log bytes | Maximum UTF-8 size of generated `log.md`. | `65536` |

Every successful document job updates its affected generated pages before it becomes available. There is no batch, per-file, or manual publication mode.

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
| Graph shard size | Maximum records in one generated `_graph` shard. | `5000` |
| Generic phrase threshold | Minimum normalized phrase length used to ignore overly broad shared phrases. | `4` |

Default depth and fanout must not exceed their maximum values. The review toggle controls whether the active generation model evaluates discovered relationship candidates. Document finalization still requires the active generation and embedding configurations described below.

## Maintenance

| Setting | Purpose | Default or starting value |
| --- | --- | --- |
| Storage consistency checks | Periodically finds storage entries that can be safely cleaned up. | Enabled |
| Storage scan batch size | Stored entries checked in one batch. | `500`; maximum `1000`. |
| Storage cleanup maximum attempts | Attempts allowed for a cleanup action. | `5` |
| Storage cleanup retry delay milliseconds | Delay after a temporary cleanup failure. | `30000` |
| Hard-delete concurrency | Resource-deletion cleanup actions processed at the same time. | `1`; maximum `16`. |
| Hard-delete database batch size | Database records removed in one cleanup page. | `1000` |
| Hard-delete object batch size | Stored objects removed in one cleanup page. | `1000` |
| Hard-delete maximum attempts | Attempts allowed for one cleanup action. | `3` |
| Hard-delete retry delay milliseconds | Delay before retrying temporary cleanup failures. | `60000` |
| Failed hard-delete retention days | Days to retain terminal cleanup failure records. | `30` |

Use **Maintain index** to apply a changed model, prompt, output format, embedding dimension, or search provider to an existing knowledge base, or to run an explicit repair, recovery, or full rebuild. Ordinary uploads and body replacements complete all required processing in one document job. Rename, move, metadata update, and delete operations update the affected content automatically. Existing readable files remain available while maintenance runs.

Knowledge bases and content from an earlier incompatible release cannot be updated through **Maintain index**. Follow [Update an Existing Deployment](./docker-compose.md#update-an-existing-deployment), import the source Markdown into the empty target deployment, and use **Maintain index** only for knowledge bases created by the current release.

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
| Search cleanup batch size | Maximum old-index records cleaned at once. | Maximum exact-index records cleaned at once. | `1000` |
| Search result excerpt length | Native crop length. | Maximum highlighted fragment and normalized excerpt length. | `1200` |

Keep the search-service timeout below the total request timeout. Reduce update size or in-flight tasks when the selected provider's memory or disk latency rises.

## Semantic Search

Semantic settings are shared by OpenSearch and Meilisearch. They bound optional GraphRAG and embedding work without changing the generated file tree or source Markdown.

| Setting | Purpose | Default |
| --- | --- | --- |
| Maximum chunk characters | Maximum characters in one extraction chunk. | `8000` |
| Maximum chunks | Maximum extraction chunks from one uploaded document. | `32` |
| Maximum evidence targets | Maximum source evidence targets retained for one semantic unit. | `64` |
| GraphRAG adapter timeout milliseconds | Maximum time for one GraphRAG extraction request. | `30000` |
| Semantic search lane cutoff milliseconds | Independent cutoff for optional semantic search lanes. Must not exceed the total search request timeout. | `2500` |
| Query embedding concurrency | Maximum concurrent query-embedding requests per process. | `4` |
| Query embedding cache entries | Maximum query-embedding cache entries per process. | `1000` |

Start with the defaults. Lower chunk or query-embedding limits when worker CPU or memory, model latency, or search latency rises. A failed optional semantic search lane reports a safe semantic status while completed exact and lexical lanes can still return results.

The file-processing list reports committed progress for preparation, model assistance, generated content, GraphRAG, relationship coordination, indexing, availability, and cleanup. Independent work can be active concurrently. A file becomes available only after its required source, generated pages, relationships, embeddings, and search documents are active and readable.

## Embedding Models

Embedding configurations are managed in the **Embedding models** tab under **Model configuration** and apply to both supported search providers. Use authenticated HTTPS endpoints for cloud services. Authentication mode `none` is limited to trusted local or private-network endpoints.

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

Create a configuration, use **Test** to validate the endpoint and resolved embedding dimension, then use **Activate**. New document work uses the active configuration. Editing a saved configuration creates a new revision; existing knowledge bases adopt that revision only after **Maintain index** completes. Compatible embeddings can be reused when only the search provider changes, without making the same model calls again.

The table shows the resolved dimension, validation state, and lifecycle state as read-only status. Pause prevents new work from selecting the configuration. Resume makes a paused revision selectable again. Delete is blocked while a configuration revision is still referenced by active or in-progress work. Secrets remain redacted in lists, status, errors, logs, and API responses.

## Reranker Models

Reranking is optional and query-time only. The **Reranker models** tab under **Model configuration** stores the model connection, credential, identity, validation, lifecycle, timeout, retry, minimum interval, and concurrency. Create a configuration, use **Test**, then **Activate** it. Pausing, replacing, or deleting a Reranker does not rebuild a knowledge base or change its semantic generation. Missing, paused, or failed reranking leaves search available through deterministic hybrid ranking.

Enter the provider base URL, such as `https://provider.example/v1`. Focowiki appends `/rerank` and sends the standard rerank request to `https://provider.example/v1/rerank`. Do not enter `/rerank` or `/v1/chat/completions` in this field; Chat Completions is not a supported Reranker protocol.

The final result `limit`, `rerankTopK`, and `rerankScoreThreshold` are Developer OpenAPI request fields. They are intentionally absent from Admin Settings. `rerank` defaults to `false`; when enabled, the API sends only title, path, and limited source-grounded excerpts from already authorized candidates. The embedding cosine relevance threshold remains part of the active embedding query policy and is independent of the Reranker score threshold.

## Models

Generation models are managed in the **Models** tab under **Model configuration**. Completing an upload requires both one active generation model and one active, validated embedding configuration. This ensures every accepted document follows the same indexing contract before it becomes available. Only one generation model can be active at a time.

| Setting | Purpose | Recommended value |
| --- | --- | --- |
| Display name | Name shown in Admin UI. | Include provider and purpose. |
| API mode | Provider protocol. Responses sends strict JSON Schema through `text.format`; Chat Completions first sends strict JSON Schema through `response_format` and uses JSON-object compatibility only when the provider explicitly rejects that feature. | `responses` or `chat_completions`, matching the provider endpoint. |
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

The selected structured-output capability is reused by the effective model revision. Authentication, quota, timeout, content, and unrelated request errors do not switch formats. Model execution facts retain safe request IDs, finish states, token counts when supplied by the provider, timing, and retry classification; prompts, source bodies, credentials, and reasoning content are not stored in those observations.

## Applying Changes

Admin runtime settings and model configurations are stored by Focowiki and do not belong in `.env`. Ports, domains, infrastructure credentials, database connection limits, storage credentials, and log paths remain startup configuration. Restart the affected service after changing startup configuration.
