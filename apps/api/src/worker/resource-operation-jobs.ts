import { createChangeFactIdentity } from "../domain/generation.js";
import { RoleJobReschedule, type RoleJobRecord } from "../domain/role-job.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
import { SourceResourceError } from "../domain/source-resource.js";
import {
  planPublicationImpacts,
  type ImpactPlannerConfig
} from "../publication/impact-planner.js";

export async function processResourceOperationJob(input: {
  job: RoleJobRecord;
  repositories: AdminRepositories;
  roleJobs: Pick<RoleJobRepository, "enqueue" | "cancelSourceJobsForDeletionIntent">;
  generations: Pick<PublicationGenerationRepository, "commitMutation">;
  impactPlanner: ImpactPlannerConfig;
  sourceJobMaxAttempts: number;
  publicationJobMaxAttempts: number;
  databaseBatchSize: number;
}): Promise<{ cleanupObjectKeys: string[] }> {
  const repository = input.repositories.sourceResources;
  if (!repository) throw new Error("Source resource repository is unavailable");
  const operationId = readOperationId(input.job.payload);
  const now = new Date().toISOString();

  try {
    const prepared = await repository.prepareOperation({
      knowledgeBaseId: input.job.knowledgeBaseId,
      operationId,
      now,
      batchSize: input.databaseBatchSize
    });
    if (prepared.requiresContinuation) {
      throw new RoleJobReschedule(new Date(Date.now() + 100).toISOString());
    }

    if (prepared.requiresSourceProcessing && prepared.sourceMutation) {
      await input.roleJobs.enqueue({
        id: `role-job-source-${prepared.sourceMutation.sourceRevisionId}`,
        role: "source",
        kind: "source_processing",
        knowledgeBaseId: input.job.knowledgeBaseId,
        sourceFileId: prepared.sourceMutation.sourceFileId,
        sourceRevisionId: prepared.sourceMutation.sourceRevisionId,
        generationId: null,
        payload: { reason: "resource_operation", operationId },
        settingsSnapshot: input.job.settingsSnapshot,
        runAfter: now,
        maxAttempts: input.sourceJobMaxAttempts,
        createdAt: now
      });
      return { cleanupObjectKeys: [] };
    }

    if (prepared.requiresPublication && prepared.sourceMutation) {
      await commitSourceMutation({
        generations: input.generations,
        knowledgeBaseId: input.job.knowledgeBaseId,
        operationId,
        mutation: prepared.sourceMutation,
        settingsSnapshot: input.job.settingsSnapshot,
        publicationMaxAttempts: input.publicationJobMaxAttempts,
        impactPlanner: input.impactPlanner,
        committedAt: now
      });
    }

    if (prepared.directoryDeletion) {
      await input.roleJobs.cancelSourceJobsForDeletionIntent({
        knowledgeBaseId: input.job.knowledgeBaseId,
        deletionIntentId: prepared.directoryDeletion.deletionIntentId,
        cancelledAt: now,
        code: "SOURCE_DIRECTORY_DELETED",
        message: "Source directory was deleted before queued processing started."
      });
      await input.roleJobs.enqueue({
        id: `role-job-hard-delete-${prepared.directoryDeletion.deletionIntentId}`,
        role: "maintenance",
        kind: "hard_delete",
        knowledgeBaseId: input.job.knowledgeBaseId,
        sourceFileId: null,
        sourceRevisionId: null,
        generationId: null,
        payload: {
          targetKind: "source_directory",
          sourceDirectoryId: prepared.directoryDeletion.directoryId,
          deletionIntentId: prepared.directoryDeletion.deletionIntentId
        },
        settingsSnapshot: input.job.settingsSnapshot,
        runAfter: now,
        maxAttempts: input.publicationJobMaxAttempts,
        createdAt: now
      });
    }

    if (prepared.requiresPublication && prepared.directoryMutation) {
      if (!repository.listPendingOperationSourceMutations) {
        throw new Error("Pending source mutation repository is unavailable");
      }
      const pending = await repository.listPendingOperationSourceMutations({
        knowledgeBaseId: input.job.knowledgeBaseId,
        operationId,
        deletionIntentId: prepared.directoryMutation.deletionIntentId,
        limit: input.databaseBatchSize
      });
      const closures = await input.repositories.graph?.getMutationClosures?.({
        knowledgeBaseId: input.job.knowledgeBaseId,
        sourceFileIds: pending.items.map((item) => item.sourceFileId)
      }) ?? new Map();
      for (const mutation of pending.items) {
        const closure = closures.get(mutation.sourceFileId);
        await commitSourceMutation({
          generations: input.generations,
          knowledgeBaseId: input.job.knowledgeBaseId,
          operationId,
          deletionIntentId: prepared.directoryMutation.deletionIntentId,
          mutation,
          graphNeighborSourceFileIds: closure?.neighborSourceFileIds ?? [],
          graphEdgeIds: mutation.kind === "source_deleted" ? [] : closure?.edgeIds ?? [],
          removedGraphEdgeIds: mutation.kind === "source_deleted" ? closure?.edgeIds ?? [] : [],
          settingsSnapshot: input.job.settingsSnapshot,
          publicationMaxAttempts: input.publicationJobMaxAttempts,
          impactPlanner: input.impactPlanner,
          schedulePublication: false,
          committedAt: now
        });
      }
      if (pending.items.length > 0 || pending.hasMore) {
        throw new RoleJobReschedule(new Date(Date.now() + 25).toISOString());
      }
      await commitDirectoryMutation({
        generations: input.generations,
        knowledgeBaseId: input.job.knowledgeBaseId,
        operationId,
        mutation: prepared.directoryMutation,
        settingsSnapshot: input.job.settingsSnapshot,
        publicationMaxAttempts: input.publicationJobMaxAttempts,
        impactPlanner: input.impactPlanner,
        committedAt: now
      });
    }

    return { cleanupObjectKeys: [] };
  } catch (error) {
    if (error instanceof RoleJobReschedule) throw error;
    if (error instanceof SourceResourceError) {
      const failed = await repository.failOperation({
        knowledgeBaseId: input.job.knowledgeBaseId,
        operationId,
        errorCode: error.code,
        failedAt: new Date().toISOString()
      });
      return { cleanupObjectKeys: failed.objectKeys };
    }
    throw error;
  }
}

async function commitSourceMutation(input: {
  generations: Pick<PublicationGenerationRepository, "commitMutation">;
  knowledgeBaseId: string;
  operationId: string;
  deletionIntentId?: string | null;
  mutation: {
    sourceFileId: string;
    sourceRevisionId: string;
    kind: "source_replaced" | "source_moved" | "source_deleted";
    previousPath: string;
    path: string | null;
    resourceRevision: number;
  };
  settingsSnapshot: SerializableJson;
  publicationMaxAttempts: number;
  impactPlanner: ImpactPlannerConfig;
  graphNeighborSourceFileIds?: string[];
  graphEdgeIds?: string[];
  removedGraphEdgeIds?: string[];
  schedulePublication?: boolean;
  committedAt: string;
}): Promise<void> {
  const changeFactId = createChangeFactIdentity({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceRevisionId: input.mutation.sourceRevisionId,
    kind: input.mutation.kind,
    previousPath: input.mutation.previousPath,
    path: input.mutation.path,
    mutationIdentity: input.operationId
  });
  await input.generations.commitMutation({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.mutation.sourceFileId,
    sourceRevisionId: input.mutation.sourceRevisionId,
    kind: input.mutation.kind,
    previousPath: input.mutation.previousPath,
    path: input.mutation.path,
    resourceRevision: input.mutation.resourceRevision,
    operationId: input.operationId,
    deletionIntentId: input.deletionIntentId ?? null,
    changeFactId,
    impacts: planPublicationImpacts({
      changeFactId,
      kind: input.mutation.kind,
      sourceFileId: input.mutation.sourceFileId,
      previousPath: input.mutation.previousPath,
      path: input.mutation.path,
      ...(input.graphNeighborSourceFileIds
        ? { graphNeighborSourceFileIds: input.graphNeighborSourceFileIds }
        : {}),
      ...(input.graphEdgeIds ? { graphEdgeIds: input.graphEdgeIds } : {}),
      ...(input.removedGraphEdgeIds
        ? { removedGraphEdgeIds: input.removedGraphEdgeIds }
        : {}),
      config: input.impactPlanner
    }),
    publicationSettingsSnapshot: input.settingsSnapshot,
    publicationMaxAttempts: input.publicationMaxAttempts,
    schedulePublication: input.schedulePublication,
    committedAt: input.committedAt
  });
}

async function commitDirectoryMutation(input: {
  generations: Pick<PublicationGenerationRepository, "commitMutation">;
  knowledgeBaseId: string;
  operationId: string;
  mutation: NonNullable<
    Awaited<ReturnType<NonNullable<AdminRepositories["sourceResources"]>["prepareOperation"]>>["directoryMutation"]
  >;
  settingsSnapshot: SerializableJson;
  publicationMaxAttempts: number;
  impactPlanner: ImpactPlannerConfig;
  committedAt: string;
}): Promise<void> {
  const changeFactId = createChangeFactIdentity({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceRevisionId: null,
    kind: input.mutation.kind,
    previousPath: input.mutation.previousPath,
    path: input.mutation.path,
    mutationIdentity: input.operationId
  });
  await input.generations.commitMutation({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: null,
    sourceRevisionId: null,
    kind: input.mutation.kind,
    previousPath: input.mutation.previousPath,
    path: input.mutation.path,
    resourceRevision: input.mutation.resourceRevision,
    operationId: input.operationId,
    deletionIntentId: input.mutation.deletionIntentId,
    changeFactId,
    impacts: planPublicationImpacts({
      changeFactId,
      kind: input.mutation.kind,
      sourceFileId: null,
      previousPath: input.mutation.previousPath,
      path: input.mutation.path,
      config: input.impactPlanner
    }),
    publicationSettingsSnapshot: input.settingsSnapshot,
    publicationMaxAttempts: input.publicationMaxAttempts,
    committedAt: input.committedAt
  });
}

function readOperationId(payload: SerializableJson): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || payload instanceof Date) {
    throw new Error("Resource operation role job payload is invalid");
  }
  const value = (payload as { readonly [key: string]: SerializableJson | undefined }).operationId;
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Resource operation role job payload is invalid");
  }
  return value;
}
