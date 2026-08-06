import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

type DeletionKind = "source_file" | "source_directory" | "knowledge_base";
type ExistingWorkState =
  | "accepted"
  | "processing"
  | "publishing"
  | "retrying"
  | "maintenance"
  | "failed"
  | "completed";

type DeletionRequest = {
  kind: DeletionKind;
  knowledgeBaseId: string;
  operationPublicId: string;
  targetPublicId: string;
  expectedResourceRevision: number;
  idempotencyKey: string;
  settingsRevisionPublicId: string;
  requestedAt: string;
  expiresAt: string;
};

type SourceTaskDeletionInput = {
  knowledgeBaseId: string;
  sourceFilePublicIds: readonly string[];
  deletedAt: string;
  settingsRevisionPublicId: string;
  resultExpiresAt: string;
};

type DeletionAcceptance = {
  outcome: "queued" | "replayed";
  operationPublicId: string;
  state: "queued";
  visibilityCommitted: true;
};

type SourceTaskDeletionResult = {
  sourceFilePublicId: string;
  outcome: "deleted" | "hidden" | "skipped";
  reason?: "missing" | "wrong_knowledge_base" | "already_removed" | "running" | "job_already_claimed";
  generatedFilePublicId?: string;
  generatedFilePath?: string;
};

type DeletionCoordinator = {
  acceptDeletion(request: DeletionRequest): Promise<DeletionAcceptance>;
  deleteSourceTasks(input: SourceTaskDeletionInput): Promise<readonly SourceTaskDeletionResult[]>;
};

type DeletionCoordinatorFactory = (input: {
  repository: ReturnType<typeof createFixture>["repository"];
  visibilityCache: ReturnType<typeof createFixture>["visibilityCache"];
}) => DeletionCoordinator;

let factory: DeletionCoordinatorFactory | undefined;

beforeAll(async () => {
  const modulePath = resolve(
    import.meta.dirname,
    "../src/storage-vnext/deletion/deletion-coordinator.ts"
  );
  const loaded = await import(/* @vite-ignore */ pathToFileURL(modulePath).href)
    .catch(() => ({})) as {
      createStorageVnextDeletionCoordinator?: DeletionCoordinatorFactory;
    };
  factory = loaded.createStorageVnextDeletionCoordinator;
});

describe("storage vNext deletion lifecycle contract", () => {
  it("soft-deletes the current file revision before asynchronous cleanup", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptDeletion(deletionRequest())).resolves.toEqual({
      outcome: "queued",
      operationPublicId: "operation-delete-contract",
      state: "queued",
      visibilityCommitted: true
    });
    expect(fixture.visibleSourceFiles.has("file-delete-contract")).toBe(false);
    expect(fixture.repository.acceptDeletion).toHaveBeenCalledWith(
      expect.objectContaining({
        targetKind: "source_file",
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/u)
      })
    );
  });

  it("invalidates current-read caches only after deletion visibility commits", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await coordinator.acceptDeletion(deletionRequest());

    expect(fixture.visibilityCache.invalidateKnowledgeBase).toHaveBeenCalledOnce();
    expect(fixture.visibilityCache.invalidateKnowledgeBase).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-delete-contract"
    });
  });

  it("rejects a stale revision before visibility or work changes", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptDeletion(deletionRequest({
      expectedResourceRevision: 6
    }))).rejects.toMatchObject({ code: "revision_conflict" });
    expect(fixture.visibleSourceFiles.has("file-delete-contract")).toBe(true);
    expect(fixture.deletionOperations).toHaveLength(0);
  });

  it("replays an identical deletion and rejects an idempotency-key collision", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.acceptDeletion(deletionRequest())).resolves.toMatchObject({
      outcome: "queued"
    });
    await expect(coordinator.acceptDeletion(deletionRequest())).resolves.toMatchObject({
      outcome: "replayed",
      operationPublicId: "operation-delete-contract"
    });
    await expect(coordinator.acceptDeletion(deletionRequest({
      targetPublicId: "file-delete-sibling"
    }))).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(fixture.deletionOperations).toHaveLength(1);
  });

  it("owns one bounded directory deletion without per-file operations", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await coordinator.acceptDeletion(deletionRequest({
      kind: "source_directory",
      targetPublicId: "directory-delete-contract",
      expectedResourceRevision: 4
    }));

    expect(fixture.visibleDirectories.has("directory-delete-contract")).toBe(false);
    expect(fixture.visibleSourceFiles.has("file-delete-contract")).toBe(false);
    expect(fixture.visibleSourceFiles.has("file-delete-descendant")).toBe(false);
    expect(fixture.deletionOperations).toHaveLength(1);
    expect(fixture.perFileDeletionOperations).toBe(0);
  });

  it.each([
    "accepted",
    "processing",
    "publishing",
    "retrying",
    "maintenance",
    "failed",
    "completed"
  ] as const)(
    "knowledge-base deletion converges safely with existing %s work",
    async (existingState) => {
      const fixture = createFixture(existingState);
      const coordinator = createCoordinator(fixture);

      await coordinator.acceptDeletion(deletionRequest({
        kind: "knowledge_base",
        targetPublicId: "kb-delete-contract",
        expectedResourceRevision: 9
      }));

      expect(fixture.knowledgeBaseVisible).toBe(false);
      expect(fixture.deletionOperations).toHaveLength(1);
      expect(fixture.perFileDeletionOperations).toBe(0);
      expect(fixture.liveUnifiedCandidateCount).toBe(0);
      expect(fixture.splitSearchIndexCount).toBe(0);
      expect(fixture.existingWork.state).toBe(
        existingState === "failed" || existingState === "completed"
          ? existingState
          : "superseded"
      );
    }
  );

  it("keeps published knowledge visible when only its source task is deleted", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.deleteSourceTasks(sourceTaskDeletionInput([
      "file-published-contract"
    ]))).resolves.toEqual([{
      sourceFilePublicId: "file-published-contract",
      outcome: "hidden",
      generatedFilePublicId: "generated-published-contract",
      generatedFilePath: "pages/Published.md"
    }]);
    expect(fixture.visibleSourceFiles.has("file-published-contract")).toBe(true);
    expect(fixture.taskVisible.get("file-published-contract")).toBe(false);
    expect(fixture.deletionOperations).toHaveLength(0);
    expect(fixture.visibilityCache.invalidateKnowledgeBase).toHaveBeenCalledOnce();
  });

  it("routes an unpublished source task through the file deletion lifecycle", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.deleteSourceTasks(sourceTaskDeletionInput([
      "file-unpublished-contract"
    ]))).resolves.toEqual([{
      sourceFilePublicId: "file-unpublished-contract",
      outcome: "deleted"
    }]);
    expect(fixture.visibleSourceFiles.has("file-unpublished-contract")).toBe(false);
    expect(fixture.deletionOperations).toHaveLength(1);
  });

  it.each([
    ["file-running-contract", "running"],
    ["file-claimed-contract", "job_already_claimed"]
  ] as const)("preserves the existing skipped result for %s", async (
    sourceFilePublicId,
    reason
  ) => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.deleteSourceTasks(sourceTaskDeletionInput([
      sourceFilePublicId
    ]))).resolves.toEqual([{
      sourceFilePublicId,
      outcome: "skipped",
      reason
    }]);
    expect(fixture.visibleSourceFiles.has(sourceFilePublicId)).toBe(true);
    expect(fixture.deletionOperations).toHaveLength(0);
  });

  it("bounds and deduplicates a source-task deletion batch", async () => {
    const fixture = createFixture();
    const coordinator = createCoordinator(fixture);

    await expect(coordinator.deleteSourceTasks(sourceTaskDeletionInput([
      "file-published-contract",
      "file-published-contract"
    ]))).resolves.toHaveLength(1);
    await expect(coordinator.deleteSourceTasks(sourceTaskDeletionInput(
      Array.from({ length: 1_001 }, (_, index) => `file-${index}`)
    ))).rejects.toMatchObject({ code: "invalid_input" });
  });
});

function createCoordinator(
  fixture: ReturnType<typeof createFixture>
): DeletionCoordinator {
  expect(factory).toBeTypeOf("function");
  if (!factory) throw new Error("Storage vNext deletion coordinator is unavailable");
  return factory({
    repository: fixture.repository,
    visibilityCache: fixture.visibilityCache
  });
}

function createFixture(existingState: ExistingWorkState = "processing") {
  const currentRevisions = new Map([
    ["file-delete-contract", 7],
    ["file-delete-sibling", 2],
    ["directory-delete-contract", 4],
    ["kb-delete-contract", 9]
  ]);
  const visibleSourceFiles = new Set([
    "file-delete-contract",
    "file-delete-descendant",
    "file-delete-sibling",
    "file-published-contract",
    "file-unpublished-contract",
    "file-running-contract",
    "file-claimed-contract"
  ]);
  const visibleDirectories = new Set(["directory-delete-contract"]);
  const taskVisible = new Map([
    ["file-published-contract", true],
    ["file-unpublished-contract", true],
    ["file-running-contract", true],
    ["file-claimed-contract", true]
  ]);
  const sourceTaskState = new Map([
    ["file-published-contract", "published"],
    ["file-unpublished-contract", "unpublished"],
    ["file-running-contract", "running"],
    ["file-claimed-contract", "claimed"]
  ]);
  const idempotency = new Map<string, {
    requestHash: string;
    operationPublicId: string;
  }>();
  const deletionOperations: Array<{ kind: DeletionKind; targetPublicId: string }> = [];
  const existingWork: { state: ExistingWorkState | "superseded" } = {
    state: existingState
  };
  let knowledgeBaseVisible = true;
  let perFileDeletionOperations = 0;
  let liveUnifiedCandidateCount = 1;
  const splitSearchIndexCount = 0;

  const acceptDeletion = async (input: DeletionRequest & {
    targetKind: DeletionKind;
    requestHash: string;
  }): Promise<DeletionAcceptance> => {
    const identity = `${input.knowledgeBaseId}\0${input.idempotencyKey}`;
    const replay = idempotency.get(identity);
    if (replay) {
      if (replay.requestHash !== input.requestHash) {
        throw errorWithCode("idempotency_conflict");
      }
      return {
        outcome: "replayed",
        operationPublicId: replay.operationPublicId,
        state: "queued",
        visibilityCommitted: true
      };
    }
    if (currentRevisions.get(input.targetPublicId)
      !== input.expectedResourceRevision) {
      throw errorWithCode("revision_conflict");
    }
    idempotency.set(identity, {
      requestHash: input.requestHash,
      operationPublicId: input.operationPublicId
    });
    deletionOperations.push({
      kind: input.kind,
      targetPublicId: input.targetPublicId
    });
    if (input.kind === "source_file") {
      visibleSourceFiles.delete(input.targetPublicId);
    } else if (input.kind === "source_directory") {
      visibleDirectories.delete(input.targetPublicId);
      visibleSourceFiles.delete("file-delete-contract");
      visibleSourceFiles.delete("file-delete-descendant");
    } else {
      knowledgeBaseVisible = false;
      liveUnifiedCandidateCount = 0;
      if (!["failed", "completed"].includes(existingWork.state)) {
        existingWork.state = "superseded";
      }
    }
    return {
      outcome: "queued",
      operationPublicId: input.operationPublicId,
      state: "queued",
      visibilityCommitted: true
    };
  };

  const repository = {
    acceptDeletion: vi.fn(acceptDeletion),
    deleteSourceTasks: vi.fn(async (
      input: SourceTaskDeletionInput
    ): Promise<readonly SourceTaskDeletionResult[]> => {
      const results: SourceTaskDeletionResult[] = [];
      for (const sourceFilePublicId of input.sourceFilePublicIds) {
        const state = sourceTaskState.get(sourceFilePublicId);
        if (state === "running" || state === "claimed") {
          results.push({
            sourceFilePublicId,
            outcome: "skipped",
            reason: state === "running" ? "running" : "job_already_claimed"
          });
          continue;
        }
        if (state === "published") {
          taskVisible.set(sourceFilePublicId, false);
          results.push({
            sourceFilePublicId,
            outcome: "hidden",
            generatedFilePublicId: "generated-published-contract",
            generatedFilePath: "pages/Published.md"
          });
          continue;
        }
        if (state === "unpublished") {
          visibleSourceFiles.delete(sourceFilePublicId);
          deletionOperations.push({ kind: "source_file", targetPublicId: sourceFilePublicId });
          results.push({ sourceFilePublicId, outcome: "deleted" });
          continue;
        }
        results.push({ sourceFilePublicId, outcome: "skipped", reason: "missing" });
      }
      return results;
    })
  };
  const visibilityCache = {
    invalidateKnowledgeBase: vi.fn(async () => undefined)
  };

  return {
    repository,
    visibilityCache,
    visibleSourceFiles,
    visibleDirectories,
    taskVisible,
    deletionOperations,
    existingWork,
    get knowledgeBaseVisible() {
      return knowledgeBaseVisible;
    },
    get perFileDeletionOperations() {
      return perFileDeletionOperations;
    },
    get liveUnifiedCandidateCount() {
      return liveUnifiedCandidateCount;
    },
    splitSearchIndexCount
  };
}

function deletionRequest(
  overrides: Partial<DeletionRequest> = {}
): DeletionRequest {
  return {
    kind: "source_file",
    knowledgeBaseId: "kb-delete-contract",
    operationPublicId: "operation-delete-contract",
    targetPublicId: "file-delete-contract",
    expectedResourceRevision: 7,
    idempotencyKey: "delete-contract-key",
    settingsRevisionPublicId: "settings-delete-contract",
    requestedAt: "2026-08-01T04:00:00.000Z",
    expiresAt: "2026-08-02T04:00:00.000Z",
    ...overrides
  };
}

function sourceTaskDeletionInput(
  sourceFilePublicIds: readonly string[]
): SourceTaskDeletionInput {
  return {
    knowledgeBaseId: "kb-delete-contract",
    sourceFilePublicIds,
    deletedAt: "2026-08-01T04:00:00.000Z",
    settingsRevisionPublicId: "settings-delete-contract",
    resultExpiresAt: "2026-08-02T04:00:00.000Z"
  };
}

function errorWithCode(code: string): Error {
  return Object.assign(new Error(code), { code });
}
