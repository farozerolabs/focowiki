import type { ActiveGenerationReadRepository } from "../application/ports/active-generation-read-repository.js";
import type { PublicationGenerationRepository } from "../application/ports/publication-generation-repository.js";
import type { RoleJobRepository } from "../application/ports/role-job-repository.js";
import type { ApplicationRuntime } from "../application/ports/runtime.js";
import type { SerializableJson } from "../application/ports/source-dispatch-repository.js";
import { createSourceResourceMutationService } from "../application/source-resource-mutations.js";
import type { AdminRepositories } from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { StorageAdapter } from "../storage/s3.js";
import { INCREMENTAL_PUBLICATION_DEFAULTS } from "../publication/incremental-defaults.js";

export type AdminDeletionService = {
  deleteKnowledgeBase: (input: {
    knowledgeBaseId: string;
    maxAttempts: number;
  }) => Promise<boolean>;
  deleteSourcePage: (input: {
    knowledgeBaseId: string;
    logicalPath: string;
    maxAttempts: number;
  }) => Promise<SourcePageDeletionResult>;
};

export type SourcePageDeletionResult =
  | { ok: true; publicationQueued: true }
  | { ok: false; reason: "not_found" | "not_deletable" };

export function createDeletionService(input: {
  repositories: AdminRepositories;
  activeGenerationReads: ActiveGenerationReadRepository;
  roleJobs: RoleJobRepository;
  publicationGenerations: PublicationGenerationRepository;
  storage: StorageAdapter;
  redis: RedisCoordinator;
  runtime: ApplicationRuntime;
  publicationSettingsSnapshot: SerializableJson;
}): AdminDeletionService | null {
  const sourceResources = input.repositories.sourceResources;
  if (!sourceResources) return null;

  const mutations = createSourceResourceMutationService({
    repository: sourceResources,
    roleJobs: input.roleJobs,
    generations: input.publicationGenerations,
    graph: input.repositories.graph,
    impactPlanner: INCREMENTAL_PUBLICATION_DEFAULTS.impactPlanner,
    publicationSettingsSnapshot: input.publicationSettingsSnapshot,
    storage: {
      sourceRevisionKey: input.storage.keyspace.sourceRevisionKey,
      put: (object) => input.storage.putObject(object),
      delete: async (key) => {
        await input.storage.deleteObject?.(key);
      }
    },
    runtime: input.runtime
  });

  return {
    async deleteKnowledgeBase(request) {
      const knowledgeBase = await input.repositories.knowledgeBases.getKnowledgeBase(
        request.knowledgeBaseId
      );
      if (!knowledgeBase) return false;
      await mutations.deleteKnowledgeBase({
        knowledgeBaseId: knowledgeBase.id,
        idempotencyKey: `admin-knowledge-base-delete:${knowledgeBase.id}:${knowledgeBase.resourceRevision ?? 1}`,
        expectedResourceRevision: knowledgeBase.resourceRevision ?? 1,
        maxAttempts: request.maxAttempts
      });
      await input.redis.clearKnowledgeBaseRuntimeKeys({ knowledgeBaseId: knowledgeBase.id });
      return true;
    },

    async deleteSourcePage(request) {
      const file = await input.activeGenerationReads.withActiveGeneration(
        request.knowledgeBaseId,
        (scope) => scope.findFileByPath(request.logicalPath)
      );
      if (!file) return { ok: false, reason: "not_found" };
      if (file.refKind !== "page" || !file.sourceFileId) {
        return { ok: false, reason: "not_deletable" };
      }
      const sourceFile = await mutations.resources.getSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: file.sourceFileId
      });
      if (!sourceFile) return { ok: false, reason: "not_found" };
      await mutations.deleteSourceFile({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: sourceFile.id,
        idempotencyKey: `admin-source-file-delete:${sourceFile.id}:${sourceFile.resourceRevision}`,
        expectedResourceRevision: sourceFile.resourceRevision,
        maxAttempts: request.maxAttempts
      });
      await input.redis.clearSourceFileRuntimeKeys({
        knowledgeBaseId: request.knowledgeBaseId,
        sourceFileId: sourceFile.id
      });
      return { ok: true, publicationQueued: true };
    }
  };
}
