import type {
  LexicalRebuildProjectionResult,
  LexicalRebuildWorkClaim,
  LexicalRebuildWorkRepository,
  LexicalRebuildWorkSource
} from "../application/ports/lexical-rebuild-work-repository.js";
import type { LexicalTokenizer } from "../application/ports/lexical-tokenizer.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";
import { deriveLexicalProjections } from "./lexical-projection-derivation.js";
import {
  LexicalSourceReadError,
  type LexicalSourceRead,
  type LexicalSourceReader
} from "./lexical-source-reader.js";

export type LexicalClaimProcessingMetrics = {
  claimed: number;
  sourceReadCount: number;
  sourceReadBytes: number;
  sourceReadRetries: number;
  sourceReadDurationMs: number;
  sourceReadLatencyAverageMs: number | null;
  sourceReadLatencyMaximumMs: number | null;
  deriveCount: number;
  deriveDurationMs: number;
  databaseBatchCount: number;
  databaseWriteDurationMs: number;
  completed: number;
  retried: number;
};

export async function processLexicalRebuildClaims(input: {
  repository: LexicalRebuildWorkRepository;
  sourceReader: LexicalSourceReader;
  tokenizer: LexicalTokenizer;
  databaseWriteBudget: ResourceBudget;
  workerId: string;
  claims: LexicalRebuildWorkClaim[];
  databaseBatchSize: number;
  retryDelayMs: number;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  clock?: (() => Date) | undefined;
  onHeartbeatError?: ((error: unknown) => void) | undefined;
  onMetrics?: ((metrics: LexicalClaimProcessingMetrics) => void) | undefined;
}): Promise<{ completed: number; retried: number }> {
  const metrics: LexicalClaimProcessingMetrics = {
    claimed: input.claims.length,
    sourceReadCount: 0,
    sourceReadBytes: 0,
    sourceReadRetries: 0,
    sourceReadDurationMs: 0,
    sourceReadLatencyAverageMs: null,
    sourceReadLatencyMaximumMs: null,
    deriveCount: 0,
    deriveDurationMs: 0,
    databaseBatchCount: 0,
    databaseWriteDurationMs: 0,
    completed: 0,
    retried: 0
  };
  const sources = await input.repository.loadSources(input.claims);
  const availableIds = new Set(sources.map((source) => source.sourceFileId));
  const unavailable = input.claims.filter((claim) => !availableIds.has(claim.sourceFileId));
  if (unavailable.length > 0) {
    await input.repository.retry({
      workerId: input.workerId,
      claims: unavailable,
      stage: "derive",
      errorCode: "LEXICAL_SOURCE_STATE_CHANGED",
      errorMessage: "The source file changed before lexical rebuild processing",
      failedAt: now(input.clock),
      retryDelayMs: input.retryDelayMs
    });
  }

  let completed = 0;
  let retried = unavailable.length;
  let sourceReadLatencyTotalMs = 0;
  let sourceReadLatencyCount = 0;
  for (const batch of chunkSources(sources, input.databaseBatchSize)) {
    const heartbeat = startHeartbeat({
      repository: input.repository,
      workerId: input.workerId,
      claims: batch,
      intervalMs: input.heartbeatIntervalMs,
      leaseDurationMs: input.leaseDurationMs,
      clock: input.clock,
      onError: input.onHeartbeatError
    });
    const sourceReadStartedAt = performance.now();
    const reads = await Promise.allSettled(
      batch.map((source) => input.sourceReader.read(source))
    );
    metrics.sourceReadDurationMs += performance.now() - sourceReadStartedAt;
    metrics.sourceReadCount += batch.length;
    const readable: LexicalSourceRead[] = [];
    const failedClaims: Array<{
      claim: LexicalRebuildWorkClaim;
      error: unknown;
    }> = [];
    reads.forEach((result, index) => {
      if (result.status === "fulfilled") {
        readable.push(result.value);
        metrics.sourceReadBytes += result.value.bytes;
        metrics.sourceReadRetries += result.value.retryCount;
        sourceReadLatencyTotalMs += result.value.latencyMs;
        sourceReadLatencyCount += 1;
        metrics.sourceReadLatencyMaximumMs = Math.max(
          metrics.sourceReadLatencyMaximumMs ?? 0,
          result.value.latencyMs
        );
      } else {
        failedClaims.push({ claim: batch[index]!, error: result.reason });
      }
    });

    try {
      for (const failure of failedClaims) {
        await input.repository.retry({
          workerId: input.workerId,
          claims: [failure.claim],
          stage: "source_read",
          errorCode: failure.error instanceof LexicalSourceReadError
            ? failure.error.code
            : "LEXICAL_SOURCE_READ_FAILED",
          errorMessage: failure.error instanceof Error
            ? failure.error.message
            : "The source object could not be read",
          failedAt: now(input.clock),
          retryDelayMs: input.retryDelayMs
        });
      }
      retried += failedClaims.length;
      if (readable.length === 0) continue;

      const projections: LexicalRebuildProjectionResult[] = [];
      const deriveStartedAt = performance.now();
      for (const read of readable) {
        try {
          projections.push(
            deriveLexicalProjections({ read, tokenizer: input.tokenizer })
          );
          metrics.deriveCount += 1;
        } catch (error) {
          await input.repository.retry({
            workerId: input.workerId,
            claims: [read.source],
            stage: "derive",
            errorCode: "LEXICAL_PROJECTION_DERIVATION_FAILED",
            errorMessage: error instanceof Error
              ? error.message
              : "Lexical projections could not be derived",
            failedAt: now(input.clock),
            retryDelayMs: input.retryDelayMs
          });
          retried += 1;
        }
      }
      metrics.deriveDurationMs += performance.now() - deriveStartedAt;
      if (projections.length === 0) continue;

      const databaseWriteStartedAt = performance.now();
      metrics.databaseBatchCount += 1;
      try {
        await input.databaseWriteBudget.run(() =>
          input.repository.persistBatch({
            workerId: input.workerId,
            results: projections,
            completedAt: now(input.clock)
          })
        );
        completed += projections.length;
      } catch (error) {
        input.databaseWriteBudget.recordRetry();
        const databaseFailure = classifyDatabaseWriteFailure(error);
        await input.repository.retry({
          workerId: input.workerId,
          claims: projections.map((projection) => projection.claim),
          stage: "database_write",
          errorCode: databaseFailure.code,
          errorMessage: databaseFailure.message,
          failedAt: now(input.clock),
          retryDelayMs: input.retryDelayMs
        });
        retried += projections.length;
      } finally {
        metrics.databaseWriteDurationMs += performance.now() - databaseWriteStartedAt;
      }
    } finally {
      await heartbeat.stop();
      readable.forEach((read) => read.release());
    }
  }

  metrics.completed = completed;
  metrics.retried = retried;
  metrics.sourceReadLatencyAverageMs = sourceReadLatencyCount > 0
    ? sourceReadLatencyTotalMs / sourceReadLatencyCount
    : null;
  input.onMetrics?.(metrics);
  return { completed, retried };
}

function startHeartbeat(input: {
  repository: LexicalRebuildWorkRepository;
  workerId: string;
  claims: LexicalRebuildWorkClaim[];
  intervalMs: number;
  leaseDurationMs: number;
  clock?: (() => Date) | undefined;
  onError?: ((error: unknown) => void) | undefined;
}): { stop: () => Promise<void> } {
  let inFlight: Promise<void> | null = null;
  const timer = setInterval(() => {
    if (inFlight) return;
    const heartbeatAt = now(input.clock);
    inFlight = input.repository.heartbeat({
      workerId: input.workerId,
      claims: input.claims,
      heartbeatAt,
      leaseExpiresAt: new Date(
        Date.parse(heartbeatAt) + input.leaseDurationMs
      ).toISOString()
    }).then(() => undefined)
      .catch((error) => input.onError?.(error))
      .finally(() => {
        inFlight = null;
      });
  }, Math.max(1_000, input.intervalMs));
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await inFlight;
    }
  };
}

function chunkSources(
  values: LexicalRebuildWorkSource[],
  size: number
): LexicalRebuildWorkSource[][] {
  const boundedSize = Math.max(1, Math.floor(size));
  const result: LexicalRebuildWorkSource[][] = [];
  let current: LexicalRebuildWorkSource[] = [];
  let currentBytes = 0;
  for (const value of values) {
    const maxBytes = Math.max(1, value.settings.maxInFlightSourceBytes);
    const nextBytes = Math.max(1, value.sizeBytes);
    if (
      current.length > 0
      && (
        current.length >= boundedSize
        || currentBytes + Math.min(nextBytes, maxBytes) > maxBytes
      )
    ) {
      result.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(value);
    currentBytes += Math.min(nextBytes, maxBytes);
  }
  if (current.length > 0) result.push(current);
  return result;
}

function classifyDatabaseWriteFailure(error: unknown): {
  code: string;
  message: string;
} {
  const postgresCode = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : null;
  if (postgresCode === "40001") {
    return {
      code: "LEXICAL_DATABASE_SERIALIZATION_RETRY",
      message: "The lexical database transaction will be retried"
    };
  }
  if (postgresCode === "40P01") {
    return {
      code: "LEXICAL_DATABASE_DEADLOCK_RETRY",
      message: "The lexical database transaction will be retried"
    };
  }
  if (postgresCode?.startsWith("08")) {
    return {
      code: "LEXICAL_DATABASE_CONNECTION_RETRY",
      message: "The lexical database connection will be retried"
    };
  }
  return {
    code: "LEXICAL_DATABASE_BATCH_FAILED",
    message: "Lexical projections could not be persisted"
  };
}

function now(clock: (() => Date) | undefined): string {
  return (clock?.() ?? new Date()).toISOString();
}
