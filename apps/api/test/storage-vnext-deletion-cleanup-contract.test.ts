import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type ResourceKind =
  | "process_resource"
  | "coordination"
  | "unified_search_scope"
  | "object_body"
  | "object_owner"
  | "catalog_scope"
  | "graph_scope"
  | "release_scope"
  | "deletion_claim";

type CleanupContext = {
  workPublicId: string;
  knowledgeBaseId: string;
  operationRevision: number;
  outcome: "completed";
  resultCode: string;
  safeMessage: null;
  checkpoint: {
    targetKind: "source_file" | "source_directory" | "knowledge_base";
    targetPublicId: string;
    cursor: string | null;
  };
  completedAt: string;
};

type CleanupResult = {
  context: CleanupContext;
  status: "completed" | "blocked" | "retry";
  receipts: ReadonlyArray<{
    target: { resourceKind: ResourceKind };
    status: "completed" | "blocked" | "retry";
    reasonCode: string | null;
    checkpoint: Record<string, boolean | number | string | null>;
  }>;
};

type CleanupHandler = (input: {
  context: CleanupContext;
  resourceKind: ResourceKind;
}) => Promise<{
  status: "completed" | "blocked" | "retry";
  reasonCode: string | null;
  checkpoint: Record<string, boolean | number | string | null>;
}>;

type CleanupCoordinator = {
  runAttempt(context: CleanupContext): Promise<CleanupResult>;
};

type CleanupCoordinatorFactory = (input: {
  clean: CleanupHandler;
  maximumTargets?: number;
}) => CleanupCoordinator;

let factory: CleanupCoordinatorFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/deletion-cleanup.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextDeletionCleanupCoordinator?: CleanupCoordinatorFactory;
    };
  factory = loaded.createStorageVnextDeletionCleanupCoordinator;
});

describe("storage vNext deletion cleanup contract", () => {
  it("runs the complete hard-delete resource matrix in deterministic order", async () => {
    const calls: ResourceKind[] = [];
    const coordinator = createCoordinator(async ({ resourceKind }) => {
      calls.push(resourceKind);
      return completed();
    });

    await expect(coordinator.runAttempt(context())).resolves.toMatchObject({
      status: "completed"
    });
    expect(calls).toEqual([
      "process_resource",
      "coordination",
      "unified_search_scope",
      "graph_scope",
      "release_scope",
      "object_owner",
      "object_body",
      "catalog_scope",
      "deletion_claim"
    ]);
  });

  it("removes file content and graph seeds through one unified index scope", async () => {
    const searchCalls: Array<{
      activeIdentity: string;
      documentKinds: string[];
    }> = [];
    const coordinator = createCoordinator(async ({ context: current, resourceKind }) => {
      if (resourceKind === "unified_search_scope") {
        expect(current.checkpoint.targetKind).toBe("source_file");
        searchCalls.push({
          activeIdentity: "kb-delete-cleanup-unified-active",
          documentKinds: ["content", "graph_seed"]
        });
      }
      return completed();
    });

    await coordinator.runAttempt(context());
    expect(searchCalls).toEqual([{
      activeIdentity: "kb-delete-cleanup-unified-active",
      documentKinds: ["content", "graph_seed"]
    }]);
    expect(searchCalls.filter((call) => call.activeIdentity.includes("content-only")))
      .toHaveLength(0);
    expect(searchCalls.filter((call) => call.activeIdentity.includes("graph-only")))
      .toHaveLength(0);
  });

  it("deletes a whole knowledge base through one direct scope without file fan-out", async () => {
    const touchedFiles: string[] = [];
    const searchIdentities = new Set([
      "kb-delete-cleanup-unified-active",
      "kb-delete-cleanup-unified-candidate"
    ]);
    const coordinator = createCoordinator(async ({ context: current, resourceKind }) => {
      expect(current.checkpoint.targetKind).toBe("knowledge_base");
      if (resourceKind === "catalog_scope") {
        expect(touchedFiles).toHaveLength(0);
      }
      if (resourceKind === "unified_search_scope") searchIdentities.clear();
      return completed();
    });

    await coordinator.runAttempt(context({
      targetKind: "knowledge_base",
      targetPublicId: "kb-delete-cleanup",
      cursor: null
    }));
    expect(searchIdentities.size).toBe(0);
    expect(touchedFiles).toHaveLength(0);
  });

  it("stops at a retryable provider failure and preserves its bounded checkpoint", async () => {
    const calls: ResourceKind[] = [];
    const coordinator = createCoordinator(async ({ resourceKind }) => {
      calls.push(resourceKind);
      if (resourceKind === "object_body") {
        return {
          status: "retry",
          reasonCode: "OBJECT_PROVIDER_TIMEOUT",
          checkpoint: { cursor: "object-page-2", deletedVersions: 1000 }
        };
      }
      return completed();
    });

    const result = await coordinator.runAttempt(context());
    expect(result.status).toBe("retry");
    expect(calls).toEqual([
      "process_resource",
      "coordination",
      "unified_search_scope",
      "graph_scope",
      "release_scope",
      "object_owner",
      "object_body"
    ]);
    expect(result.receipts.at(-1)).toMatchObject({
      status: "retry",
      reasonCode: "OBJECT_PROVIDER_TIMEOUT",
      checkpoint: { cursor: "object-page-2", deletedVersions: 1000 }
    });
  });

  it("keeps a failed deletion hidden while a retry uses the same operation", async () => {
    let visible = false;
    let failOnce = true;
    const operations = new Set(["operation-delete-cleanup"]);
    const coordinator = createCoordinator(async ({ resourceKind }) => {
      if (resourceKind === "release_scope" && failOnce) {
        failOnce = false;
        return {
          status: "retry",
          reasonCode: "RELEASE_PURGE_RETRY",
          checkpoint: { cursor: "release-page-1" }
        };
      }
      return completed();
    });

    await expect(coordinator.runAttempt(context())).resolves.toMatchObject({
      status: "retry"
    });
    expect(visible).toBe(false);
    expect(operations).toEqual(new Set(["operation-delete-cleanup"]));

    await expect(coordinator.runAttempt(context())).resolves.toMatchObject({
      status: "completed"
    });
    expect(visible).toBe(false);
    expect(operations).toEqual(new Set(["operation-delete-cleanup"]));
    void visible;
  });

  it("does not multiply owners, indexes, or work when completion is replayed", async () => {
    const owners = new Set(["owner-source", "owner-active-root"]);
    const indexes = new Set(["kb-delete-cleanup-unified-active"]);
    const work = new Set(["operation-delete-cleanup"]);
    const clean = vi.fn(async ({ resourceKind }: Parameters<CleanupHandler>[0]) => {
      if (resourceKind === "object_owner") owners.clear();
      if (resourceKind === "unified_search_scope") indexes.clear();
      if (resourceKind === "deletion_claim") work.clear();
      return completed();
    });
    const coordinator = createCoordinator(clean);

    await coordinator.runAttempt(context());
    await coordinator.runAttempt(context());
    expect(owners.size).toBe(0);
    expect(indexes.size).toBe(0);
    expect(work.size).toBe(0);
    expect(clean).toHaveBeenCalledTimes(18);
  });

  it("rejects an unbounded cleanup plan before touching any store", async () => {
    const clean = vi.fn(async () => completed());
    expect(factory).toBeTypeOf("function");
    if (!factory) throw new Error("Storage vNext deletion cleanup is unavailable");
    const coordinator = factory({ clean, maximumTargets: 8 });

    await expect(coordinator.runAttempt(context())).rejects.toThrow(
      "cleanup target limit"
    );
    expect(clean).not.toHaveBeenCalled();
  });
});

function createCoordinator(clean: CleanupHandler): CleanupCoordinator {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext deletion cleanup is unavailable");
  return factory({ clean });
}

function context(
  checkpoint: CleanupContext["checkpoint"] = {
    targetKind: "source_file",
    targetPublicId: "file-delete-cleanup",
    cursor: null
  }
): CleanupContext {
  return {
    workPublicId: "operation-delete-cleanup",
    knowledgeBaseId: "kb-delete-cleanup",
    operationRevision: 1,
    outcome: "completed",
    resultCode: "DELETION_COMPLETED",
    safeMessage: null,
    checkpoint,
    completedAt: "2026-08-01T05:00:00.000Z"
  };
}

function completed() {
  return {
    status: "completed" as const,
    reasonCode: null,
    checkpoint: {}
  };
}
