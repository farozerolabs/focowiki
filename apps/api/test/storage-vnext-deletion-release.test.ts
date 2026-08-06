import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type PlanInput = {
  knowledgeBaseId: string;
  operationPublicId: string;
  targetKind: "source_file" | "source_directory" | "knowledge_base";
  targetPublicId: string;
  sourceFilePublicIds: readonly string[];
  sourceLogicalPaths: readonly string[];
  directoryLogicalPaths: readonly string[];
  graphSourceFilePublicIds: readonly string[];
  graphEdgePublicIds: readonly string[];
  maximumChangedFacts: number;
  maximumDependencies: number;
};

type Plan = {
  mode: "candidate" | "direct";
  knowledgeBaseId: string;
  operationPublicId: string;
  changedFacts: readonly {
    kind: string;
    publicId: string;
    change: "deleted";
  }[];
  dependencies: readonly {
    kind: string;
    publicId: string;
    reasonCode: string;
  }[];
  affectedSourceFilePublicIds: readonly string[];
  affectedLogicalPaths: readonly string[];
  affectedDirectoryPaths: readonly string[];
};

type Module = {
  planStorageVnextDeletionCandidate?: (input: PlanInput) => Plan;
  createStorageVnextDeletionReleaseHandoff?: (
    releasePort: ReturnType<typeof releaseFixture>
  ) => {
    apply(request: Plan & {
      createdAt: string;
      idempotency: { key: string; requestHash: string };
    }): Promise<{
      outcome: "candidate" | "direct";
      candidatePublicId?: string;
      releaseOperationPublicId: string;
    }>;
  };
};

let loaded: Module = {};

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/deletion-release.ts"
  );
  loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as Module;
});

describe("storage vNext deletion release planning", () => {
  it("plans a file tombstone through the existing generated paths and unified search", () => {
    const plan = planner()(request());

    expect(plan.mode).toBe("candidate");
    expect(plan.changedFacts).toEqual([{
      kind: "source_file",
      publicId: "source-delete",
      change: "deleted"
    }]);
    expect(plan.affectedLogicalPaths).toEqual(["pages/guides/delete.md"]);
    expect(plan.affectedDirectoryPaths).toEqual(["pages", "pages/guides"]);
    expect(plan.dependencies).toEqual(expect.arrayContaining([
      { kind: "path", publicId: "pages/guides/delete.md", reasonCode: "source_path" },
      { kind: "ancestor", publicId: "pages/guides", reasonCode: "directory_ancestor" },
      { kind: "search", publicId: "source-delete", reasonCode: "search_document" },
      { kind: "graph", publicId: "source-delete", reasonCode: "graph_source" },
      { kind: "index", publicId: "index.md", reasonCode: "required_navigation" },
      { kind: "schema", publicId: "schema.md", reasonCode: "required_schema" },
      { kind: "log", publicId: "log.md", reasonCode: "bounded_update_log" }
    ]));
  });

  it("plans one directory candidate without per-file operations or new public paths", () => {
    const plan = planner()(request({
      targetKind: "source_directory",
      targetPublicId: "directory-guides",
      sourceFilePublicIds: ["source-b", "source-a"],
      sourceLogicalPaths: ["Guides/B.md", "Guides/A.md"],
      directoryLogicalPaths: ["Guides"]
    }));

    expect(plan.mode).toBe("candidate");
    expect(plan.changedFacts).toEqual([
      { kind: "directory", publicId: "directory-guides", change: "deleted" },
      { kind: "source_file", publicId: "source-a", change: "deleted" },
      { kind: "source_file", publicId: "source-b", change: "deleted" }
    ]);
    expect(plan.dependencies).toContainEqual({
      kind: "scope",
      publicId: "pages/Guides",
      reasonCode: "directory_delete"
    });
    expect(plan.affectedLogicalPaths).toEqual([
      "pages/Guides/A.md",
      "pages/Guides/B.md"
    ]);
  });

  it("keeps whole-knowledge-base deletion direct", async () => {
    const release = releaseFixture();
    const handoff = handoffFactory()(release);
    const plan = planner()(request({
      targetKind: "knowledge_base",
      targetPublicId: "kb-delete",
      sourceFilePublicIds: [],
      sourceLogicalPaths: [],
      directoryLogicalPaths: [],
      graphSourceFilePublicIds: [],
      graphEdgePublicIds: []
    }));

    expect(plan.mode).toBe("direct");
    await expect(handoff.apply({
      ...plan,
      createdAt: "2026-08-01T00:00:00.000Z",
      idempotency: { key: "delete-direct", requestHash: "a".repeat(64) }
    })).resolves.toEqual({
      outcome: "direct",
      releaseOperationPublicId: "operation-delete"
    });
    expect(release.createCandidate).not.toHaveBeenCalled();
  });

  it("creates one deterministic candidate and reuses it on replay", async () => {
    const release = releaseFixture();
    const handoff = handoffFactory()(release);
    const plan = planner()(request());
    const apply = () => handoff.apply({
      ...plan,
      createdAt: "2026-08-01T00:00:00.000Z",
      idempotency: { key: "delete-file", requestHash: "b".repeat(64) }
    });

    const first = await apply();
    release.getLiveCandidate.mockResolvedValueOnce({
      publicId: first.candidatePublicId!,
      operationPublicId: "operation-delete"
    });
    const replay = await apply();

    expect(first).toEqual(replay);
    expect(release.createCandidate).toHaveBeenCalledOnce();
    expect(release.addCandidateFacts).toHaveBeenCalledOnce();
    expect(release.createCandidate).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-delete",
      operationPublicId: "operation-delete",
      changedFacts: plan.changedFacts,
      dependencies: plan.dependencies
    }));
  });
});

function planner() {
  expect(loaded.planStorageVnextDeletionCandidate).toBeTypeOf("function");
  if (!loaded.planStorageVnextDeletionCandidate) {
    throw new Error("Deletion release planner is unavailable");
  }
  return loaded.planStorageVnextDeletionCandidate;
}

function handoffFactory() {
  expect(loaded.createStorageVnextDeletionReleaseHandoff).toBeTypeOf("function");
  if (!loaded.createStorageVnextDeletionReleaseHandoff) {
    throw new Error("Deletion release handoff is unavailable");
  }
  return loaded.createStorageVnextDeletionReleaseHandoff;
}

function request(overrides: Partial<PlanInput> = {}): PlanInput {
  return {
    knowledgeBaseId: "kb-delete",
    operationPublicId: "operation-delete",
    targetKind: "source_file",
    targetPublicId: "source-delete",
    sourceFilePublicIds: ["source-delete"],
    sourceLogicalPaths: ["guides/delete.md"],
    directoryLogicalPaths: [],
    graphSourceFilePublicIds: ["source-delete"],
    graphEdgePublicIds: [],
    maximumChangedFacts: 100,
    maximumDependencies: 100,
    ...overrides
  };
}

function releaseFixture() {
  const candidate = {
    publicId: "candidate-delete",
    operationPublicId: "operation-delete"
  };
  return {
    getActiveRoot: vi.fn(async () => ({ publicId: "root-active", revision: 4 })),
    getLiveCandidate: vi.fn(async () => null as typeof candidate | null),
    createCandidate: vi.fn(async () => candidate),
    addCandidateFacts: vi.fn(async () => candidate)
  };
}
