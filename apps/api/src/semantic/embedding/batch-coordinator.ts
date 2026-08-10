import type { EmbeddingGateway } from "./gateway.js";
import type { EmbeddingConfigurationPrivate } from "./configuration.js";

type BatchRequest = {
  configuration: EmbeddingConfigurationPrivate;
  inputs: readonly string[];
  signal: AbortSignal | null;
};

type PendingInput = {
  input: string;
  signal: AbortSignal | null;
  resolve(vector: readonly number[]): void;
  reject(error: unknown): void;
};

type PendingGroup = {
  configuration: EmbeddingConfigurationPrivate;
  pending: PendingInput[];
  timer: ReturnType<typeof setTimeout> | null;
  flushes: number;
};

export type EmbeddingBatchStats = {
  providerRequestCount: number;
  inputCount: number;
  completedInputCount: number;
  failedInputCount: number;
  maximumBatchSize: number;
  batchCapacity: number;
  batchFillRatio: number;
  activeGroups: number;
  pendingInputs: number;
  activeFlushes: number;
};

export function createEmbeddingBatchCoordinator(input: {
  gateway: Pick<EmbeddingGateway, "embed">;
  batchWindowMs?: number;
}) {
  const batchWindowMs = input.batchWindowMs ?? 50;
  if (!Number.isSafeInteger(batchWindowMs) || batchWindowMs < 0 || batchWindowMs > 100) {
    throw new Error("Embedding batch window is invalid");
  }
  const groups = new Map<string, PendingGroup>();
  let providerRequestCount = 0;
  let inputCount = 0;
  let completedInputCount = 0;
  let failedInputCount = 0;
  let maximumBatchSize = 0;
  let batchCapacity = 0;
  return {
    embed(request: BatchRequest): Promise<readonly (readonly number[])[]> {
      if (request.inputs.length === 0) {
        throw new Error("Embedding batch requires at least one input");
      }
      throwIfAborted(request.signal);
      return Promise.all(request.inputs.map((value) => enqueue(request, value)));
    },
    stats(): EmbeddingBatchStats {
      return {
        providerRequestCount,
        inputCount,
        completedInputCount,
        failedInputCount,
        maximumBatchSize,
        batchCapacity,
        batchFillRatio: batchCapacity === 0 ? 0 : inputCount / batchCapacity,
        activeGroups: groups.size,
        pendingInputs: [...groups.values()].reduce(
          (total, group) => total + group.pending.length,
          0
        ),
        activeFlushes: [...groups.values()].reduce(
          (total, group) => total + group.flushes,
          0
        )
      };
    }
  };

  function enqueue(
    request: BatchRequest,
    value: string
  ): Promise<readonly number[]> {
    const key = request.configuration.revisionPublicId;
    const group = groups.get(key) ?? {
      configuration: request.configuration,
      pending: [],
      timer: null,
      flushes: 0
    };
    if (group.configuration.vectorProducingRevisionPublicId
        !== request.configuration.vectorProducingRevisionPublicId
      || group.configuration.batchSize !== request.configuration.batchSize
      || group.configuration.resolvedDimension
        !== request.configuration.resolvedDimension) {
      throw new Error("Embedding batch configuration changed within one revision");
    }
    groups.set(key, group);
    const result = new Promise<readonly number[]>((resolve, reject) => {
      group.pending.push({ input: value, signal: request.signal, resolve, reject });
    });
    schedule(group, key, group.pending.length >= group.configuration.batchSize ? 0 : batchWindowMs);
    return result;
  }

  function schedule(group: PendingGroup, key: string, delayMs: number): void {
    if (group.timer !== null) {
      if (delayMs !== 0) return;
      clearTimeout(group.timer);
    }
    group.timer = setTimeout(() => {
      group.timer = null;
      void flush(group, key);
    }, delayMs);
    group.timer.unref?.();
  }

  async function flush(group: PendingGroup, key: string): Promise<void> {
    const batch: PendingInput[] = [];
    while (batch.length < group.configuration.batchSize && group.pending.length > 0) {
      const item = group.pending.shift()!;
      if (item.signal?.aborted) item.reject(abortReason(item.signal));
      else batch.push(item);
    }
    if (group.pending.length > 0) {
      schedule(
        group,
        key,
        group.pending.length >= group.configuration.batchSize ? 0 : batchWindowMs
      );
    }
    if (batch.length === 0) {
      releaseGroupIfIdle(group, key);
      return;
    }
    group.flushes += 1;
    providerRequestCount += 1;
    inputCount += batch.length;
    maximumBatchSize = Math.max(maximumBatchSize, batch.length);
    batchCapacity += group.configuration.batchSize;
    try {
      const vectors = await input.gateway.embed({
        configuration: group.configuration,
        inputs: batch.map((item) => item.input),
        signal: null
      });
      if (vectors.length !== batch.length) {
        throw new Error("Embedding gateway returned an invalid batch cardinality");
      }
      completedInputCount += batch.length;
      batch.forEach((item, index) => {
        if (item.signal?.aborted) item.reject(abortReason(item.signal));
        else {
          const vector = vectors[index];
          if (!vector) item.reject(new Error("Embedding gateway returned no vector"));
          else item.resolve(vector);
        }
      });
    } catch (error) {
      failedInputCount += batch.length;
      batch.forEach((item) => item.reject(error));
    } finally {
      group.flushes -= 1;
      releaseGroupIfIdle(group, key);
    }
  }

  function releaseGroupIfIdle(group: PendingGroup, key: string): void {
    if (group.pending.length === 0 && group.timer === null && group.flushes === 0) {
      groups.delete(key);
    }
  }
}

function throwIfAborted(signal: AbortSignal | null): void {
  if (signal?.aborted) throw abortReason(signal);
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("Embedding batch aborted", "AbortError");
}
