import { gzipSync } from "node:zlib";
import { Meilisearch } from "meilisearch";
import type {
  SearchEngineDocument,
  SearchEnginePressure,
  SearchEngineSettings,
  SearchEngineTask,
  SearchEngineTransport
} from "../../application/ports/search-engine-transport.js";
import {
  SearchEngineTransportError
} from "../../application/ports/search-engine-transport.js";

type TransportConfig = {
  endpoint: string;
  apiKey: string;
  metricsApiKey?: string;
  timeoutMs: number;
  maxAttempts: number;
  retryDelayMs: number;
};

type MeilisearchClient = InstanceType<typeof Meilisearch>;

const SUPPORTED_MEILISEARCH_MAJOR = 1;
const SUPPORTED_MEILISEARCH_MINOR = 51;

type TransportDependencies = {
  client?: MeilisearchClient;
  fetch?: typeof globalThis.fetch;
  sleep?: (milliseconds: number) => Promise<void>;
};

export function createMeilisearchTransport(
  config: TransportConfig,
  dependencies: TransportDependencies = {}
): SearchEngineTransport {
  const client = dependencies.client ?? new Meilisearch({
    host: config.endpoint,
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    timeout: config.timeoutMs,
    clientAgents: ["Focowiki"]
  });
  const fetchImpl = dependencies.fetch ?? globalThis.fetch;
  const sleep = dependencies.sleep ?? wait;

  return {
    async health() {
      return execute(async () => {
        const result = await client.health();
        if (result.status !== "available") return { available: false };
        const version = await client.getVersion();
        assertSupportedVersion(version.pkgVersion);
        return { available: true };
      });
    },

    async getPressure() {
      const metricsUrl = new URL("/metrics", `${config.endpoint}/`);
      return execute(async () => {
        const response = await fetchImpl(metricsUrl, {
          method: "GET",
          headers: {
            accept: "text/plain",
            authorization: `Bearer ${config.metricsApiKey ?? config.apiKey}`
          },
          signal: AbortSignal.timeout(config.timeoutMs)
        });
        if (!response.ok) throw await createHttpError(response);
        return parsePressureMetrics(await response.text());
      });
    },

    async createIndex(input) {
      const task = await execute(() =>
        client.createIndex(input.indexUid, { primaryKey: input.primaryKey })
      );
      return { taskUid: task.taskUid };
    },

    async getIndex(input) {
      try {
        const index = await execute(
          () => client.getRawIndex(input.indexUid),
          { preserveNotFound: true }
        );
        return {
          uid: index.uid,
          primaryKey: index.primaryKey ?? null
        };
      } catch (error) {
        if (isIndexNotFound(error)) return null;
        throw error;
      }
    },

    async getDocument(input) {
      try {
        return await execute(
          () => client.index(input.indexUid).getDocument(input.documentId),
          { preserveNotFound: true }
        ) as Record<string, unknown>;
      } catch (error) {
        if (isDocumentNotFound(error) || isIndexNotFound(error)) return null;
        throw error;
      }
    },

    async getSettings(indexUid) {
      const settings = await execute(() => client.index(indexUid).getSettings());
      return normalizeSettings(settings);
    },

    async updateSettings(input) {
      const task = await execute(() =>
        client.index(input.indexUid).updateSettings(input.settings)
      );
      return { taskUid: task.taskUid };
    },

    async addDocuments(input) {
      return sendCompressedDocumentRequest({
        method: "POST",
        indexUid: input.indexUid,
        query: {
          primaryKey: input.primaryKey,
          customMetadata: input.correlation
        },
        documents: input.documents
      });
    },

    async deleteDocuments(input) {
      if ((!input.ids || input.ids.length === 0) && !input.filter) {
        throw new SearchEngineTransportError("SEARCH_ENGINE_REQUEST_FAILED", false);
      }
      const task = await execute(() =>
        client.index(input.indexUid).deleteDocuments(
          input.filter ? { filter: input.filter } : input.ids ?? [],
          { customMetadata: input.correlation }
        )
      );
      return { taskUid: task.taskUid };
    },

    async deleteIndex(indexUid) {
      const task = await execute(() => client.deleteIndex(indexUid));
      return { taskUid: task.taskUid };
    },

    async swapIndexes(input) {
      if (input.pairs.length === 0) {
        throw new SearchEngineTransportError("SEARCH_ENGINE_REQUEST_FAILED", false);
      }
      const task = await execute(() =>
        client.swapIndexes(input.pairs.map((pair) => ({
          indexes: [pair.left, pair.right],
          rename: false
        })))
      );
      return { taskUid: task.taskUid };
    },

    async findTaskByCorrelation(input) {
      const tasks = await execute(() => client.tasks.getTasks({
        indexUids: [input.indexUid],
        types: ["documentAdditionOrUpdate", "documentDeletion"],
        statuses: ["enqueued", "processing", "succeeded"],
        limit: 100
      }));
      const task = tasks.results.find(
        (candidate) => candidate.customMetadata === input.correlation
      );
      return task ? normalizeTask(task) : null;
    },

    async findIndexSwapTask(input) {
      const tasks = await execute(() => client.tasks.getTasks({
        types: ["indexSwap"],
        statuses: ["enqueued", "processing", "succeeded"],
        limit: 100
      }));
      const expected = normalizedPairs(input.pairs);
      const task = tasks.results.find((candidate) => {
        const swaps = candidate.details && "swaps" in candidate.details
          ? candidate.details.swaps
          : [];
        return normalizedPairs(swaps.map((swap) => ({
          left: swap.indexes[0] ?? "",
          right: swap.indexes[1] ?? ""
        }))) === expected;
      });
      return task ? normalizeTask(task) : null;
    },

    async getTask(taskUid) {
      const task = await execute(() => client.tasks.getTask(taskUid));
      return normalizeTask(task);
    },

    async search(input) {
      const result = await execute(() =>
        client.index(input.indexUid).search(input.query, {
          filter: input.filter,
          limit: input.limit,
          offset: input.offset ?? 0,
          ...(input.attributesToSearchOn
            ? { attributesToSearchOn: input.attributesToSearchOn }
            : {}),
          attributesToRetrieve: input.attributesToRetrieve,
          attributesToCrop: input.attributesToCrop,
          cropLength: input.cropLength,
          matchingStrategy: input.matchingStrategy,
          ...(input.locales ? { locales: input.locales } : {}),
          ...(input.distinct ? { distinct: input.distinct } : {})
        })
      );
      return {
        hits: result.hits,
        estimatedTotalHits: result.estimatedTotalHits ?? result.hits.length,
        processingTimeMs: result.processingTimeMs
      };
    }
  };

  async function sendCompressedDocumentRequest(input: {
    method: "POST";
    indexUid: string;
    query: Record<string, string>;
    documents: SearchEngineDocument[];
  }): Promise<{ taskUid: number }> {
    const url = new URL(
      `/indexes/${encodeURIComponent(input.indexUid)}/documents`,
      `${config.endpoint}/`
    );
    for (const [key, value] of Object.entries(input.query)) {
      url.searchParams.set(key, value);
    }
    const compressed = gzipSync(Buffer.from(JSON.stringify(input.documents), "utf8"));
    const result = await execute(async () => {
      const response = await fetchImpl(url, {
        method: input.method,
        headers: {
          accept: "application/json",
          authorization: `Bearer ${config.apiKey}`,
          "content-encoding": "gzip",
          "content-type": "application/json"
        },
        body: compressed,
        signal: AbortSignal.timeout(config.timeoutMs)
      });
      if (!response.ok) throw await createHttpError(response);
      return await response.json() as { taskUid: number };
    });
    if (!Number.isSafeInteger(result.taskUid)) {
      throw new SearchEngineTransportError("SEARCH_ENGINE_REQUEST_FAILED", false);
    }
    return { taskUid: result.taskUid };
  }

  async function execute<T>(
    operation: () => Promise<T>,
    options: { preserveNotFound?: boolean } = {}
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= config.maxAttempts; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        lastError = error;
        if (
          options.preserveNotFound
          && (isIndexNotFound(error) || isDocumentNotFound(error))
        ) {
          throw error;
        }
        const mapped = mapTransportError(error);
        if (!mapped.retryable || attempt === config.maxAttempts) throw mapped;
        await sleep(config.retryDelayMs * attempt);
      }
    }
    throw mapTransportError(lastError);
  }
}

function normalizeTask(task: {
  uid: number;
  status: string;
}): SearchEngineTask {
  return {
    taskUid: task.uid,
    status: normalizeTaskStatus(task.status),
    errorCode: task.status === "failed" || task.status === "canceled"
      ? "SEARCH_INDEX_TASK_FAILED"
      : null
  };
}

function normalizedPairs(
  pairs: Array<{ left: string; right: string }>
): string {
  return pairs
    .map((pair) => [pair.left, pair.right].sort().join("\u0000"))
    .sort()
    .join("\u0001");
}

function parsePressureMetrics(value: string): SearchEnginePressure {
  const metrics = new Map<string, number[]>();
  for (const line of value.split(/\r?\n/u)) {
    if (!line || line.startsWith("#")) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{[^}]*\})?\s+([^\s]+)$/u.exec(
      line.trim()
    );
    if (!match) continue;
    const metricValue = Number(match[2]);
    if (!Number.isFinite(metricValue) || metricValue < 0) continue;
    const samples = metrics.get(match[1]!) ?? [];
    samples.push(metricValue);
    metrics.set(match[1]!, samples);
  }
  return {
    queueLatencyMs: requiredMetric(
      metrics,
      "meilisearch_task_queue_latency_seconds"
    ) * 1_000,
    residentMemoryBytes: requiredMetric(metrics, "process_resident_memory_bytes"),
    databaseSizeBytes: requiredMetric(metrics, "meilisearch_db_size_bytes"),
    taskQueueSizeBytes: requiredMetric(
      metrics,
      "meilisearch_task_queue_used_size"
    )
  };
}

function requiredMetric(metrics: Map<string, number[]>, name: string): number {
  const samples = metrics.get(name);
  if (!samples || samples.length === 0) {
    throw new SearchEngineTransportError("SEARCH_ENGINE_REQUEST_FAILED", false);
  }
  return Math.max(...samples);
}

function assertSupportedVersion(value: string): void {
  const match = /^(\d+)\.(\d+)\.\d+(?:[-+].*)?$/u.exec(value);
  if (
    !match
    || Number(match[1]) !== SUPPORTED_MEILISEARCH_MAJOR
    || Number(match[2]) !== SUPPORTED_MEILISEARCH_MINOR
  ) {
    throw new SearchEngineTransportError(
      "SEARCH_ENGINE_VERSION_INCOMPATIBLE",
      false
    );
  }
}

function normalizeSettings(settings: Record<string, unknown>): SearchEngineSettings {
  return {
    searchableAttributes: stringArray(settings.searchableAttributes),
    filterableAttributes: stringArray(settings.filterableAttributes),
    displayedAttributes: stringArray(settings.displayedAttributes),
    sortableAttributes: stringArray(settings.sortableAttributes),
    rankingRules: stringArray(settings.rankingRules),
    distinctAttribute:
      typeof settings.distinctAttribute === "string" ? settings.distinctAttribute : null,
    pagination: {
      maxTotalHits: positiveInteger(
        (settings.pagination as { maxTotalHits?: unknown } | undefined)?.maxTotalHits,
        1_000
      )
    },
    searchCutoffMs: positiveInteger(settings.searchCutoffMs, 500),
    localizedAttributes: Array.isArray(settings.localizedAttributes)
      ? settings.localizedAttributes as SearchEngineSettings["localizedAttributes"]
      : [],
    typoTolerance: {
      disableOnAttributes: stringArray(
        (settings.typoTolerance as { disableOnAttributes?: unknown } | undefined)
          ?.disableOnAttributes
      )
    }
  };
}

function normalizeTaskStatus(status: string): SearchEngineTask["status"] {
  if (
    status === "enqueued"
    || status === "processing"
    || status === "succeeded"
    || status === "failed"
    || status === "canceled"
  ) {
    return status;
  }
  return "unknown";
}

function mapTransportError(error: unknown): SearchEngineTransportError {
  if (error instanceof SearchEngineTransportError) return error;
  if (isIndexNotFound(error)) {
    return new SearchEngineTransportError("SEARCH_ENGINE_UNAVAILABLE", true);
  }
  const status = extractStatus(error);
  if (status === 401 || status === 403) {
    return new SearchEngineTransportError(
      "SEARCH_ENGINE_AUTHENTICATION_FAILED",
      false
    );
  }
  if (status === 429) {
    return new SearchEngineTransportError("SEARCH_ENGINE_OVERLOADED", true);
  }
  if (
    status === 408
    || (status !== null && status >= 500)
    || error instanceof TypeError
    || error instanceof Error && /timeout|timed out|ECONN|fetch failed/iu.test(error.message)
  ) {
    return new SearchEngineTransportError("SEARCH_ENGINE_UNAVAILABLE", true);
  }
  return new SearchEngineTransportError("SEARCH_ENGINE_REQUEST_FAILED", false);
}

async function createHttpError(response: Response): Promise<Error & { status: number }> {
  const error = new Error(`Search service returned HTTP ${response.status}`) as Error & {
    status: number;
  };
  error.status = response.status;
  await response.body?.cancel().catch(() => undefined);
  return error;
}

function extractStatus(error: unknown): number | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as {
    status?: unknown;
    response?: { status?: unknown };
  };
  if (typeof candidate.status === "number") return candidate.status;
  return typeof candidate.response?.status === "number"
    ? candidate.response.status
    : null;
}

function isIndexNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    cause?: { code?: unknown };
    code?: unknown;
  };
  return candidate.cause?.code === "index_not_found" || candidate.code === "index_not_found";
}

function isDocumentNotFound(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    cause?: { code?: unknown };
    code?: unknown;
  };
  return candidate.cause?.code === "document_not_found"
    || candidate.code === "document_not_found";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function positiveInteger(value: unknown, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
