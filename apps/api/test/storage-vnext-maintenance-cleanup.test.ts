import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type CleanupFactory = (input: Record<string, unknown>) => {
  terminate(input: Record<string, unknown>): Promise<unknown>;
};
type SearchCleanupFactory = (input: Record<string, unknown>) => {
  cleanupMaintenance(input: Record<string, unknown>): Promise<Record<string, unknown>>;
};

let createCleanup: CleanupFactory | undefined;
let createSearchCleanup: SearchCleanupFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance/cleanup.ts"
  );
  const searchModulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/maintenance/search-cleanup-adapter.ts"
  );
  const [loaded, searchLoaded] = await Promise.all([
    import(/* @vite-ignore */ pathToFileURL(modulePath).href).catch(() => ({})),
    import(/* @vite-ignore */ pathToFileURL(searchModulePath).href).catch(() => ({}))
  ]) as [Record<string, unknown>, Record<string, unknown>];
  createCleanup = loaded.createStorageVnextMaintenanceCleanup as
    CleanupFactory | undefined;
  createSearchCleanup = searchLoaded.createStorageVnextMaintenanceSearchCleanupAdapter as
    SearchCleanupFactory | undefined;
});

describe("storage vNext maintenance cleanup", () => {
  it("keeps the promoted unified active index and removes every superseded residue", async () => {
    expect(createCleanup).toBeTypeOf("function");
    if (!createCleanup) return;
    const fixture = cleanupFixture(residue({ activeUnifiedIndexCount: 1 }));
    const cleanup = createCleanup(fixture.dependencies);

    await expect(cleanup.terminate(termination("completed"))).resolves.toMatchObject({
      candidatePublicId: expect.stringMatching(/^maintenance-candidate-[0-9a-f]{64}$/u),
      outcome: "completed"
    });
    expect(fixture.order).toEqual([
      "process", "search", "objects", "files", "inspect"
    ]);
    expect(fixture.search).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "completed",
      promotedCandidatePublicId: expect.stringMatching(
        /^maintenance-candidate-[0-9a-f]{64}$/u
      ),
      failedCandidatePublicId: null
    }));
    expect(fixture.release).not.toHaveBeenCalled();
  });

  it.each(["failed", "superseded"] as const)(
    "terminates the one unified candidate for %s maintenance",
    async (outcome) => {
      expect(createCleanup).toBeTypeOf("function");
      if (!createCleanup) return;
      const fixture = cleanupFixture(residue());
      const cleanup = createCleanup(fixture.dependencies);

      await cleanup.terminate(termination(outcome));
      expect(fixture.order).toEqual([
        "process", "release", "search", "objects", "files", "inspect"
      ]);
      expect(fixture.search).toHaveBeenCalledWith(expect.objectContaining({
        outcome,
        promotedCandidatePublicId: null,
        failedCandidatePublicId: expect.stringMatching(
          /^maintenance-candidate-[0-9a-f]{64}$/u
        )
      }));
      expect(fixture.release).toHaveBeenCalledWith(expect.objectContaining({
        outcome,
        candidatePublicId: expect.stringMatching(
          /^maintenance-candidate-[0-9a-f]{64}$/u
        )
      }));
    }
  );

  it("rejects candidate, task, temporary, split-index, or physical residue", async () => {
    expect(createCleanup).toBeTypeOf("function");
    if (!createCleanup) return;
    const fixture = cleanupFixture(residue({
      candidateRootCount: 1,
      providerTaskCount: 1,
      temporaryFileCount: 1,
      splitIndexCount: 1,
      excessPhysicalBytes: 1
    }));
    const cleanup = createCleanup(fixture.dependencies);

    await expect(cleanup.terminate(termination("completed")))
      .rejects.toMatchObject({ code: "maintenance_residue" });
  });

  it("bounds orphan-index, finished-task, and physical-allocation cleanup pages", async () => {
    expect(createSearchCleanup).toBeTypeOf("function");
    if (!createSearchCleanup) return;
    const orphanPages = [
      { deleted: 1, nextOffset: 0 },
      { deleted: 0, nextOffset: null }
    ];
    const taskPages = [
      { deleted: 2, next: 5 },
      { deleted: 0, next: null }
    ];
    const compactHighWater = vi.fn(async () => ({ outcome: "compacted" }));
    const adapter = createSearchCleanup({
      cleanup: {
        cleanupOrphanIndexes: vi.fn(async () => orphanPages.shift()),
        cleanupFinishedTasks: vi.fn(async () => taskPages.shift()),
        compactHighWater
      },
      now: () => "2026-08-01T12:00:00.000Z",
      availableDiskBytes: vi.fn(async () => 1_000_000),
      maximumPages: 10
    });

    await expect(adapter.cleanupMaintenance({
      ...termination("completed"),
      candidatePublicId: "maintenance-candidate-" + "a".repeat(64),
      promotedCandidatePublicId: "maintenance-candidate-" + "a".repeat(64),
      failedCandidatePublicId: null
    })).resolves.toEqual({
      deletedIndexes: 1,
      deletedTasks: 2,
      compaction: { outcome: "compacted" }
    });
    expect(compactHighWater).toHaveBeenCalledOnce();
  });
});

function cleanupFixture(observed: ReturnType<typeof residue>) {
  const order: string[] = [];
  const process = vi.fn(async () => { order.push("process"); });
  const search = vi.fn(async () => { order.push("search"); });
  const release = vi.fn(async () => { order.push("release"); });
  const objects = vi.fn(async () => { order.push("objects"); });
  const files = vi.fn(async () => { order.push("files"); });
  const inspect = vi.fn(async () => {
    order.push("inspect");
    return observed;
  });
  return {
    order,
    search,
    release,
    dependencies: {
      processResources: { closeAll: process, assertIdle: vi.fn() },
      search: { cleanupMaintenance: search },
      release: { terminateMaintenanceCandidate: release },
      objects: { releaseMaintenanceTemporaryOwners: objects },
      temporaryFiles: { removeMaintenanceFiles: files },
      residue: { inspect }
    }
  };
}

function termination(outcome: "completed" | "failed" | "superseded") {
  return {
    knowledgeBaseId: "kb-maintenance-cleanup",
    operationPublicId: "operation-maintenance-cleanup",
    outcome
  };
}

function residue(overrides: Partial<{
  activeUnifiedIndexCount: number;
  candidateIndexCount: number;
  splitIndexCount: number;
  candidateRootCount: number;
  candidateShardCount: number;
  subtaskCount: number;
  providerTaskCount: number;
  temporaryOwnerCount: number;
  temporaryFileCount: number;
  excessPhysicalBytes: number;
}> = {}) {
  return {
    activeUnifiedIndexCount: 0,
    candidateIndexCount: 0,
    splitIndexCount: 0,
    candidateRootCount: 0,
    candidateShardCount: 0,
    subtaskCount: 0,
    providerTaskCount: 0,
    temporaryOwnerCount: 0,
    temporaryFileCount: 0,
    excessPhysicalBytes: 0,
    ...overrides
  };
}
