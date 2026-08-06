import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type Factory = (input: ReturnType<typeof fixture>) => {
  prepare(request: ReturnType<typeof work>): Promise<
    Record<string, boolean | number | string | null>
  >;
};

let factory: Factory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/production-release.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextDeletionProductionRelease?: Factory;
    };
  factory = loaded.createStorageVnextDeletionProductionRelease;
});

describe("storage vNext deletion production release", () => {
  it("publishes and activates the deletion delta before purge", async () => {
    const current = fixture();
    const release = createRelease(current);

    await expect(release.prepare(work())).resolves.toEqual({
      releaseActivated: true,
      releaseRootPublicId: "root-delete-active",
      searchProjectionPublicId: "candidate-delete"
    });

    expect(current.scope.read).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-delete-production",
      targetKind: "source_file",
      targetPublicId: "source-delete-production",
      normalizedPath: "Guides/Delete.md",
      maximumSources: 100_000,
      maximumGraphEdges: 250_000
    });
    expect(current.releases.createCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-delete-production",
        operationPublicId: "operation-delete-production",
        changedFacts: [{
          kind: "source_file",
          publicId: "source-delete-production",
          change: "deleted"
        }],
        dependencies: expect.arrayContaining([
          { kind: "path", publicId: "pages/Guides/Delete.md", reasonCode: "source_path" },
          { kind: "search", publicId: "source-delete-production", reasonCode: "search_document" }
        ])
      })
    );
    expect(current.processor.publish).toHaveBeenCalledBefore(
      current.releases.activateCandidate
    );
  });

  it("recognizes an already activated release after a restart", async () => {
    const current = fixture();
    current.scope.findActivated.mockResolvedValueOnce({
      releaseRootPublicId: "root-delete-recovered",
      searchProjectionPublicId: "candidate-delete"
    });

    await expect(createRelease(current).prepare(work())).resolves.toEqual({
      releaseActivated: true,
      releaseRootPublicId: "root-delete-recovered",
      searchProjectionPublicId: "candidate-delete"
    });
    expect(current.scope.read).not.toHaveBeenCalled();
    expect(current.processor.publish).not.toHaveBeenCalled();
  });

  it("keeps whole-knowledge-base deletion on the direct purge path", async () => {
    const current = fixture();
    const knowledgeBaseWork = work({
      checkpoint: {
        targetKind: "knowledge_base",
        targetPublicId: "kb-delete-production",
        normalizedPath: null
      }
    });

    await expect(createRelease(current).prepare(knowledgeBaseWork)).resolves.toEqual({
      releaseActivated: true
    });
    expect(current.scope.read).not.toHaveBeenCalled();
    expect(current.processor.publish).not.toHaveBeenCalled();
  });

  it("terminates an owned candidate when deletion publication fails", async () => {
    const current = fixture();
    current.processor.publish.mockRejectedValueOnce(
      Object.assign(new Error("candidate publication failed"), {
        code: "publication_failed"
      })
    );

    await expect(createRelease(current).prepare(work())).rejects.toMatchObject({
      code: "publication_failed"
    });
    expect(current.releases.terminateCandidate).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-delete-production",
        candidatePublicId: "candidate-delete",
        outcome: "failed",
        reasonCode: "DELETION_RELEASE_FAILED",
        safeMessage: null
      })
    );
  });
});

function createRelease(current: ReturnType<typeof fixture>) {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Deletion production release is unavailable");
  return factory(current);
}

function fixture() {
  const candidate = {
    publicId: "candidate-delete",
    knowledgeBaseId: "kb-delete-production",
    operationPublicId: "operation-delete-production",
    candidateRootPublicId: "root-delete-candidate",
    expectedActiveRootPublicId: "root-delete-before",
    expectedActiveRevision: 4,
    state: "building" as const,
    changedFactCount: 1,
    affectedDependencyCount: 7,
    manifestChecksum: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z"
  };
  let liveCandidate: typeof candidate | null = null;
  return {
    scope: {
      findActivated: vi.fn(async () => null as null | {
        releaseRootPublicId: string;
        searchProjectionPublicId: string;
      }),
      read: vi.fn(async () => ({
        sourceFilePublicIds: ["source-delete-production"],
        sourceLogicalPaths: ["Guides/Delete.md"],
        directoryLogicalPaths: [],
        graphSourceFilePublicIds: ["source-delete-production"],
        graphEdgePublicIds: []
      }))
    },
    releases: {
      getActiveRoot: vi.fn(async () => ({
        publicId: "root-delete-before",
        revision: 4
      })),
      getLiveCandidate: vi.fn(async () => liveCandidate),
      createCandidate: vi.fn(async () => {
        liveCandidate = candidate;
        return candidate;
      }),
      addCandidateFacts: vi.fn(async () => candidate),
      activateCandidate: vi.fn(async () => ({
        outcome: "activated" as const,
        snapshot: {
          releaseRootPublicId: "root-delete-active"
        },
        rollbackRootPublicId: "root-delete-before"
      })),
      terminateCandidate: vi.fn(async () => true)
    },
    processor: {
      publish: vi.fn(async () => ({
        searchProjectionPublicId: "candidate-delete"
      }))
    },
    clock: () => "2026-08-01T01:00:00.000Z",
    rollbackRetentionMilliseconds: 86_400_000,
    resultRetentionMilliseconds: 86_400_000,
    maximumChangedFacts: 100_000,
    maximumDependencies: 250_000
  };
}

function work(overrides: Record<string, unknown> = {}) {
  return {
    publicId: "operation-delete-production",
    knowledgeBaseId: "kb-delete-production",
    kind: "deletion" as const,
    state: "running" as const,
    operationRevision: 1,
    settingsRevisionPublicId: "settings-delete-production",
    attempt: 1,
    leaseOwner: "deletion-worker-production",
    leaseExpiresAt: "2026-08-01T01:05:00.000Z",
    nextAttemptAt: null,
    safeErrorCode: null,
    checkpoint: {
      targetKind: "source_file",
      targetPublicId: "source-delete-production",
      normalizedPath: "Guides/Delete.md"
    },
    idempotency: {
      key: "delete-production-key",
      requestHash: "a".repeat(64),
      expiresAt: "2026-08-02T00:00:00.000Z"
    },
    ...overrides
  };
}
