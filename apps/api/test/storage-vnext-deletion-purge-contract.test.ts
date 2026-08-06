import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type TargetKind = "source_file" | "source_directory" | "knowledge_base";
type Context = ReturnType<typeof context>;

type PurgeCoordinator = {
  runAttempt(input: Context): Promise<{
    status: "completed" | "blocked" | "retry";
    receipts: Array<{
      target: { resourceKind: string };
      status: "completed" | "blocked" | "retry";
      reasonCode: string | null;
      checkpoint: Record<string, boolean | number | string | null>;
    }>;
  }>;
};

type PurgeFactory = (input: ReturnType<typeof fixture>) => PurgeCoordinator;
let factory: PurgeFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/deletion-purge.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextDeletionPurgeCoordinator?: PurgeFactory;
    };
  factory = loaded.createStorageVnextDeletionPurgeCoordinator;
});

describe("storage vNext deletion physical purge", () => {
  it("purges one source page in owner-safe cross-store order", async () => {
    const current = fixture();
    const coordinator = createCoordinator(current);

    await expect(coordinator.runAttempt(context())).resolves.toMatchObject({
      status: "completed"
    });

    expect(current.calls).toEqual([
      "process",
      "coordination",
      "read-page",
      "search-source",
      "graph-source",
      "release-source",
      "owners-source",
      "object:object-source-a",
      "catalog-source",
      "claim"
    ]);
    expect(current.search.deleteSourceScope).toHaveBeenCalledWith(
      expect.objectContaining({
        knowledgeBaseId: "kb-purge",
        activeProviderIndexUid: "unified-kb-purge-active",
        candidateProviderIndexUid: "unified-kb-purge-candidate",
        sourceFilePublicIds: ["source-a"]
      })
    );
    expect(current.postgres.releaseSourceOwners).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceFilePublicIds: ["source-a"],
        objectIds: ["object-source-a"]
      })
    );
  });

  it("purges a knowledge base directly without a per-file deletion loop", async () => {
    const current = fixture({ knowledgeBase: true });
    const coordinator = createCoordinator(current);

    await expect(coordinator.runAttempt(context({
      targetKind: "knowledge_base",
      targetPublicId: "kb-purge"
    }))).resolves.toMatchObject({ status: "completed" });

    expect(current.search.deleteKnowledgeBaseScope).toHaveBeenCalledOnce();
    expect(current.search.deleteSourceScope).not.toHaveBeenCalled();
    expect(current.postgres.purgeKnowledgeBaseGraph).toHaveBeenCalledOnce();
    expect(current.postgres.purgeKnowledgeBaseRelease).toHaveBeenCalledOnce();
    expect(current.postgres.purgeKnowledgeBaseCatalog).toHaveBeenCalledOnce();
    expect(current.postgres.purgeSourceGraph).not.toHaveBeenCalled();
    expect(current.postgres.purgeSourceCatalog).not.toHaveBeenCalled();
  });

  it("keeps knowledge-base release references discoverable until the final object page", async () => {
    const current = fixture({ knowledgeBase: true, paged: true });
    const coordinator = createCoordinator(current);

    const first = await coordinator.runAttempt(context({
      targetKind: "knowledge_base",
      targetPublicId: "kb-purge"
    }));

    expect(first).toMatchObject({ status: "retry" });
    expect(current.postgres.purgeKnowledgeBaseRelease).not.toHaveBeenCalled();
    expect(current.objects.deleteZeroOwner).toHaveBeenCalledWith("object-kb-a");

    const second = await coordinator.runAttempt(context({
      targetKind: "knowledge_base",
      targetPublicId: "kb-purge",
      cursor: "object-kb-a"
    }));

    expect(second).toMatchObject({ status: "completed" });
    expect(current.objects.deleteZeroOwner).toHaveBeenCalledWith("object-kb-b");
    expect(current.postgres.purgeKnowledgeBaseRelease).toHaveBeenCalledOnce();
    expect(current.postgres.purgeKnowledgeBaseCatalog).toHaveBeenCalledOnce();
  });

  it("returns a bounded task-history checkpoint before continuing knowledge-base purge", async () => {
    const current = fixture({ knowledgeBase: true });
    current.search.deleteKnowledgeBaseScope.mockResolvedValueOnce({
      deletedIndexes: 0,
      deletedTasks: 2,
      nextTaskFrom: 70
    });
    const coordinator = createCoordinator(current);

    const result = await coordinator.runAttempt(context({
      targetKind: "knowledge_base",
      targetPublicId: "kb-purge"
    }));

    expect(result).toMatchObject({ status: "retry" });
    expect(result.receipts.at(-1)).toMatchObject({
      status: "retry",
      reasonCode: "DELETION_SEARCH_TASK_PAGE_REMAINING",
      checkpoint: { taskFrom: 70 }
    });
    expect(current.postgres.purgeKnowledgeBaseGraph).not.toHaveBeenCalled();
  });

  it("returns a bounded page checkpoint and resumes the same operation", async () => {
    const current = fixture({ paged: true });
    const coordinator = createCoordinator(current);
    const first = await coordinator.runAttempt(context());

    expect(first).toMatchObject({ status: "retry" });
    expect(first.receipts.at(-1)).toMatchObject({
      status: "retry",
      reasonCode: "DELETION_SCOPE_PAGE_REMAINING",
      checkpoint: { cursor: "source-a" }
    });

    const second = await coordinator.runAttempt(context({ cursor: "source-a" }));
    expect(second).toMatchObject({ status: "completed" });
    expect(current.postgres.verifyDeletionClosure).toHaveBeenCalledOnce();
    expect(current.search.deleteSourceScope).toHaveBeenCalledTimes(2);
  });

  it("keeps provider failures retryable with an operator-safe reason", async () => {
    const current = fixture();
    current.objects.deleteZeroOwner.mockRejectedValueOnce(
      Object.assign(new Error("provider secret detail"), { code: "provider_delete_failed" })
    );
    const coordinator = createCoordinator(current);

    const result = await coordinator.runAttempt(context());

    expect(result).toMatchObject({ status: "retry" });
    expect(result.receipts.at(-1)).toMatchObject({
      status: "retry",
      reasonCode: "OBJECT_PROVIDER_DELETE_FAILED"
    });
    expect(JSON.stringify(result)).not.toContain("provider secret detail");
    expect(current.postgres.purgeSourceCatalog).not.toHaveBeenCalled();
  });

  it("waits for the unchanged release pipeline before touching active generated files", async () => {
    const current = fixture();
    current.postgres.purgeSourceRelease.mockRejectedValueOnce(
      Object.assign(new Error("active manifest internal detail"), {
        code: "release_pending"
      })
    );
    const coordinator = createCoordinator(current);

    const result = await coordinator.runAttempt(context());

    expect(result).toMatchObject({ status: "retry" });
    expect(result.receipts.at(-1)).toMatchObject({
      status: "retry",
      reasonCode: "DELETION_RELEASE_PENDING"
    });
    expect(JSON.stringify(result)).not.toContain("active manifest internal detail");
    expect(current.postgres.releaseSourceOwners).not.toHaveBeenCalled();
    expect(current.objects.deleteZeroOwner).not.toHaveBeenCalled();
  });

  it("retains shared objects and continues purging later zero-owner objects", async () => {
    const current = fixture();
    current.postgres.readScopePage.mockResolvedValueOnce({
      sourceFilePublicIds: ["source-a"],
      objectIds: ["object-shared", "object-zero-owner"],
      nextCursor: null
    });
    current.objects.deleteZeroOwner
      .mockRejectedValueOnce(Object.assign(new Error("shared"), { code: "owners_present" }))
      .mockResolvedValueOnce({
        deletedVersions: 1,
        deletedMarkers: 0,
        abortedMultipartUploads: 0
      });
    const coordinator = createCoordinator(current);

    await expect(coordinator.runAttempt(context())).resolves.toMatchObject({
      status: "completed"
    });
    expect(current.objects.deleteZeroOwner).toHaveBeenNthCalledWith(1, "object-shared");
    expect(current.objects.deleteZeroOwner).toHaveBeenNthCalledWith(
      2,
      "object-zero-owner"
    );
  });
});

function createCoordinator(current: ReturnType<typeof fixture>): PurgeCoordinator {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Deletion purge coordinator is unavailable");
  return factory(current);
}

function fixture(options: { knowledgeBase?: boolean; paged?: boolean } = {}) {
  const calls: string[] = [];
  let page = 0;
  const readScopePage = vi.fn(async () => {
    calls.push("read-page");
    page += 1;
    if (options.knowledgeBase) {
      return {
        sourceFilePublicIds: [],
        objectIds: [page === 1 ? "object-kb-a" : "object-kb-b"],
        nextCursor: options.paged && page === 1 ? "object-kb-a" : null
      };
    }
    return {
      sourceFilePublicIds: [page === 1 ? "source-a" : "source-b"],
      objectIds: [page === 1 ? "object-source-a" : "object-source-b"],
      nextCursor: options.paged && page === 1 ? "source-a" : null
    };
  });
  const postgres = {
    readScopePage,
    purgeSourceGraph: vi.fn(async () => { calls.push("graph-source"); }),
    purgeKnowledgeBaseGraph: vi.fn(async () => { calls.push("graph-kb"); }),
    purgeSourceRelease: vi.fn(async () => { calls.push("release-source"); }),
    purgeKnowledgeBaseRelease: vi.fn(async () => { calls.push("release-kb"); }),
    releaseSourceOwners: vi.fn(async () => { calls.push("owners-source"); }),
    releaseKnowledgeBaseOwners: vi.fn(async () => { calls.push("owners-kb"); }),
    purgeSourceCatalog: vi.fn(async () => { calls.push("catalog-source"); }),
    purgeKnowledgeBaseCatalog: vi.fn(async () => { calls.push("catalog-kb"); }),
    verifyDeletionClosure: vi.fn(async () => { calls.push("claim"); })
  };
  return {
    processResources: {
      closeAll: vi.fn(async () => { calls.push("process"); })
    },
    coordination: {
      clearKnowledgeBaseRuntimeKeys: vi.fn(async () => { calls.push("coordination"); })
    },
    search: {
      deleteSourceScope: vi.fn(async () => {
        calls.push("search-source");
        return { deletedDocuments: true, deletedIndexes: 1 };
      }),
      deleteKnowledgeBaseScope: vi.fn(async (): Promise<{
        deletedIndexes: number;
        deletedTasks: number;
        nextTaskFrom: number | null;
      }> => {
        calls.push("search-kb");
        return { deletedIndexes: 2, deletedTasks: 2, nextTaskFrom: null };
      })
    },
    postgres,
    objects: {
      deleteZeroOwner: vi.fn(async (objectId: string) => {
        calls.push(`object:${objectId}`);
        return { deletedVersions: 1, deletedMarkers: 1, abortedMultipartUploads: 1 };
      })
    },
    maximumObjectsPerAttempt: 10,
    calls
  };
}

function context(overrides: Partial<{
  targetKind: TargetKind;
  targetPublicId: string;
  cursor: string | null;
}> = {}) {
  return {
    workPublicId: "operation-purge",
    knowledgeBaseId: "kb-purge",
    operationRevision: 1,
    outcome: "deleted" as const,
    resultCode: "DELETION_COMPLETED",
    safeMessage: null,
    checkpoint: {
      targetKind: overrides.targetKind ?? "source_file",
      targetPublicId: overrides.targetPublicId ?? "source-a",
      normalizedPath: "guides",
      activeSearchProviderIndexUid: "unified-kb-purge-active",
      candidateSearchProviderIndexUid: "unified-kb-purge-candidate",
      finishedBefore: "2026-08-01T06:00:00.000Z",
      taskFrom: null,
      cursor: overrides.cursor ?? null
    },
    completedAt: "2026-08-01T06:00:00.000Z"
  };
}
