import { describe, expect, it, vi } from "vitest";
import type { PublicationGenerationRepository } from "../src/application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../src/application/ports/role-job-repository.js";
import type { AdminRepositories } from "../src/db/admin-repositories.js";
import type { RoleJobRecord } from "../src/domain/role-job.js";
import { RoleJobReschedule } from "../src/domain/role-job.js";
import type { ResourceOperationRecord } from "../src/domain/source-resource.js";
import { SourceResourceError } from "../src/domain/source-resource.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "../src/publication/incremental-defaults.js";
import { processResourceOperationJob } from "../src/worker/resource-operation-jobs.js";

describe("resource operation role jobs", () => {
  it("enqueues candidate source revisions on the source role", async () => {
    const enqueue = vi.fn(async (input: Parameters<RoleJobRepository["enqueue"]>[0]) =>
      createRoleJob(input.kind, input)
    );
    const operation = createOperation("source_file_replace", "processing");
    const repositories = createRepositories({
      operation,
      sourceFileId: "source-file-test",
      sourceMutation: {
        sourceFileId: "source-file-test",
        sourceRevisionId: "source-revision-test",
        kind: "source_replaced",
        previousPath: "pages/old.md",
        path: "pages/new.md",
        resourceRevision: 2
      },
      requiresSourceProcessing: true
    });

    await expect(run({ repositories, roleJobs: { enqueue } })).resolves.toEqual({
      cleanupObjectKeys: []
    });

    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: "role-job-source-source-revision-test",
      role: "source",
      kind: "source_processing",
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test",
      sourceRevisionId: "source-revision-test",
      payload: { reason: "resource_operation", operationId: "resource-operation-test" }
    }));
  });

  it("commits a direct source move as an incremental mutation", async () => {
    const commitMutation = vi.fn(async (
      _input: Parameters<PublicationGenerationRepository["commitMutation"]>[0]
    ) => ({
      generationId: "generation-test",
      changeFactId: "change-fact-test",
      impactCount: 1,
      replayed: false
    }));
    const operation = createOperation("source_file_move", "publishing");
    const repositories = createRepositories({
      operation,
      sourceFileId: "source-file-test",
      sourceMutation: {
        sourceFileId: "source-file-test",
        sourceRevisionId: "source-revision-test",
        kind: "source_moved",
        previousPath: "pages/old.md",
        path: "guides/new.md",
        resourceRevision: 2
      },
      requiresPublication: true
    });

    await run({ repositories, generations: { commitMutation } });

    expect(commitMutation).toHaveBeenCalledWith(expect.objectContaining({
      knowledgeBaseId: "kb-test",
      sourceFileId: "source-file-test",
      sourceRevisionId: "source-revision-test",
      kind: "source_moved",
      previousPath: "pages/old.md",
      path: "guides/new.md",
      operationId: "resource-operation-test",
      deletionIntentId: null
    }));
    expect(commitMutation.mock.calls[0]![0].impacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ projectionKind: "page", recordIdentity: "source-file-test" }),
        expect.objectContaining({ projectionKind: "directory", projectionKey: "pages" }),
        expect.objectContaining({ projectionKind: "directory", projectionKey: "guides" })
      ])
    );
  });

  it("reschedules bounded directory preparation without consuming a retry", async () => {
    const operation = createOperation("source_directory_delete", "processing");
    const repositories = createRepositories({
      operation,
      requiresContinuation: true
    });

    await expect(run({ repositories })).rejects.toBeInstanceOf(RoleJobReschedule);
  });

  it("persists directory hard deletion before paged publication work reschedules", async () => {
    const enqueue = vi.fn(async (input: Parameters<RoleJobRepository["enqueue"]>[0]) =>
      createRoleJob(input.kind, input)
    );
    const cancelSourceJobsForDeletionIntent = vi.fn(async () => 1);
    const commitMutation = vi.fn(async (
      _input: Parameters<PublicationGenerationRepository["commitMutation"]>[0]
    ) => ({
      generationId: "generation-test",
      changeFactId: "change-fact-test",
      impactCount: 1,
      replayed: false
    }));
    const repositories = {
      sourceResources: {
        prepareOperation: vi.fn(async () => ({
          operation: createOperation("source_directory_delete", "publishing"),
          sourceFileId: null,
          sourceMutation: null,
          directoryMutation: {
            kind: "directory_deleted" as const,
            previousPath: "guides",
            path: null,
            resourceRevision: 2,
            deletionIntentId: "deletion-intent-test"
          },
          requiresSourceProcessing: false,
          requiresPublication: true,
          requiresContinuation: false,
          directoryDeletion: {
            deletionIntentId: "deletion-intent-test",
            directoryId: "source-directory-test"
          }
        })),
        listPendingOperationSourceMutations: vi.fn(async () => ({
          items: [{
            sourceFileId: "source-file-test",
            sourceRevisionId: "source-revision-test",
            kind: "source_deleted" as const,
            previousPath: "guides/page.md",
            path: null,
            resourceRevision: 1
          }],
          hasMore: false
        }))
      }
    } as unknown as AdminRepositories;

    await expect(run({
      repositories,
      roleJobs: { enqueue, cancelSourceJobsForDeletionIntent },
      generations: { commitMutation }
    })).rejects.toBeInstanceOf(RoleJobReschedule);

    expect(cancelSourceJobsForDeletionIntent).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      deletionIntentId: "deletion-intent-test",
      cancelledAt: expect.any(String),
      code: "SOURCE_DIRECTORY_DELETED",
      message: "Source directory was deleted before queued processing started."
    });
    expect(enqueue).toHaveBeenCalledWith(expect.objectContaining({
      id: "role-job-hard-delete-deletion-intent-test",
      role: "maintenance",
      kind: "hard_delete",
      knowledgeBaseId: "kb-test",
      payload: {
        targetKind: "source_directory",
        sourceDirectoryId: "source-directory-test",
        deletionIntentId: "deletion-intent-test"
      }
    }));
  });

  it("contains terminal resource conflicts without terminating the source worker", async () => {
    const failOperation = vi.fn(async () => ({
      operation: createOperation("source_file_move", "failed"),
      objectKeys: ["sources/candidate.md"]
    }));
    const repositories = {
      sourceResources: {
        prepareOperation: vi.fn(async () => {
          throw new SourceResourceError("RESOURCE_PATH_CONFLICT");
        }),
        failOperation
      }
    } as unknown as AdminRepositories;

    await expect(run({ repositories })).resolves.toEqual({
      cleanupObjectKeys: ["sources/candidate.md"]
    });
    expect(failOperation).toHaveBeenCalledWith({
      knowledgeBaseId: "kb-test",
      operationId: "resource-operation-test",
      errorCode: "RESOURCE_PATH_CONFLICT",
      failedAt: expect.any(String)
    });
  });
});

function run(input: {
  repositories: AdminRepositories;
  roleJobs?: Partial<RoleJobRepository>;
  generations?: Partial<PublicationGenerationRepository>;
}) {
  return processResourceOperationJob({
    job: createRoleJob("resource_operation", {
      payload: { operationId: "resource-operation-test" }
    }),
    repositories: input.repositories,
    roleJobs: input.roleJobs as RoleJobRepository ?? ({} as RoleJobRepository),
    generations: input.generations as PublicationGenerationRepository
      ?? ({} as PublicationGenerationRepository),
    impactPlanner: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner,
    sourceJobMaxAttempts: 3,
    publicationJobMaxAttempts: 3,
    databaseBatchSize: 50
  });
}

function createRepositories(overrides: Record<string, unknown>): AdminRepositories {
  return {
    sourceResources: {
      prepareOperation: vi.fn(async () => ({
        operation: createOperation("source_file_move", "publishing"),
        sourceFileId: null,
        sourceMutation: null,
        requiresSourceProcessing: false,
        requiresPublication: false,
        requiresContinuation: false,
        directoryDeletion: null,
        ...overrides
      }))
    }
  } as unknown as AdminRepositories;
}

function createOperation(
  kind: ResourceOperationRecord["kind"],
  state: ResourceOperationRecord["state"]
): ResourceOperationRecord {
  return {
    id: "resource-operation-test",
    knowledgeBaseId: "kb-test",
    kind,
    state,
    expectedResourceRevision: 1,
    candidateCatalogGeneration: 1,
    result: null,
    errorCode: null,
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    completedAt: null
  };
}

function createRoleJob(
  kind: RoleJobRecord["kind"],
  overrides: Partial<RoleJobRecord> = {}
): RoleJobRecord {
  return {
    id: `role-job-${kind}`,
    role: "source",
    kind,
    knowledgeBaseId: "kb-test",
    sourceFileId: null,
    sourceRevisionId: null,
    generationId: null,
    payload: {},
    settingsSnapshot: { publication: {}, graph: {} },
    status: "running",
    runAfter: "2026-07-10T00:00:00.000Z",
    attemptCount: 1,
    maxAttempts: 3,
    lockedBy: "source-worker-test",
    lockedAt: "2026-07-10T00:00:00.000Z",
    heartbeatAt: "2026-07-10T00:00:00.000Z",
    createdAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    ...overrides
  };
}
