import { describe, expect, it, vi } from "vitest";
import type {
  StorageVnextSourceFileFact,
  StorageVnextSourceRevisionFact
} from "../src/storage-vnext/catalog/ports.js";
import {
  acceptStorageVnextSourceRevision,
  createStorageVnextSourceRevisionPublicId
} from "../src/storage-vnext/catalog/source-revision-service.js";
import { StorageVnextCatalogRepositoryError } from "../src/storage-vnext/catalog/postgres-repository.js";

describe("storage vNext identical source revision deduplication", () => {
  it("reuses one object and one immutable revision for a repeated accepted request", async () => {
    const fixture = createFixture();
    const request = sourceRequest();

    const first = await acceptStorageVnextSourceRevision({ ...fixture.ports, request });
    const second = await acceptStorageVnextSourceRevision({ ...fixture.ports, request });

    expect(first.outcome).toBe("activated");
    expect(second.outcome).toBe("reused");
    expect(second.revision.publicId).toBe(first.revision.publicId);
    expect(fixture.objectWrites).toHaveBeenCalledTimes(2);
    expect(fixture.revisions).toHaveLength(1);
    expect(fixture.currentRevisionIds).toEqual([first.revision.publicId]);
  });

  it("converges concurrent identical retries on the same deterministic revision", async () => {
    const fixture = createFixture();
    const request = sourceRequest();
    const [left, right] = await Promise.all([
      acceptStorageVnextSourceRevision({ ...fixture.ports, request }),
      acceptStorageVnextSourceRevision({ ...fixture.ports, request })
    ]);

    expect(new Set([left.revision.publicId, right.revision.publicId])).toEqual(
      new Set([createStorageVnextSourceRevisionPublicId({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFilePublicId: request.sourceFilePublicId,
        checksum: fixture.checksum
      })])
    );
    expect(fixture.revisions).toHaveLength(1);
    expect(fixture.currentRevisionIds).toHaveLength(1);
    expect([left.outcome, right.outcome].sort()).toEqual(["activated", "reused"]);
  });
});

function createFixture() {
  const bytes = new TextEncoder().encode("# Identical\n");
  const checksum = "a".repeat(64);
  const revisions: StorageVnextSourceRevisionFact[] = [];
  const currentRevisionIds: string[] = [];
  let fileRevision = 1;
  let currentRevision: StorageVnextSourceRevisionFact | null = null;
  const objectWrites = vi.fn(async () => ({
    outcome: revisions.length === 0 ? "stored" as const : "reused" as const,
    objectId: `source-sha256:${checksum}`,
    storageKey: `owned/source/${checksum}.md`,
    checksum,
    byteCount: bytes.byteLength,
    contentType: "text/markdown; charset=utf-8" as const,
    objectFormat: "source-markdown-v1" as const
  }));
  return {
    checksum,
    objectWrites,
    revisions,
    currentRevisionIds,
    ports: {
      objectWriter: { putVerified: objectWrites },
      catalog: {
        async getSourceFile() {
          return sourceFile(fileRevision, currentRevision?.publicId ?? null);
        },
        async getCurrentSourceRevision() {
          return currentRevision;
        },
        async createImmutableRevision(revision: StorageVnextSourceRevisionFact) {
          const existing = revisions.find((item) => item.publicId === revision.publicId);
          if (existing) return existing;
          revisions.push(revision);
          return revision;
        },
        async compareAndSetCurrentRevision(input: {
          revisionPublicId: string;
          revisionCheck: { expectedRevision: number };
        }) {
          await Promise.resolve();
          if (fileRevision !== input.revisionCheck.expectedRevision) {
            throw new StorageVnextCatalogRepositoryError("revision_conflict");
          }
          currentRevision = revisions.find(
            (item) => item.publicId === input.revisionPublicId
          ) ?? null;
          if (!currentRevision) throw new Error("Missing revision fixture");
          currentRevisionIds.splice(0, currentRevisionIds.length, currentRevision.publicId);
          fileRevision += 1;
          return sourceFile(fileRevision, currentRevision.publicId);
        }
      }
    }
  };
}

function sourceRequest() {
  return {
    knowledgeBaseId: "kb-dedup",
    sourceFilePublicId: "file-dedup",
    expectedRevision: 1,
    bytes: new TextEncoder().encode("# Identical\n"),
    contentType: "text/markdown; charset=utf-8",
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

function sourceFile(
  revision: number,
  currentRevisionPublicId: string | null
): StorageVnextSourceFileFact {
  return {
    publicId: "file-dedup",
    knowledgeBaseId: "kb-dedup",
    directoryPublicId: null,
    logicalPath: "Identical.md",
    normalizedPath: "identical.md",
    title: "Identical",
    metadata: {},
    currentRevisionPublicId,
    status: "ready",
    safeErrorCode: null,
    safeErrorMessage: null,
    revision,
    visibility: "current"
  };
}
