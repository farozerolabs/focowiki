import { createHash } from "node:crypto";
import { createChangeFactIdentity } from "../domain/generation.js";
import { planPublicationImpacts, type ImpactPlannerConfig } from "../publication/impact-planner.js";
import type { PublicationGenerationRepository } from "./ports/publication-generation-repository.js";
import type { RoleJobRepository } from "./ports/role-job-repository.js";
import type { SerializableJson } from "./ports/source-dispatch-repository.js";
import type { SourceResourceRepository } from "./ports/source-resource-repository.js";
import type { ApplicationRuntime } from "./ports/runtime.js";
import { createSourceResourceService } from "./source-resources.js";

export type ResourceMutationStoragePort = {
  sourceRevisionKey: (
    knowledgeBaseId: string,
    sourceFileId: string,
    revision: string
  ) => string;
  put: (input: {
    key: string;
    body: Uint8Array;
    contentType: string;
  }) => Promise<void>;
  delete: (key: string) => Promise<void>;
};

export function createSourceResourceMutationService(input: {
  repository: SourceResourceRepository;
  roleJobs: Pick<
    RoleJobRepository,
    "enqueue" | "cancelSourceJobsForDeletionIntent" | "cancelKnowledgeBaseJobs"
  >;
  generations: Pick<PublicationGenerationRepository, "commitMutation">;
  graph?: {
    getMutationClosures?: (request: {
      knowledgeBaseId: string;
      sourceFileIds: string[];
    }) => Promise<Map<string, {
      neighborSourceFileIds: string[];
      edgeIds: string[];
    }>>;
  } | undefined;
  impactPlanner: ImpactPlannerConfig;
  publicationSettingsSnapshot: SerializableJson;
  storage: ResourceMutationStoragePort;
  runtime: ApplicationRuntime;
}) {
  const resources = createSourceResourceService(input.repository, input.runtime);

  async function acceptOperation(
    request: Parameters<typeof resources.acceptOperation>[0],
    maxAttempts: number
  ) {
    const result = await resources.acceptOperation(request);
    if (!result.replayed) {
      const now = input.runtime.clock.now().toISOString();
      await input.roleJobs.enqueue({
        id: `role-job-resource-${result.operation.id}`,
        role: "source",
        kind: "resource_operation",
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: null,
        sourceRevisionId: null,
        generationId: null,
        payload: { operationId: result.operation.id },
        settingsSnapshot: input.publicationSettingsSnapshot,
        runAfter: now,
        maxAttempts,
        createdAt: now
      });
    }
    return result;
  }

  return {
    resources,
    acceptOperation,
    async updateKnowledgeBase(
      request: Parameters<typeof resources.updateKnowledgeBase>[0],
      maxAttempts: number
    ) {
      const updated = await resources.updateKnowledgeBase(request);
      if (updated) {
        const committedAt = input.runtime.clock.now().toISOString();
        const changeFactId = createChangeFactIdentity({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceRevisionId: null,
          kind: "knowledge_base_metadata_changed",
          previousPath: null,
          path: null,
          mutationIdentity: `resource-revision-${updated.resourceRevision}`
        });
        await input.generations.commitMutation({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFileId: null,
          sourceRevisionId: null,
          kind: "knowledge_base_metadata_changed",
          previousPath: null,
          path: null,
          resourceRevision: updated.resourceRevision,
          operationId: null,
          deletionIntentId: null,
          changeFactId,
          impacts: planPublicationImpacts({
            changeFactId,
            kind: "knowledge_base_metadata_changed",
            sourceFileId: null,
            previousPath: null,
            path: null,
            config: input.impactPlanner
          }),
          publicationSettingsSnapshot: input.publicationSettingsSnapshot,
          publicationMaxAttempts: maxAttempts,
          committedAt
        });
      }
      return {
        knowledgeBase: updated,
        publicationQueued: Boolean(updated)
      };
    },
    async replaceSourceContent(request: {
      knowledgeBaseId: string;
      sourceFileId: string;
      expectedResourceRevision: number;
      idempotencyKey: string;
      bytes: Uint8Array;
      relativePath?: string;
      maxAttempts: number;
    }) {
      const checksumSha256 = createHash("sha256").update(request.bytes).digest("hex");
      const revisionId = input.runtime.ids.create("source-revision");
      const objectKey = input.storage.sourceRevisionKey(
        request.knowledgeBaseId,
        request.sourceFileId,
        revisionId
      );
      await input.storage.put({
        key: objectKey,
        body: request.bytes,
        contentType: "text/markdown; charset=utf-8"
      });
      try {
        return await acceptOperation(
          {
            knowledgeBaseId: request.knowledgeBaseId,
            kind: "source_file_replace",
            idempotencyKey: request.idempotencyKey,
            expectedResourceRevision: request.expectedResourceRevision,
            targetKind: "source_file",
            targetId: request.sourceFileId,
            payload: {
              revisionId,
              objectKey,
              sizeBytes: request.bytes.byteLength,
              checksumSha256,
              ...(request.relativePath ? { relativePath: request.relativePath } : {})
            }
          },
          request.maxAttempts
        );
      } catch (error) {
        await input.storage.delete(objectKey).catch(() => undefined);
        throw error;
      }
    },
    async deleteSourceFile(request: {
      knowledgeBaseId: string;
      sourceFileId: string;
      idempotencyKey: string;
      expectedResourceRevision: number;
      maxAttempts: number;
    }) {
      const closures = await input.graph?.getMutationClosures?.({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileIds: [request.sourceFileId]
      });
      const result = await resources.deleteSourceFile(request);
      const mutation = result.sourceMutation;
      const now = input.runtime.clock.now().toISOString();
      if (mutation) {
        const closure = closures?.get(mutation.sourceFileId);
        const changeFactId = createChangeFactIdentity({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceRevisionId: mutation.sourceRevisionId,
          kind: "source_deleted",
          previousPath: mutation.previousPath,
          path: null,
          mutationIdentity: result.deletionIntentId
        });
        await input.generations.commitMutation({
          knowledgeBaseId: request.knowledgeBaseId,
          sourceFileId: mutation.sourceFileId,
          sourceRevisionId: mutation.sourceRevisionId,
          kind: "source_deleted",
          previousPath: mutation.previousPath,
          path: null,
          resourceRevision: mutation.resourceRevision,
          operationId: result.operation.id,
          deletionIntentId: result.deletionIntentId,
          changeFactId,
          impacts: planPublicationImpacts({
            changeFactId,
            kind: "source_deleted",
            sourceFileId: mutation.sourceFileId,
            previousPath: mutation.previousPath,
            path: null,
            graphNeighborSourceFileIds: closure?.neighborSourceFileIds ?? [],
            removedGraphEdgeIds: closure?.edgeIds ?? [],
            config: input.impactPlanner
          }),
          publicationSettingsSnapshot: input.publicationSettingsSnapshot,
          publicationMaxAttempts: request.maxAttempts,
          committedAt: now
        });
      }
      await input.roleJobs.cancelSourceJobsForDeletionIntent({
        knowledgeBaseId: request.knowledgeBaseId,
        deletionIntentId: result.deletionIntentId,
        cancelledAt: now,
        code: "SOURCE_FILE_DELETED",
        message: "Source file was deleted before queued processing started."
      });
      await input.roleJobs.enqueue({
        id: `role-job-hard-delete-${result.deletionIntentId}`,
        role: "maintenance",
        kind: "hard_delete",
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: null,
        sourceRevisionId: null,
        generationId: null,
        payload: {
          targetKind: "source_file",
          sourceFileId: request.sourceFileId,
          deletionIntentId: result.deletionIntentId
        },
        settingsSnapshot: input.publicationSettingsSnapshot,
        runAfter: now,
        maxAttempts: request.maxAttempts,
        createdAt: now
      });
      return result;
    },
    async deleteDirectory(request: {
      knowledgeBaseId: string;
      directoryId: string;
      idempotencyKey: string;
      expectedResourceRevision: number;
      maxAttempts: number;
    }) {
      const result = await resources.deleteDirectory(request);
      const now = input.runtime.clock.now().toISOString();
      await input.roleJobs.enqueue({
        id: `role-job-resource-${result.operation.id}`,
        role: "source",
        kind: "resource_operation",
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: null,
        sourceRevisionId: null,
        generationId: null,
        payload: { operationId: result.operation.id },
        settingsSnapshot: input.publicationSettingsSnapshot,
        runAfter: now,
        maxAttempts: request.maxAttempts,
        createdAt: now
      });
      return result;
    },
    async deleteKnowledgeBase(request: {
      knowledgeBaseId: string;
      idempotencyKey: string;
      expectedResourceRevision: number;
      maxAttempts: number;
    }) {
      const result = await resources.deleteKnowledgeBase(request);
      const now = input.runtime.clock.now().toISOString();
      const changeFactId = createChangeFactIdentity({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceRevisionId: null,
        kind: "knowledge_base_deleted",
        previousPath: null,
        path: null,
        mutationIdentity: result.deletionIntentId
      });
      await input.generations.commitMutation({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: null,
        sourceRevisionId: null,
        kind: "knowledge_base_deleted",
        previousPath: null,
        path: null,
        resourceRevision: request.expectedResourceRevision + 1,
        operationId: result.operation.id,
        deletionIntentId: result.deletionIntentId,
        changeFactId,
        impacts: planPublicationImpacts({
          changeFactId,
          kind: "knowledge_base_deleted",
          sourceFileId: null,
          previousPath: null,
          path: null,
          config: input.impactPlanner
        }),
        publicationSettingsSnapshot: input.publicationSettingsSnapshot,
        publicationMaxAttempts: request.maxAttempts,
        schedulePublication: false,
        committedAt: now
      });
      const hardDeleteJobId = `role-job-hard-delete-${result.deletionIntentId}`;
      await input.roleJobs.cancelKnowledgeBaseJobs({
        knowledgeBaseId: request.knowledgeBaseId,
        excludeJobIds: [hardDeleteJobId],
        cancelledAt: now,
        code: "KNOWLEDGE_BASE_DELETED",
        message: "Knowledge base deletion superseded queued work."
      });
      await input.roleJobs.enqueue({
        id: hardDeleteJobId,
        role: "maintenance",
        kind: "hard_delete",
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: null,
        sourceRevisionId: null,
        generationId: null,
        payload: {
          targetKind: "knowledge_base",
          deletionIntentId: result.deletionIntentId
        },
        settingsSnapshot: input.publicationSettingsSnapshot,
        runAfter: now,
        maxAttempts: request.maxAttempts,
        createdAt: now
      });
      return result;
    }
  };
}
