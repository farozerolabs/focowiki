import type { PublicationGenerationRepository } from "./ports/publication-generation-repository.js";
import type { SerializableJson } from "./ports/source-dispatch-repository.js";
import type { SourceRevisionContextRepository } from "./ports/source-revision-context-repository.js";
import { createChangeFactIdentity } from "../domain/generation.js";
import type { ImpactPlannerConfig } from "../publication/impact-planner.js";

export type SourceProcessingCompletion = {
  assertCurrent: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    sourceRevisionId: string;
  }) => Promise<void>;
  complete: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
    sourceRevisionId: string;
    graphNeighborSourceFileIds: string[];
    graphEdgeIds: string[];
    removedGraphEdgeIds: string[];
    publicationSettingsSnapshot?: SerializableJson | undefined;
    publicationMaxAttempts?: number | undefined;
    completedAt: string;
  }) => Promise<void>;
};

export function createSourceProcessingCompletion(input: {
  revisions: SourceRevisionContextRepository;
  generations: PublicationGenerationRepository;
  impactPlanner: ImpactPlannerConfig;
  publicationSettingsSnapshot: SerializableJson;
  publicationMaxAttempts: number;
}): SourceProcessingCompletion {
  return {
    async assertCurrent(request) {
      const current = await input.revisions.findCurrent(request);
      if (!current) {
        throw new SourceRevisionSupersededError();
      }
    },

    async complete(request) {
      const current = await input.revisions.findCurrent(request);
      if (!current) {
        throw new SourceRevisionSupersededError();
      }
      const kind = current.revision === 1 ? "source_created" : "source_replaced";
      const changeFactId = createChangeFactIdentity({
        knowledgeBaseId: current.knowledgeBaseId,
        sourceRevisionId: current.sourceRevisionId,
        kind,
        previousPath: current.previousRelativePath,
        path: current.relativePath
      });
      await input.generations.commitSourceCompletion({
        knowledgeBaseId: current.knowledgeBaseId,
        sourceFileId: current.sourceFileId,
        sourceRevisionId: current.sourceRevisionId,
        kind,
        previousPath: current.previousRelativePath,
        path: current.relativePath,
        resourceRevision: current.resourceRevision,
        operationId: current.operationId,
        changeFactId,
        planningContext: {
          graphNeighborSourceFileIds: request.graphNeighborSourceFileIds,
          graphEdgeIds: request.graphEdgeIds,
          removedGraphEdgeIds: request.removedGraphEdgeIds,
          impactPlanner: input.impactPlanner
        },
        publicationSettingsSnapshot:
          request.publicationSettingsSnapshot ?? input.publicationSettingsSnapshot,
        publicationMaxAttempts:
          request.publicationMaxAttempts ?? input.publicationMaxAttempts,
        completedAt: request.completedAt
      });
    }
  };
}

export class SourceRevisionSupersededError extends Error {
  public constructor() {
    super("Source revision is no longer current");
    this.name = "SourceRevisionSupersededError";
  }
}
