import { randomUUID } from "node:crypto";
import type { EmbeddingGateway } from "./gateway.js";
import type { EmbeddingConfigurationPrivate } from "./configuration.js";
import type { SemanticEmbeddingInput } from "./input-builder.js";
import {
  createEmbeddingArtifactIdentity
} from "./contract-identity.js";
import {
  decodeVectorArtifact,
  encodeVectorArtifact
} from "./vector-artifact-codec.js";
import type {
  EmbeddingArtifactRecord,
  EmbeddingArtifactRepositoryPort,
  EmbeddingArtifactStorePort
} from "./artifact-ports.js";
import { EmbeddingArtifactObjectUnavailableError } from "./artifact-ports.js";
import { mapWithConcurrency } from "../../runtime/bounded.js";
import { createEmbeddingBatchCoordinator } from "./batch-coordinator.js";

type ResolveArtifactRequest = {
  embeddingInput: SemanticEmbeddingInput;
  configuration: EmbeddingConfigurationPrivate;
  knowledgeBaseId: string;
  semanticGenerationPublicId: string;
  operationPublicId: string | null;
  retentionKind: "candidate" | "active" | "retry" | "cleanup";
  sourceExcerpt: string;
  signal?: AbortSignal;
};

type ResolveArtifactResult = {
  artifact: EmbeddingArtifactRecord;
  vector: readonly number[];
  reused: boolean;
};

export function createEmbeddingArtifactService(input: {
  gateway: Pick<EmbeddingGateway, "embed">;
  repository: EmbeddingArtifactRepositoryPort;
  store: EmbeddingArtifactStorePort;
  clock?: () => string;
  createWriteAttemptPublicId?: () => string;
  batchWindowMs?: number;
}) {
  const clock = input.clock ?? (() => new Date().toISOString());
  const createWriteAttemptPublicId = input.createWriteAttemptPublicId
    ?? (() => `embedding-write:${randomUUID()}`);
  const embeddingBatches = createEmbeddingBatchCoordinator({
    gateway: input.gateway,
    ...(input.batchWindowMs === undefined ? {} : { batchWindowMs: input.batchWindowMs })
  });
  const inFlight = new Map<string, Promise<ResolveArtifactResult>>();
  const objectWrites = new Map<string, Promise<void>>();
  const service = {
    batchStats() {
      return embeddingBatches.stats();
    },
    async resolve(request: ResolveArtifactRequest): Promise<ResolveArtifactResult> {
      const [result] = await service.resolveMany([request]);
      if (!result) throw new Error("Embedding artifact resolution returned no result");
      return result;
    },
    async resolveMany(
      requests: readonly ResolveArtifactRequest[]
    ): Promise<readonly ResolveArtifactResult[]> {
      if (requests.length === 0) return [];
      const configuration = requests[0]!.configuration;
      const dimension = validatedDimension(configuration);
      if (requests.some((request) =>
        request.configuration.revisionPublicId !== configuration.revisionPublicId
        || request.configuration.vectorProducingRevisionPublicId
          !== configuration.vectorProducingRevisionPublicId
        || request.configuration.normalization !== configuration.normalization
        || request.configuration.resolvedDimension !== dimension)) {
        throw new Error("Embedding artifact batch requires one compatible configuration");
      }
      const prepared = await mapWithConcurrency(
        requests.map((request, index) => ({ request, index })),
        configuration.concurrency,
        async ({ request, index }) => {
          const identity = createEmbeddingArtifactIdentity({
            knowledgeBaseId: request.knowledgeBaseId,
            ownerKind: request.embeddingInput.inputKind,
            ownerPublicId: request.embeddingInput.ownerPublicId,
            sourceRevisionPublicId: request.embeddingInput.sourceRevisionPublicId,
            canonicalInputSha256: request.embeddingInput.canonicalInputSha256,
            embeddingConfigurationRevisionPublicId:
              request.configuration.vectorProducingRevisionPublicId,
            normalization: request.configuration.normalization,
            dimension,
            inputKind: request.embeddingInput.inputKind
          });
          const compatible = await input.repository.findCompatible(identity);
          return {
            index,
            request,
            identity,
            compatible,
            reusable: compatible ? null : await input.repository.findReusable(identity)
          };
        }
      );
      const results = new Array<ResolveArtifactResult>(requests.length);
      const missing: Array<typeof prepared[number]> = [];
      const unavailableArtifacts = new Map<number, EmbeddingArtifactRecord>();
      await mapWithConcurrency(
        prepared,
        configuration.concurrency,
        async (item) => {
          if (
            item.compatible?.state !== "verified"
            && item.compatible?.state !== "orphaned"
          ) {
            if (item.reusable?.state === "verified"
              || item.reusable?.state === "orphaned") {
              try {
                results[item.index] = await reuseAcrossRevision(
                  item.request,
                  item.identity,
                  item.reusable,
                  dimension
                );
                return;
              } catch (error) {
                if (!(error instanceof EmbeddingArtifactObjectUnavailableError)) {
                  throw error;
                }
              }
            }
            missing.push(item);
            return;
          }
          try {
            results[item.index] = await reuseCompatible(
              item.request,
              item.compatible,
              dimension
            );
          } catch (error) {
            if (!(error instanceof EmbeddingArtifactObjectUnavailableError)) throw error;
            unavailableArtifacts.set(item.index, item.compatible);
            missing.push(item);
          }
        }
      );
      missing.sort((left, right) => left.index - right.index);
      if (missing.length > 0) {
        const leaders: Array<{
          item: typeof missing[number];
          resolution: ReturnType<typeof deferred<ResolveArtifactResult>>;
        }> = [];
        const pending = missing.map((item) => {
          const key = item.identity.artifactPublicId;
          const existing = inFlight.get(key);
          if (existing) return { item, leader: false, promise: existing };
          const resolution = deferred<ResolveArtifactResult>();
          inFlight.set(key, resolution.promise);
          leaders.push({ item, resolution });
          return { item, leader: true, promise: resolution.promise };
        });
        const completed = Promise.all(pending.map(async (entry) => {
          const resolved = await entry.promise;
          if (entry.leader) return { entry, resolved };
          await attachResolvedReference(entry.item.request, resolved.artifact);
          return { entry, resolved: { ...resolved, reused: true } };
        }));
        try {
          if (leaders.length > 0) {
            const signals = leaders
              .map(({ item }) => item.request.signal)
              .filter((signal): signal is AbortSignal => signal !== undefined);
            const vectors = await embeddingBatches.embed({
              configuration,
              inputs: leaders.map(({ item }) =>
                item.request.embeddingInput.canonicalText),
              signal: signals.length > 0 ? AbortSignal.any(signals) : null
            });
            if (vectors.length !== leaders.length) {
              throw new Error("Embedding gateway returned an invalid batch cardinality");
            }
            await mapWithConcurrency(
              leaders.map((leader, vectorIndex) => ({ leader, vectorIndex })),
              configuration.concurrency,
              async ({ leader, vectorIndex }) => {
                const vector = vectors[vectorIndex];
                if (!vector) throw new Error("Embedding gateway returned no vector");
                leader.resolution.resolve(await persistMissing(
                  leader.item.request,
                  leader.item.identity,
                  vector,
                  dimension,
                  unavailableArtifacts.get(leader.item.index) ?? null
                ));
              }
            );
          }
        } catch (error) {
          leaders.forEach(({ resolution }) => resolution.reject(error));
        } finally {
          leaders.forEach(({ item, resolution }) => {
            if (inFlight.get(item.identity.artifactPublicId) === resolution.promise) {
              inFlight.delete(item.identity.artifactPublicId);
            }
          });
        }
        for (const { entry, resolved } of await completed) {
          results[entry.item.index] = resolved;
        }
      }
      if (results.some((result) => !result)) {
        throw new Error("Embedding artifact batch result is incomplete");
      }
      return results;
    }
  };
  return service;

  async function reuseCompatible(
    request: ResolveArtifactRequest,
    compatible: EmbeddingArtifactRecord,
    dimension: number
  ): Promise<ResolveArtifactResult> {
    throwIfAborted(request.signal);
    const descriptor = descriptorFromRecord(compatible);
    const bytes = await input.store.readVerified({
      descriptor,
      maximumBytes: maximumVectorBytes(dimension),
      ...(request.signal ? { signal: request.signal } : {})
    });
    const vector = decodeVectorArtifact({
      bytes,
      checksumSha256: compatible.vectorChecksumSha256,
      dimension,
      normalization: request.configuration.normalization,
      maximumBytes: maximumVectorBytes(dimension)
    });
    throwIfAborted(request.signal);
    await input.repository.attachReference({
      artifact: compatible,
      semanticGenerationPublicId: request.semanticGenerationPublicId,
      operationPublicId: request.operationPublicId,
      sourceFilePublicId: request.embeddingInput.sourceFilePublicId,
      sourceExcerpt: request.sourceExcerpt,
      retentionKind: request.retentionKind
    });
    return {
      artifact: compatible.state === "orphaned"
        ? { ...compatible, state: "verified" }
        : compatible,
      vector,
      reused: true
    };
  }

  async function reuseAcrossRevision(
    request: ResolveArtifactRequest,
    identity: ReturnType<typeof createEmbeddingArtifactIdentity>,
    sourceArtifact: EmbeddingArtifactRecord,
    dimension: number
  ): Promise<ResolveArtifactResult> {
    throwIfAborted(request.signal);
    const bytes = await input.store.readVerified({
      descriptor: descriptorFromRecord(sourceArtifact),
      maximumBytes: maximumVectorBytes(dimension),
      ...(request.signal ? { signal: request.signal } : {})
    });
    const vector = decodeVectorArtifact({
      bytes,
      checksumSha256: sourceArtifact.vectorChecksumSha256,
      dimension,
      normalization: request.configuration.normalization,
      maximumBytes: maximumVectorBytes(dimension)
    });
    throwIfAborted(request.signal);
    const artifact = await input.repository.reuseVerified({
      sourceArtifact,
      identity,
      artifactPublicId: identity.artifactPublicId,
      semanticGenerationPublicId: request.semanticGenerationPublicId,
      operationPublicId: request.operationPublicId,
      sourceFilePublicId: request.embeddingInput.sourceFilePublicId,
      sourceExcerpt: request.sourceExcerpt,
      retentionKind: request.retentionKind,
      reusedAt: clock()
    });
    return { artifact, vector, reused: true };
  }

  async function attachResolvedReference(
    request: ResolveArtifactRequest,
    artifact: EmbeddingArtifactRecord
  ): Promise<void> {
    throwIfAborted(request.signal);
    await input.repository.attachReference({
      artifact,
      semanticGenerationPublicId: request.semanticGenerationPublicId,
      operationPublicId: request.operationPublicId,
      sourceFilePublicId: request.embeddingInput.sourceFilePublicId,
      sourceExcerpt: request.sourceExcerpt,
      retentionKind: request.retentionKind
    });
  }

  async function persistMissing(
    request: ResolveArtifactRequest,
    identity: ReturnType<typeof createEmbeddingArtifactIdentity>,
    vector: readonly number[],
    dimension: number,
    unavailableArtifact: EmbeddingArtifactRecord | null
  ): Promise<ResolveArtifactResult> {
    throwIfAborted(request.signal);
    const encoded = encodeVectorArtifact({
      vector,
      normalization: request.configuration.normalization
    });
    if (encoded.dimension !== dimension) throw new Error("Embedding vector dimension changed");
    const descriptor = input.store.describe(encoded.bytes);
    return withObjectWriteLock(descriptor.objectId, async () => {
      const writeAttemptPublicId = createWriteAttemptPublicId();
      await input.repository.reserveObject({
        descriptor,
        writeAttemptPublicId,
        createdAt: clock()
      });
      try {
        throwIfAborted(request.signal);
        await input.store.putVerified({
          descriptor,
          bytes: encoded.bytes,
          ...(request.signal ? { signal: request.signal } : {})
        });
        throwIfAborted(request.signal);
        const artifact = await input.repository.commitVerified({
          identity,
          artifactPublicId: identity.artifactPublicId,
          descriptor,
          writeAttemptPublicId,
          vectorChecksumSha256: encoded.checksumSha256,
          semanticGenerationPublicId: request.semanticGenerationPublicId,
          operationPublicId: request.operationPublicId,
          sourceFilePublicId: request.embeddingInput.sourceFilePublicId,
          sourceExcerpt: request.sourceExcerpt,
          retentionKind: request.retentionKind,
          verifiedAt: clock(),
          ...(unavailableArtifact ? {
            replaceUnavailable: {
              artifactPublicId: unavailableArtifact.publicId,
              objectId: unavailableArtifact.objectId
            }
          } : {})
        });
        return { artifact, vector, reused: false };
      } catch (error) {
        await input.repository.markWriteFailed({
          descriptor,
          writeAttemptPublicId,
          safeCode: safeWriteFailureCode(error),
          failedAt: clock()
        });
        throw error;
      }
    });
  }

  async function withObjectWriteLock<T>(
    objectId: string,
    work: () => Promise<T>
  ): Promise<T> {
    const previous = objectWrites.get(objectId) ?? Promise.resolve();
    const turn = deferred<void>();
    const tail = previous.catch(() => undefined).then(() => turn.promise);
    objectWrites.set(objectId, tail);
    await previous.catch(() => undefined);
    try {
      return await work();
    } finally {
      turn.resolve();
      if (objectWrites.get(objectId) === tail) {
        objectWrites.delete(objectId);
      }
    }
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function validatedDimension(configuration: EmbeddingConfigurationPrivate): number {
  const dimension = configuration.resolvedDimension;
  if (configuration.validationStatus !== "valid" || dimension === null) {
    throw new Error("Embedding artifact work requires a validated configuration");
  }
  return dimension;
}

function descriptorFromRecord(record: EmbeddingArtifactRecord) {
  return {
    objectId: record.objectId,
    storageKey: record.storageKey,
    checksumSha256: record.vectorChecksumSha256,
    byteCount: record.byteCount,
    contentType: "application/octet-stream" as const,
    objectFormat: "semantic-vector-v1" as const
  };
}

function maximumVectorBytes(dimension: number): number {
  return 16 + dimension * 4;
}

function safeWriteFailureCode(error: unknown): string {
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) {
    return "embedding_artifact_interrupted";
  }
  return "embedding_artifact_write_failed";
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Embedding artifact work aborted", "AbortError");
  }
}
