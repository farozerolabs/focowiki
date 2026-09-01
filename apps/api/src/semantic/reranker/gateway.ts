import { createHash } from "node:crypto";
import { createBoundedTaskRunner } from "../../runtime/task-runner.js";
import { decryptRuntimeSecret } from "../../runtime-settings/encryption.js";
import type { RerankerConfigurationPrivate } from "./configuration.js";
import type { RerankerTransport } from "./openai-compatible-transport.js";
import { RerankerTransportError } from "./openai-compatible-transport.js";

const DEFAULT_MAXIMUM_EXCERPT_CHARACTERS = 1_200;
const DEFAULT_MAXIMUM_EXCERPT_BYTES = 4_096;
const DEFAULT_MAXIMUM_PAYLOAD_BYTES = 262_144;
const DEFAULT_MAXIMUM_BACKLOG = 32;
const MAXIMUM_CACHE_ENTRIES = 128;

export type RerankerCandidate = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  sourceExcerpt: string;
  sourceGrounded: boolean;
  priority: "exact_path" | "exact_title" | "fused";
  evidenceTypes: readonly string[];
};

export type RerankerStatus = {
  state: "not_configured" | "skipped" | "applied" | "degraded";
  safeCode: string | null;
};

export type RerankerMetrics = {
  windowCount: number;
  thresholdRejectedCount: number;
};

export function createRerankerGateway(input: {
  resolveActiveConfiguration(): Promise<RerankerConfigurationPrivate | null>;
  transport: RerankerTransport;
  deploymentSecret: string;
  maximumExcerptCharacters?: number;
  maximumExcerptBytes?: number;
  maximumPayloadBytes?: number;
  maximumBacklog?: number;
  delay?: (milliseconds: number, signal: AbortSignal | null) => Promise<void>;
}) {
  const maximumExcerptCharacters = input.maximumExcerptCharacters
    ?? DEFAULT_MAXIMUM_EXCERPT_CHARACTERS;
  const maximumExcerptBytes = input.maximumExcerptBytes
    ?? DEFAULT_MAXIMUM_EXCERPT_BYTES;
  const maximumPayloadBytes = input.maximumPayloadBytes
    ?? DEFAULT_MAXIMUM_PAYLOAD_BYTES;
  const maximumBacklog = input.maximumBacklog ?? DEFAULT_MAXIMUM_BACKLOG;
  assertPositive(maximumExcerptCharacters);
  assertPositive(maximumExcerptBytes);
  assertPositive(maximumPayloadBytes);
  if (!Number.isSafeInteger(maximumBacklog) || maximumBacklog < 0) {
    throw new Error("Reranker backlog bound is invalid");
  }
  const cache = new Map<string, readonly number[]>();
  const inFlight = new Map<string, Promise<readonly number[]>>();
  let runnerRevisionPublicId: string | null = null;
  let runner: ReturnType<typeof createBoundedTaskRunner> | null = null;
  let pending = 0;
  const delay = input.delay ?? abortableDelay;

  return {
    async rerank(request: {
      query: string;
      knowledgeBaseId: string;
      candidates: readonly RerankerCandidate[];
      rerankTopK: number;
      rerankScoreThreshold: number;
      limit: number;
      signal: AbortSignal | null;
    }): Promise<{
      candidates: readonly RerankerCandidate[];
      status: RerankerStatus;
      metrics?: RerankerMetrics;
    }> {
      const safeCandidates = authorizedCandidates(
        request.candidates,
        request.knowledgeBaseId
      );
      const fallback = safeCandidates.slice(0, request.limit);
      if (!validRequest(request)) {
        return degraded(fallback, "RERANKER_INVALID_REQUEST");
      }
      let configuration: RerankerConfigurationPrivate | null;
      try {
        configuration = await input.resolveActiveConfiguration();
      } catch {
        return degraded(fallback, "RERANKER_CONFIGURATION_UNAVAILABLE");
      }
      if (!configuration) {
        return {
          candidates: fallback,
          status: { state: "not_configured", safeCode: "RERANKER_NOT_CONFIGURED" }
        };
      }
      if (configuration.lifecycleStatus !== "active"
        || configuration.validationStatus !== "valid") {
        return {
          candidates: fallback,
          status: { state: "skipped", safeCode: "RERANKER_NOT_ACTIVE" }
        };
      }
      const exact = safeCandidates.filter((candidate) =>
        candidate.priority === "exact_path" || candidate.priority === "exact_title"
      );
      const window = safeCandidates.filter((candidate) =>
        candidate.priority === "fused"
      ).slice(0, request.rerankTopK);
      if (window.length === 0) {
        return {
          candidates: fallback,
          status: { state: "skipped", safeCode: "RERANKER_NO_CANDIDATES" }
        };
      }
      const documents = window.map((candidate) => formatDocument(
        candidate,
        maximumExcerptCharacters,
        maximumExcerptBytes
      ));
      if (Buffer.byteLength(JSON.stringify({ query: request.query, documents }))
        > maximumPayloadBytes) {
        return degraded(fallback, "RERANKER_PAYLOAD_TOO_LARGE");
      }
      try {
        const scores = await resolveScores(configuration, request.query, documents,
          request.signal);
        if (scores.length !== window.length || scores.some((score) =>
          !Number.isFinite(score) || score < 0 || score > 1)) {
          throw new RerankerTransportError("invalid_response", false);
        }
        const ranked = window.map((candidate, index) => ({
          candidate,
          score: scores[index]!,
          inputRank: index
        })).filter((item) => item.score >= request.rerankScoreThreshold)
          .sort((left, right) => right.score - left.score
            || left.inputRank - right.inputRank)
          .map((item) => item.candidate);
        const allBelowThreshold = request.rerankScoreThreshold > 0
          && ranked.length === 0;
        return {
          candidates: [...exact, ...ranked].slice(0, request.limit),
          status: {
            state: "applied",
            safeCode: allBelowThreshold
              ? "RERANKER_ALL_BELOW_THRESHOLD"
              : null
          },
          metrics: {
            windowCount: window.length,
            thresholdRejectedCount: window.length - ranked.length
          }
        };
      } catch (error) {
        return degraded(fallback, safeErrorCode(error));
      }
    }
  };

  async function resolveScores(
    configuration: RerankerConfigurationPrivate,
    query: string,
    documents: readonly string[],
    signal: AbortSignal | null
  ): Promise<readonly number[]> {
    const key = createHash("sha256").update(JSON.stringify([
      configuration.revisionPublicId,
      query.normalize("NFKC").trim().replace(/\s+/gu, " "),
      documents
    ])).digest("hex");
    const cached = cache.get(key);
    if (cached) return cached;
    const shared = inFlight.get(key);
    if (shared) return shared;
    if (runnerRevisionPublicId !== configuration.revisionPublicId) {
      runnerRevisionPublicId = configuration.revisionPublicId;
      runner = createBoundedTaskRunner(configuration.concurrency, {
        minStartIntervalMs: configuration.minimumIntervalMs
      });
      pending = 0;
      inFlight.clear();
      cache.clear();
    }
    if (!runner || pending >= configuration.concurrency + maximumBacklog) {
      throw new RerankerTransportError("rate_limited", true);
    }
    pending += 1;
    const promise = runner.run(() => rerankWithRetry(
      configuration,
      query,
      documents,
      signal
    )).then((scores) => {
      cache.set(key, Object.freeze([...scores]));
      while (cache.size > MAXIMUM_CACHE_ENTRIES) {
        cache.delete(cache.keys().next().value as string);
      }
      return scores;
    }).finally(() => {
      pending -= 1;
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  }

  async function rerankWithRetry(
    configuration: RerankerConfigurationPrivate,
    query: string,
    documents: readonly string[],
    signal: AbortSignal | null
  ): Promise<readonly number[]> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await input.transport.rerank({
          baseUrl: configuration.baseUrl,
          authenticationMode: configuration.authenticationMode,
          apiKey: decryptApiKey(configuration, input.deploymentSecret),
          modelName: configuration.modelName,
          query,
          documents,
          timeoutMs: configuration.timeoutMs,
          signal
        });
        return response.scores;
      } catch (error) {
        if (!(error instanceof RerankerTransportError)
          || !error.retryable || attempt >= configuration.retryCount) throw error;
        await delay(configuration.minimumIntervalMs, signal);
      }
    }
  }
}

function authorizedCandidates(
  candidates: readonly RerankerCandidate[],
  knowledgeBaseId: string
): RerankerCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const requiresExcerpt = candidate.priority === "fused";
    if (candidate.knowledgeBaseId !== knowledgeBaseId || !candidate.sourceGrounded
      || requiresExcerpt && !candidate.sourceExcerpt.trim()
      || seen.has(candidate.sourceFilePublicId)) {
      return false;
    }
    seen.add(candidate.sourceFilePublicId);
    return true;
  });
}

function formatDocument(
  candidate: RerankerCandidate,
  maximumCharacters: number,
  maximumBytes: number
): string {
  const excerpt = boundUtf8(
    candidate.sourceExcerpt.normalize("NFKC").replace(/\s+/gu, " ").trim(),
    maximumCharacters,
    maximumBytes
  );
  return [
    boundUtf8(candidate.title, 512, 2_048),
    boundUtf8(candidate.logicalPath, 1_024, 4_096),
    excerpt
  ].join("\n");
}

function boundUtf8(value: string, maximumCharacters: number, maximumBytes: number) {
  let result = "";
  for (const character of [...value].slice(0, maximumCharacters)) {
    if (Buffer.byteLength(result + character) > maximumBytes) break;
    result += character;
  }
  return result;
}

function validRequest(input: {
  query: string;
  rerankTopK: number;
  rerankScoreThreshold: number;
  limit: number;
}): boolean {
  return Boolean(input.query.trim())
    && Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 50
    && Number.isSafeInteger(input.rerankTopK)
    && input.rerankTopK >= input.limit && input.rerankTopK <= 50
    && Number.isFinite(input.rerankScoreThreshold)
    && input.rerankScoreThreshold >= 0 && input.rerankScoreThreshold <= 1;
}

function decryptApiKey(
  configuration: RerankerConfigurationPrivate,
  deploymentSecret: string
): string | null {
  if (configuration.authenticationMode === "none") return null;
  if (!configuration.encryptedApiKey) throw new Error("credential_unavailable");
  return decryptRuntimeSecret({
    value: configuration.encryptedApiKey,
    secret: deploymentSecret
  });
}

function degraded(
  candidates: readonly RerankerCandidate[],
  safeCode: string
): { candidates: readonly RerankerCandidate[]; status: RerankerStatus } {
  return { candidates, status: { state: "degraded", safeCode } };
}

function safeErrorCode(error: unknown): string {
  if (error instanceof RerankerTransportError) {
    return `RERANKER_${error.code.toUpperCase()}`;
  }
  return "RERANKER_UNAVAILABLE";
}

function assertPositive(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Reranker runtime bound is invalid");
  }
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | null
): Promise<void> {
  if (signal?.aborted) throw new RerankerTransportError("aborted", false);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new RerankerTransportError("aborted", false));
    }, { once: true });
  });
}
