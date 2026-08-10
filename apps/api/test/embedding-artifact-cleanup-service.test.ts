import { describe, expect, it, vi } from "vitest";
import type {
  EmbeddingArtifactDescriptor,
  EmbeddingArtifactRecord,
  EmbeddingArtifactRepositoryPort
} from "../src/semantic/embedding/artifact-ports.js";
import { createEmbeddingArtifactCleanupService } from
  "../src/semantic/embedding/artifact-cleanup-service.js";

describe("embedding artifact ownership cleanup", () => {
  it("releases bounded generation owners before deleting the last S3 object", async () => {
    const events: string[] = [];
    const repository = cleanupRepository({
      releaseReferences: async () => { events.push("release"); return 1; },
      listOrphaned: async () => ({ items: [artifact()], nextCursor: "next" }),
      claimOrphaned: async () => {
        events.push("claim");
        return { artifactPublicId: "artifact-1", descriptor: descriptor() };
      },
      completeOrphanDeletion: async () => { events.push("complete"); return true; }
    });
    const service = createEmbeddingArtifactCleanupService({
      repository,
      store: { deleteIfUnowned: async () => { events.push("s3-delete"); } },
      clock: () => "2026-08-08T00:00:00.000Z"
    });
    await expect(service.release({
      knowledgeBaseId: "kb-1",
      semanticGenerationPublicId: "generation-1",
      ownerPublicIds: ["owner-1"]
    })).resolves.toBe(1);
    await expect(service.reconcilePage({
      knowledgeBaseId: "kb-1", cursor: null, limit: 10
    })).resolves.toEqual({
      inspected: 1, deletedArtifacts: 1, deletedObjects: 1, nextCursor: "next"
    });
    expect(events).toEqual(["release", "claim", "s3-delete", "complete"]);
  });

  it("removes an orphan artifact without deleting an object shared by another owner", async () => {
    const deleteIfUnowned = vi.fn(async () => undefined);
    const service = createEmbeddingArtifactCleanupService({
      repository: cleanupRepository({
        listOrphaned: async () => ({ items: [artifact()], nextCursor: null }),
        claimOrphaned: async () => ({ artifactPublicId: "artifact-1", descriptor: null }),
        completeOrphanDeletion: async () => true
      }),
      store: { deleteIfUnowned }
    });
    await expect(service.reconcilePage({
      knowledgeBaseId: "kb-1", cursor: null, limit: 1
    })).resolves.toMatchObject({ deletedArtifacts: 1, deletedObjects: 0 });
    expect(deleteIfUnowned).not.toHaveBeenCalled();
  });

  it("abandons a pre-delete claim on S3 failure and retains a post-delete claim for retry", async () => {
    const abandon = vi.fn(async () => undefined);
    const repository = cleanupRepository({
      listOrphaned: async () => ({ items: [artifact()], nextCursor: null }),
      claimOrphaned: async () => ({ artifactPublicId: "artifact-1", descriptor: descriptor() }),
      abandonOrphanDeletion: abandon
    });
    const failingStore = createEmbeddingArtifactCleanupService({
      repository,
      store: { deleteIfUnowned: async () => { throw new Error("S3 unavailable"); } }
    });
    await expect(failingStore.reconcilePage({
      knowledgeBaseId: "kb-1", cursor: null, limit: 1
    })).rejects.toThrow("S3 unavailable");
    expect(abandon).toHaveBeenCalledOnce();

    abandon.mockClear();
    const failingCommit = createEmbeddingArtifactCleanupService({
      repository: cleanupRepository({
        listOrphaned: async () => ({ items: [artifact()], nextCursor: null }),
        claimOrphaned: async () => ({ artifactPublicId: "artifact-1", descriptor: descriptor() }),
        completeOrphanDeletion: async () => { throw new Error("database unavailable"); },
        abandonOrphanDeletion: abandon
      }),
      store: { deleteIfUnowned: async () => undefined }
    });
    await expect(failingCommit.reconcilePage({
      knowledgeBaseId: "kb-1", cursor: null, limit: 1
    })).rejects.toThrow("database unavailable");
    expect(abandon).not.toHaveBeenCalled();
  });

  it("honors cancellation before claims and rejects unbounded pages", async () => {
    const claim = vi.fn(async () => null);
    const service = createEmbeddingArtifactCleanupService({
      repository: cleanupRepository({ claimOrphaned: claim }),
      store: { deleteIfUnowned: async () => undefined }
    });
    const controller = new AbortController();
    controller.abort(new DOMException("superseded", "AbortError"));
    await expect(service.reconcilePage({
      knowledgeBaseId: "kb-1", cursor: null, limit: 1, signal: controller.signal
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(claim).not.toHaveBeenCalled();
    await expect(service.reconcilePage({
      knowledgeBaseId: "kb-1", cursor: null, limit: 1_001
    })).rejects.toThrow("limit");
  });
});

function cleanupRepository(
  overrides: Partial<Pick<
    EmbeddingArtifactRepositoryPort,
    | "releaseReferences" | "listOrphaned" | "claimOrphaned"
    | "completeOrphanDeletion" | "abandonOrphanDeletion"
  >> = {}
) {
  return {
    releaseReferences: async () => 0,
    listOrphaned: async () => ({ items: [], nextCursor: null }),
    claimOrphaned: async () => null,
    completeOrphanDeletion: async () => false,
    abandonOrphanDeletion: async () => undefined,
    ...overrides
  };
}

function descriptor(): EmbeddingArtifactDescriptor {
  return {
    objectId: "semantic-object-1",
    storageKey: "focowiki/semantic/object-1.bin",
    checksumSha256: "a".repeat(64),
    byteCount: 28,
    contentType: "application/octet-stream",
    objectFormat: "semantic-vector-v1"
  };
}

function artifact(): EmbeddingArtifactRecord {
  return {
    publicId: "artifact-1",
    knowledgeBaseId: "kb-1",
    ownerKind: "content",
    ownerPublicId: "owner-1",
    sourceRevisionPublicId: "revision-1",
    canonicalInputSha256: "b".repeat(64),
    embeddingConfigurationRevisionPublicId: "embedding-revision-1",
    normalization: "l2",
    dimension: 3,
    inputKind: "content",
    artifactSchemaVersion: "focowiki-vector-artifact-v1",
    objectId: descriptor().objectId,
    storageKey: descriptor().storageKey,
    vectorChecksumSha256: descriptor().checksumSha256,
    byteCount: descriptor().byteCount,
    state: "orphaned"
  };
}
