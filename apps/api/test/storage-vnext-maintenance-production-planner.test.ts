import { describe, expect, it, vi } from "vitest";
import {
  createStorageVnextMaintenanceProductionPlanner
} from "../src/storage-vnext/maintenance/production-planner.js";

describe("storage vNext maintenance production planner", () => {
  it("plans one idempotent candidate from paged current source and directory facts", async () => {
    const dependencies: Array<{ kind: string; publicId: string }> = [];
    const candidate = {
      publicId: "maintenance-candidate-fixed",
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      candidateRootPublicId: "maintenance-root-fixed",
      expectedActiveRootPublicId: "root-active",
      expectedActiveRevision: 7,
      state: "building" as const,
      changedFactCount: 1,
      affectedDependencyCount: 0,
      manifestChecksum: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z"
    };
    const addCandidateFacts = vi.fn(async (input: {
      dependencies: readonly { kind: string; publicId: string }[];
    }) => {
      expect(input.dependencies.length).toBeLessThanOrEqual(2);
      dependencies.push(...input.dependencies);
      return candidate;
    });
    const createCandidate = vi.fn(async (input: {
      dependencies: readonly { kind: string; publicId: string }[];
    }) => {
      dependencies.push(...input.dependencies);
      return candidate;
    });
    let sourcePage = 0;
    const planner = createStorageVnextMaintenanceProductionPlanner({
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-maintenance",
          name: "Maintenance",
          description: null,
          revision: 11,
          visibility: "current" as const,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z"
        })),
        listCurrentSources: vi.fn(async () => sourcePage++ === 0
          ? {
              items: [currentSource("source-a", "guides/a.md")],
              nextCursor: "source-next"
            }
          : {
              items: [currentSource("source-b", "reference/b.md")],
              nextCursor: null
            }),
        listDirectories: vi.fn(async () => ({
          items: [{
            publicId: "directory-empty",
            knowledgeBaseId: "kb-maintenance",
            parentPublicId: null,
            logicalPath: "empty",
            normalizedPath: "empty",
            title: "Empty",
            revision: 1,
            visibility: "current" as const
          }],
          nextCursor: null
        }))
      },
      releases: {
        getActiveRoot: vi.fn(async () => ({
          publicId: "root-active",
          knowledgeBaseId: "kb-maintenance",
          role: "active" as const,
          manifestChecksum: "a".repeat(64),
          navigationProfileVersion: 1,
          revision: 7,
          createdAt: "2026-08-01T00:00:00.000Z",
          expiresAt: null
        })),
        getLiveCandidate: vi.fn(async () => null),
        createCandidate,
        addCandidateFacts
      },
      operationIdentity: {
        read: vi.fn(async () => ({
          idempotencyKey: "maintenance-key",
          requestHash: "b".repeat(64)
        }))
      },
      sourcePageSize: 1,
      directoryPageSize: 1,
      writeBatchSize: 2
    });

    const result = await planner.plan({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      expectedResourceRevision: 11,
      createdAt: "2026-08-02T00:00:00.000Z"
    });

    expect(result).toMatchObject({
      candidatePublicId: expect.stringMatching(/^maintenance-candidate-/u),
      sourceCount: 2,
      directoryCount: 1
    });
    expect(createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      expectedActiveRootPublicId: "root-active",
      expectedActiveRevision: 7,
      idempotency: {
        key: "maintenance-key",
        requestHash: "b".repeat(64)
      }
    }));
    expect(new Set(dependencies.map((item) => `${item.kind}:${item.publicId}`)))
      .toEqual(expect.objectContaining(new Set([
        "path:pages/guides/a.md",
        "path:pages/reference/b.md",
        "ancestor:pages/empty",
        "search:source-a",
        "search:source-b",
        "graph:source-a",
        "graph:source-b",
        "index:index.md",
        "index:pages/index.md"
      ])));
  });

  it("rejects a plan when the knowledge-base revision changed", async () => {
    const planner = createStorageVnextMaintenanceProductionPlanner({
      catalog: {
        getKnowledgeBase: vi.fn(async () => ({
          publicId: "kb-maintenance",
          name: "Maintenance",
          description: null,
          revision: 12,
          visibility: "current" as const,
          createdAt: "2026-08-01T00:00:00.000Z",
          updatedAt: "2026-08-02T00:00:00.000Z"
        })),
        listCurrentSources: vi.fn(),
        listDirectories: vi.fn()
      },
      releases: {
        getActiveRoot: vi.fn(),
        getLiveCandidate: vi.fn(),
        createCandidate: vi.fn(),
        addCandidateFacts: vi.fn()
      },
      operationIdentity: { read: vi.fn() },
      sourcePageSize: 1,
      directoryPageSize: 1,
      writeBatchSize: 1
    });

    await expect(planner.plan({
      knowledgeBaseId: "kb-maintenance",
      operationPublicId: "operation-maintenance",
      expectedResourceRevision: 11,
      createdAt: "2026-08-02T00:00:00.000Z"
    })).rejects.toMatchObject({ code: "stale_plan" });
  });
});

function currentSource(publicId: string, logicalPath: string) {
  return {
    sourceFile: {
      publicId,
      knowledgeBaseId: "kb-maintenance",
      directoryPublicId: null,
      logicalPath,
      normalizedPath: logicalPath,
      title: publicId,
      metadata: {},
      currentRevisionPublicId: `revision-${publicId}`,
      status: "ready" as const,
      safeErrorCode: null,
      safeErrorMessage: null,
      revision: 1,
      visibility: "current" as const
    },
    sourceRevision: {
      publicId: `revision-${publicId}`,
      sourceFilePublicId: publicId,
      knowledgeBaseId: "kb-maintenance",
      objectId: `source-${publicId}`,
      checksum: "c".repeat(64),
      byteCount: 12,
      contentType: "text/markdown; charset=utf-8",
      createdAt: "2026-08-01T00:00:00.000Z"
    }
  };
}
