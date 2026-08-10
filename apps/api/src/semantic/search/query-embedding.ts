import { createHash } from "node:crypto";

export type SemanticQueryEmbeddingRequest = {
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  embeddingConfigurationRevisionPublicId: string;
  dimension: number;
  normalization: "none" | "l2";
  query: string;
  deadlineMs: number;
  signal: AbortSignal | null;
};

export function createSemanticQueryEmbeddingGateway(input: {
  embed(request: SemanticQueryEmbeddingRequest & {
    signal: AbortSignal;
  }): Promise<readonly number[]>;
  maximumConcurrency: number;
  maximumBacklog: number;
  maximumCacheEntries: number;
  cacheTtlMs: number;
  now?: () => number;
}) {
  assertPositive(input.maximumConcurrency, "concurrency");
  assertNonNegative(input.maximumBacklog, "backlog");
  assertPositive(input.maximumCacheEntries, "cache entries");
  assertPositive(input.cacheTtlMs, "cache TTL");
  const now = input.now ?? Date.now;
  const cache = new Map<string, { vector: readonly number[]; expiresAt: number }>();
  const inFlight = new Map<string, Promise<readonly number[]>>();
  const queue: Array<{
    run(): Promise<readonly number[]>;
    resolve(value: readonly number[]): void;
    reject(error: unknown): void;
  }> = [];
  let active = 0;

  return {
    async embed(request: SemanticQueryEmbeddingRequest): Promise<readonly number[]> {
      assertRequest(request);
      const effectiveRequest = { ...request, query: normalizeQuery(request.query) };
      const key = identity(effectiveRequest);
      const cached = cache.get(key);
      if (cached && cached.expiresAt > now()) {
        cache.delete(key);
        cache.set(key, cached);
        return [...cached.vector];
      }
      if (cached) cache.delete(key);
      let shared = inFlight.get(key);
      if (!shared) {
        shared = schedule(() => invoke(effectiveRequest)).then((vector) => {
          cache.set(key, { vector: [...vector], expiresAt: now() + input.cacheTtlMs });
          while (cache.size > input.maximumCacheEntries) {
            const oldest = cache.keys().next().value as string | undefined;
            if (oldest === undefined) break;
            cache.delete(oldest);
          }
          return vector;
        }).finally(() => {
          inFlight.delete(key);
        });
        inFlight.set(key, shared);
      }
      return [...await waitForCaller(shared, effectiveRequest)];
    },
    stats() {
      return {
        active,
        queued: queue.length,
        inFlight: inFlight.size,
        cached: cache.size
      };
    }
  };

  function schedule(
    run: () => Promise<readonly number[]>
  ): Promise<readonly number[]> {
    if (active >= input.maximumConcurrency
      && queue.length >= input.maximumBacklog) {
      return Promise.reject(gatewayError("semantic_query_embedding_backlog_full"));
    }
    return new Promise((resolve, reject) => {
      queue.push({ run, resolve, reject });
      drain();
    });
  }

  function drain(): void {
    while (active < input.maximumConcurrency && queue.length > 0) {
      const work = queue.shift()!;
      active += 1;
      void work.run().then(work.resolve, work.reject).finally(() => {
        active -= 1;
        drain();
      });
    }
  }

  async function invoke(
    request: SemanticQueryEmbeddingRequest
  ): Promise<readonly number[]> {
    const controller = new AbortController();
    const timeout = gatewayError("semantic_query_embedding_timeout");
    const timer = setTimeout(() => controller.abort(timeout), request.deadlineMs);
    timer.unref?.();
    try {
      const vector = await input.embed({ ...request, signal: controller.signal });
      if (vector.length !== request.dimension
        || vector.some((value) => !Number.isFinite(value))
        || vector.every((value) => value === 0)) {
        throw gatewayError("semantic_query_embedding_invalid_vector");
      }
      return [...vector];
    } catch (error) {
      if (controller.signal.aborted) throw timeout;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

async function waitForCaller(
  shared: Promise<readonly number[]>,
  request: SemanticQueryEmbeddingRequest
): Promise<readonly number[]> {
  if (request.signal?.aborted) {
    throw gatewayError("semantic_query_embedding_cancelled");
  }
  let timer: ReturnType<typeof setTimeout> | null = null;
  let onAbort: (() => void) | null = null;
  const caller = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(gatewayError("semantic_query_embedding_timeout")),
      request.deadlineMs
    );
    timer.unref?.();
    if (request.signal) {
      onAbort = () => reject(gatewayError("semantic_query_embedding_cancelled"));
      request.signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([shared, caller]);
  } finally {
    if (timer) clearTimeout(timer);
    if (request.signal && onAbort) request.signal.removeEventListener("abort", onAbort);
  }
}

function assertRequest(value: SemanticQueryEmbeddingRequest): void {
  if (!value.knowledgeBaseId || !value.semanticGenerationPublicId
    || !value.embeddingConfigurationRevisionPublicId
    || !normalizeQuery(value.query) || Buffer.byteLength(normalizeQuery(value.query)) > 2_048
    || !["none", "l2"].includes(value.normalization)
    || !Number.isSafeInteger(value.dimension) || value.dimension < 1
    || value.dimension > 65_536
    || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1
    || value.deadlineMs > 30_000) {
    throw gatewayError("semantic_query_embedding_invalid_input");
  }
}

function identity(value: SemanticQueryEmbeddingRequest): string {
  return createHash("sha256").update(JSON.stringify({
    embeddingConfigurationRevisionPublicId:
      value.embeddingConfigurationRevisionPublicId,
    dimension: value.dimension,
    normalization: value.normalization,
    query: normalizeQuery(value.query)
  })).digest("hex");
}

function normalizeQuery(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ");
}

function assertPositive(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Semantic query embedding ${field} is invalid`);
  }
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Semantic query embedding ${field} is invalid`);
  }
}

function gatewayError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Semantic query embedding failed: ${code}`), { code });
}
