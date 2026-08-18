import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type {
  EmbeddingArtifactRecord,
  EmbeddingArtifactRepositoryPort,
  EmbeddingArtifactStorePort
} from "../src/semantic/embedding/artifact-ports.js";
import { EmbeddingArtifactObjectUnavailableError } from
  "../src/semantic/embedding/artifact-ports.js";
import { createEmbeddingArtifactService } from "../src/semantic/embedding/artifact-service.js";
import { createEmbeddingArtifactIdentity } from
  "../src/semantic/embedding/contract-identity.js";
import { buildSemanticEmbeddingInput } from "../src/semantic/embedding/input-builder.js";
import {
  decodeVectorArtifact,
  encodeVectorArtifact
} from "../src/semantic/embedding/vector-artifact-codec.js";

describe("embedding artifact service", () => {
  it("reuses a compatible immutable artifact without a model call", async () => {
    const encoded = encodeVectorArtifact({ vector: [0.6, 0.8, 0], normalization: "l2" });
    const record = artifactRecord(encoded);
    const attachReference = vi.fn(async () => undefined);
    const repository = repositoryStub({ findCompatible: async () => record, attachReference });
    const gateway = { embed: vi.fn() };
    const service = createEmbeddingArtifactService({
      gateway,
      repository,
      store: storeStub(encoded.bytes)
    });
    const result = await service.resolve(resolveRequest());
    expect(result.reused).toBe(true);
    expect(result.vector).toEqual(expect.arrayContaining([expect.closeTo(0.6), expect.closeTo(0.8), 0]));
    expect(gateway.embed).not.toHaveBeenCalled();
    expect(attachReference).toHaveBeenCalledWith(expect.objectContaining({
      sourceExcerpt: "Source-grounded excerpt"
    }));
  });

  it("rebinds a content-identical artifact to a new revision without a model call", async () => {
    const encoded = encodeVectorArtifact({
      vector: [0.6, 0.8, 0], normalization: "l2"
    });
    const prior = artifactRecord(encoded);
    const rebound = {
      ...prior,
      publicId: "artifact-revision-2",
      ownerPublicId: "content-revision-2",
      sourceRevisionPublicId: "revision-2"
    };
    const reuseVerified = vi.fn(async () => rebound);
    const gateway = { embed: vi.fn() };
    const service = createEmbeddingArtifactService({
      gateway,
      repository: repositoryStub({
        findCompatible: async () => null,
        findReusable: async () => prior,
        reuseVerified
      }),
      store: storeStub(encoded.bytes),
      clock: () => "2026-08-14T08:00:00.000Z"
    });
    const request = {
      ...resolveRequest(),
      embeddingInput: buildSemanticEmbeddingInput({
        inputKind: "content",
        ownerPublicId: "content-revision-2",
        sourceFilePublicId: "file-1",
        sourceRevisionPublicId: "revision-2",
        fields: { body: "Shared knowledge" },
        evidenceTargets: [{
          sourceFilePublicId: "file-1",
          sourceRevisionPublicId: "revision-2",
          evidencePublicId: "evidence-revision-2",
          logicalPath: "renamed.md"
        }],
        maximumCharacters: 1_000,
        maximumEvidenceTargets: 4
      })
    };

    await expect(service.resolve(request)).resolves.toMatchObject({
      reused: true,
      artifact: { publicId: "artifact-revision-2" }
    });
    expect(gateway.embed).not.toHaveBeenCalled();
    expect(reuseVerified).toHaveBeenCalledWith(expect.objectContaining({
      sourceArtifact: prior,
      identity: expect.objectContaining({
        ownerPublicId: "content-revision-2",
        sourceRevisionPublicId: "revision-2"
      }),
      sourceFilePublicId: "file-1",
      reusedAt: "2026-08-14T08:00:00.000Z"
    }));
  });

  it("reclaims a compatible orphaned artifact without regenerating its vector", async () => {
    const encoded = encodeVectorArtifact({
      vector: [0.6, 0.8, 0], normalization: "l2"
    });
    const record = { ...artifactRecord(encoded), state: "orphaned" as const };
    const attachReference = vi.fn(async () => undefined);
    const repository = repositoryStub({
      findCompatible: async () => record,
      attachReference
    });
    const gateway = { embed: vi.fn() };
    const service = createEmbeddingArtifactService({
      gateway,
      repository,
      store: storeStub(encoded.bytes)
    });

    await expect(service.resolve(resolveRequest())).resolves.toMatchObject({
      reused: true,
      artifact: { publicId: record.publicId }
    });
    expect(gateway.embed).not.toHaveBeenCalled();
    expect(attachReference).toHaveBeenCalledOnce();
  });

  it("writes, verifies, owns, and references a new artifact in order", async () => {
    const events: string[] = [];
    const repository = repositoryStub({
      findCompatible: async () => null,
      reserveObject: async () => { events.push("reserve"); return "reserved"; },
      commitVerified: async (input) => {
        events.push("commit-owner-reference");
        return { ...input.identity, publicId: input.artifactPublicId, objectId: input.descriptor.objectId, storageKey: input.descriptor.storageKey, vectorChecksumSha256: input.vectorChecksumSha256, byteCount: input.descriptor.byteCount, state: "verified" };
      }
    });
    const store = storeStub(null, {
      putVerified: async () => { events.push("store-verify"); return "stored"; }
    });
    const service = createEmbeddingArtifactService({
      gateway: { embed: async () => [[0.6, 0.8, 0]] },
      repository,
      store,
      clock: () => "2026-08-08T00:00:00.000Z",
      createWriteAttemptPublicId: () => "embedding-write-1"
    });
    const result = await service.resolve(resolveRequest());
    expect(result.reused).toBe(false);
    expect(events).toEqual(["reserve", "store-verify", "commit-owner-reference"]);
  });

  it("rebuilds a compatible artifact whose physical object is unavailable", async () => {
    const encoded = encodeVectorArtifact({ vector: [0.6, 0.8, 0], normalization: "l2" });
    let record = artifactRecord(encoded);
    const embed = vi.fn(async () => [[0.6, 0.8, 0]]);
    const reserveObject = vi.fn(async () => "reused" as const);
    const commitVerified = vi.fn(async (commit: any) => ({
      ...commit.identity,
      publicId: commit.artifactPublicId,
      objectId: commit.descriptor.objectId,
      storageKey: commit.descriptor.storageKey,
      vectorChecksumSha256: commit.vectorChecksumSha256,
      byteCount: commit.descriptor.byteCount,
      state: "verified" as const
    }));
    const putVerified = vi.fn(async () => "stored" as const);
    const service = createEmbeddingArtifactService({
      gateway: { embed },
      repository: repositoryStub({
        findCompatible: async (identity) => {
          const compatibleIdentity = createEmbeddingArtifactIdentity(identity);
          record = {
            ...record,
            ...identity,
            publicId: compatibleIdentity.artifactPublicId
          };
          return record;
        },
        reserveObject,
        commitVerified
      }),
      store: storeStub(null, {
        readVerified: async () => {
          throw new EmbeddingArtifactObjectUnavailableError();
        },
        putVerified
      }),
      createWriteAttemptPublicId: () => "embedding-write-repair"
    });

    await expect(service.resolve(resolveRequest())).resolves.toMatchObject({
      reused: false,
      vector: expect.arrayContaining([expect.closeTo(0.6), expect.closeTo(0.8), 0])
    });
    expect(embed).toHaveBeenCalledOnce();
    expect(reserveObject).toHaveBeenCalledOnce();
    expect(putVerified).toHaveBeenCalledOnce();
    expect(commitVerified).toHaveBeenCalledOnce();
    expect(commitVerified).toHaveBeenCalledWith(expect.objectContaining({
      replaceUnavailable: {
        artifactPublicId: record.publicId,
        objectId: record.objectId
      }
    }));
  });

  it("embeds all compatible missing inputs in one configured batch", async () => {
    const firstRequest = resolveRequest();
    const secondRequest = requestFor("content-2", "Second source");
    const thirdRequest = requestFor("content-3", "Third source");
    const compatibleEncoded = encodeVectorArtifact({
      vector: [1, 0, 0],
      normalization: "l2"
    });
    const compatible = {
      ...artifactRecord(compatibleEncoded),
      publicId: "artifact-content-2",
      ownerPublicId: "content-2",
      canonicalInputSha256: secondRequest.embeddingInput.canonicalInputSha256
    };
    let commitIndex = 0;
    const repository = repositoryStub({
      findCompatible: async (identity) =>
        identity.ownerPublicId === "content-2" ? compatible : null,
      commitVerified: async (input) => ({
        ...input.identity,
        publicId: input.artifactPublicId,
        objectId: input.descriptor.objectId,
        storageKey: input.descriptor.storageKey,
        vectorChecksumSha256: input.vectorChecksumSha256,
        byteCount: input.descriptor.byteCount,
        state: "verified"
      })
    });
    const embed = vi.fn(async ({ inputs }: { inputs: readonly string[] }) => {
      expect(inputs).toEqual([
        firstRequest.embeddingInput.canonicalText,
        thirdRequest.embeddingInput.canonicalText
      ]);
      return [[0.6, 0.8, 0], [0, 0.8, 0.6]];
    });
    const service = createEmbeddingArtifactService({
      gateway: { embed },
      repository,
      store: storeStub(compatibleEncoded.bytes),
      createWriteAttemptPublicId: () => `embedding-write-${++commitIndex}`
    });

    const results = await service.resolveMany([
      firstRequest,
      secondRequest,
      thirdRequest
    ]);

    expect(embed).toHaveBeenCalledOnce();
    expect(results.map((result) => result.reused)).toEqual([false, true, false]);
    expect(results.map((result) => result.artifact.ownerPublicId))
      .toEqual(["content-1", "content-2", "content-3"]);
  });

  it("coalesces concurrent compatible source requests into one transport batch", async () => {
    const firstRequest = resolveRequest();
    const secondRequest = requestFor("content-2", "Second source");
    let commitIndex = 0;
    const embed = vi.fn(async ({ inputs }: { inputs: readonly string[] }) => {
      expect(inputs).toEqual([
        firstRequest.embeddingInput.canonicalText,
        secondRequest.embeddingInput.canonicalText
      ]);
      return [[1, 0, 0], [0, 1, 0]];
    });
    const service = createEmbeddingArtifactService({
      gateway: { embed },
      repository: repositoryStub({
        findCompatible: async () => null,
        commitVerified: async (input) => ({
          ...input.identity,
          publicId: input.artifactPublicId,
          objectId: input.descriptor.objectId,
          storageKey: input.descriptor.storageKey,
          vectorChecksumSha256: input.vectorChecksumSha256,
          byteCount: input.descriptor.byteCount,
          state: "verified"
        })
      }),
      store: storeStub(null),
      createWriteAttemptPublicId: () => `embedding-write-batch-${++commitIndex}`
    });

    const first = service.resolve(firstRequest);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const results = await Promise.all([
      first,
      service.resolve(secondRequest)
    ]);

    expect(embed).toHaveBeenCalledOnce();
    expect(results.map((result) => result.artifact.ownerPublicId))
      .toEqual(["content-1", "content-2"]);
    expect(service.batchStats()).toEqual(expect.objectContaining({
      providerRequestCount: 1,
      inputCount: 2,
      completedInputCount: 2,
      failedInputCount: 0,
      maximumBatchSize: 2,
      batchCapacity: configuration().batchSize,
      batchFillRatio: 2 / configuration().batchSize,
      activeGroups: 0,
      pendingInputs: 0,
      activeFlushes: 0
    }));
  });

  it("coalesces duplicate immutable identities across concurrent retries", async () => {
    const request = resolveRequest();
    const commitVerified = vi.fn(async (input: any) => ({
      ...input.identity,
      publicId: input.artifactPublicId,
      objectId: input.descriptor.objectId,
      storageKey: input.descriptor.storageKey,
      vectorChecksumSha256: input.vectorChecksumSha256,
      byteCount: input.descriptor.byteCount,
      state: "verified"
    }));
    const attachReference = vi.fn(async () => undefined);
    const embed = vi.fn(async ({ inputs }: { inputs: readonly string[] }) => {
      expect(inputs).toEqual([request.embeddingInput.canonicalText]);
      return [[1, 0, 0]];
    });
    const service = createEmbeddingArtifactService({
      gateway: { embed },
      repository: repositoryStub({
        findCompatible: async () => null,
        commitVerified,
        attachReference
      }),
      store: storeStub(null),
      createWriteAttemptPublicId: () => "embedding-write-deduplicated"
    });

    const [first, second, third] = await Promise.all([
      service.resolve(request),
      service.resolve(request),
      service.resolveMany([request]).then((items) => items[0]!)
    ]);

    expect(embed).toHaveBeenCalledOnce();
    expect(commitVerified).toHaveBeenCalledOnce();
    expect(new Set([first, second, third].map((item) => item.artifact.publicId)))
      .toEqual(new Set([first.artifact.publicId]));
    expect([first, second, third].filter((item) => item.reused)).toHaveLength(2);
    expect(attachReference).toHaveBeenCalledTimes(2);
  });

  it("serializes and revalidates distinct artifacts that share one physical vector", async () => {
    const firstRequest = resolveRequest();
    const secondRequest = requestFor("content-2", "Second source");
    let objectState: "absent" | "reserved" | "verified" = "absent";
    const reserveObject = vi.fn(async () => {
      if (objectState === "reserved") {
        throw new Error("Embedding artifact object reservation conflicts");
      }
      if (objectState === "verified") return "reused" as const;
      objectState = "reserved";
      return "reserved" as const;
    });
    const commitVerified = vi.fn(async (input: any) => {
      objectState = "verified";
      return {
        ...input.identity,
        publicId: input.artifactPublicId,
        objectId: input.descriptor.objectId,
        storageKey: input.descriptor.storageKey,
        vectorChecksumSha256: input.vectorChecksumSha256,
        byteCount: input.descriptor.byteCount,
        state: "verified"
      };
    });
    let physicalWriteCount = 0;
    const storedObjects = new Set<string>();
    const putVerified = vi.fn(async ({ descriptor }: any) => {
      if (storedObjects.has(descriptor.objectId)) return "reused" as const;
      storedObjects.add(descriptor.objectId);
      physicalWriteCount += 1;
      return "stored" as const;
    });
    const service = createEmbeddingArtifactService({
      gateway: { embed: async () => [[1, 0, 0], [1, 0, 0]] },
      repository: repositoryStub({
        findCompatible: async () => null,
        reserveObject,
        commitVerified
      }),
      store: storeStub(null, { putVerified }),
      createWriteAttemptPublicId: (() => {
        let index = 0;
        return () => `embedding-write-shared-${++index}`;
      })()
    });

    const results = await service.resolveMany([firstRequest, secondRequest]);

    expect(results).toHaveLength(2);
    expect(reserveObject).toHaveBeenCalledTimes(2);
    expect(putVerified).toHaveBeenCalledTimes(2);
    expect(physicalWriteCount).toBe(1);
    expect(commitVerified).toHaveBeenCalledTimes(2);
  });

  it("marks partial or failed registration for owned reconciliation", async () => {
    const markWriteFailed = vi.fn(async () => undefined);
    const repository = repositoryStub({
      findCompatible: async () => null,
      commitVerified: async () => { throw new Error("database unavailable"); },
      markWriteFailed
    });
    const service = createEmbeddingArtifactService({
      gateway: { embed: async () => [[1, 0, 0]] },
      repository,
      store: storeStub(null),
      createWriteAttemptPublicId: () => "embedding-write-2"
    });
    await expect(service.resolve(resolveRequest())).rejects.toThrow("database unavailable");
    expect(markWriteFailed).toHaveBeenCalledWith(expect.objectContaining({
      writeAttemptPublicId: "embedding-write-2",
      safeCode: "embedding_artifact_write_failed"
    }));
  });

  it("rejects late artifact output after cancellation and records reconciliation", async () => {
    const controller = new AbortController();
    const markWriteFailed = vi.fn(async () => undefined);
    const service = createEmbeddingArtifactService({
      gateway: { embed: async () => [[1, 0, 0]] },
      repository: repositoryStub({ findCompatible: async () => null, markWriteFailed }),
      store: storeStub(null, {
        putVerified: async () => {
          controller.abort(new DOMException("superseded", "AbortError"));
          return "stored";
        }
      }),
      createWriteAttemptPublicId: () => "embedding-write-cancelled"
    });
    await expect(service.resolve({ ...resolveRequest(), signal: controller.signal }))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(markWriteFailed).toHaveBeenCalledWith(expect.objectContaining({
      writeAttemptPublicId: "embedding-write-cancelled",
      safeCode: "embedding_artifact_interrupted"
    }));
  });

  it("rejects corrupt, oversized, or non-finite vector artifacts", () => {
    const encoded = encodeVectorArtifact({ vector: [1, 2, 3], normalization: "none" });
    const corrupt = Uint8Array.from(encoded.bytes);
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect(() => decodeVectorArtifact({
      bytes: corrupt,
      checksumSha256: encoded.checksumSha256,
      dimension: 3,
      normalization: "none",
      maximumBytes: encoded.byteCount
    })).toThrow("integrity");
    expect(() => decodeVectorArtifact({
      bytes: encoded.bytes,
      checksumSha256: encoded.checksumSha256,
      dimension: 3,
      normalization: "none",
      maximumBytes: encoded.byteCount - 1
    })).toThrow("integrity");
    expect(() => encodeVectorArtifact({ vector: [Number.NaN], normalization: "none" }))
      .toThrow("invalid");
  });
});

function resolveRequest() {
  return {
    embeddingInput: buildSemanticEmbeddingInput({
      inputKind: "content",
      ownerPublicId: "content-1",
      sourceFilePublicId: "file-1",
      sourceRevisionPublicId: "revision-1",
      fields: { body: "Shared knowledge" },
      evidenceTargets: [{ sourceFilePublicId: "file-1", sourceRevisionPublicId: "revision-1", evidencePublicId: "evidence-1", logicalPath: "overview.md" }],
      maximumCharacters: 1_000,
      maximumEvidenceTargets: 4
    }),
    configuration: configuration(),
    knowledgeBaseId: "kb-1",
    semanticGenerationPublicId: "generation-1",
    operationPublicId: "operation-1",
    retentionKind: "candidate" as const,
    sourceExcerpt: "Source-grounded excerpt"
  };
}

function requestFor(ownerPublicId: string, body: string) {
  return {
    ...resolveRequest(),
    embeddingInput: buildSemanticEmbeddingInput({
      inputKind: "content",
      ownerPublicId,
      sourceFilePublicId: "file-1",
      sourceRevisionPublicId: "revision-1",
      fields: { body },
      evidenceTargets: [{
        sourceFilePublicId: "file-1",
        sourceRevisionPublicId: "revision-1",
        evidencePublicId: `evidence-${ownerPublicId}`,
        logicalPath: "overview.md"
      }],
      maximumCharacters: 1_000,
      maximumEvidenceTargets: 4
    })
  };
}

function artifactRecord(encoded: ReturnType<typeof encodeVectorArtifact>): EmbeddingArtifactRecord {
  return {
    publicId: "artifact-1",
    knowledgeBaseId: "kb-1",
    ownerKind: "content",
    ownerPublicId: "content-1",
    sourceRevisionPublicId: "revision-1",
    canonicalInputSha256: createHash("sha256").update("content: Shared knowledge").digest("hex"),
    inputKind: "content",
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    normalization: "l2",
    dimension: 3,
    artifactSchemaVersion: "focowiki-vector-artifact-v1",
    objectId: "semantic-vector-object-1",
    storageKey: "focowiki/semantic/1.bin",
    vectorChecksumSha256: encoded.checksumSha256,
    byteCount: encoded.byteCount,
    state: "verified"
  };
}

function repositoryStub(overrides: Partial<EmbeddingArtifactRepositoryPort> = {}): EmbeddingArtifactRepositoryPort {
  return {
    findCompatible: async () => null,
    findReusable: async () => null,
    reserveObject: async () => "reserved",
    commitVerified: async () => { throw new Error("unexpected commit"); },
    reuseVerified: async () => { throw new Error("unexpected reuse"); },
    attachReference: async () => undefined,
    listSourceReferences: async () => [],
    markWriteFailed: async () => undefined,
    releaseReferences: async () => 0,
    releaseSupersededSourceReferences: async () => 0,
    listOrphaned: async () => ({ items: [], nextCursor: null }),
    claimOrphaned: async () => null,
    completeOrphanDeletion: async () => false,
    abandonOrphanDeletion: async () => undefined,
    ...overrides
  };
}

function storeStub(
  bytes: Uint8Array | null,
  overrides: Partial<EmbeddingArtifactStorePort> = {}
): EmbeddingArtifactStorePort {
  return {
    describe(value) {
      const checksum = createHash("sha256").update(value).digest("hex");
      return { objectId: `semantic-sha256:${checksum}`, storageKey: `focowiki/semantic/${checksum}.bin`, checksumSha256: checksum, byteCount: value.byteLength, contentType: "application/octet-stream", objectFormat: "semantic-vector-v1" };
    },
    putVerified: async () => "stored",
    readVerified: async () => {
      if (!bytes) throw new Error("missing bytes");
      return bytes;
    },
    deleteIfUnowned: async () => undefined,
    ...overrides
  };
}

function configuration() {
  return {
    publicId: "embedding-1",
    revisionPublicId: "embedding-revision-1",
    revision: 1,
    displayName: "Embedding",
    authenticationMode: "none" as const,
    baseUrl: "http://embedding.local/v1",
    encryptedApiKey: null,
    apiKeyConfigured: false,
    modelName: "embedding-model",
    requestedDimension: 3,
    resolvedDimension: 3,
    normalization: "l2" as const,
    maximumInputTokens: 8_192,
    batchSize: 16,
    timeoutMs: 10_000,
    retryCount: 2,
    minimumIntervalMs: 20,
    concurrency: 2,
    maximumResponseBytes: 1_000_000,
    minimumVectorRelevance: 0.7,
    vectorProducingRevisionPublicId: "embedding-revision-1",
    queryPolicyRevisionPublicId: "embedding-revision-1",
    validationStatus: "valid" as const,
    validationFingerprintSha256: "a".repeat(64),
    safeValidationErrorCode: null,
    lifecycleStatus: "active" as const,
    createdAt: "2026-08-08T00:00:00.000Z"
  };
}
