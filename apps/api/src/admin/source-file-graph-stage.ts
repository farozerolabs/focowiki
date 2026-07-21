import type { SourceMetadataDefaults, SourceModelSuggestions } from "@focowiki/okf";
import { buildSourceFileGraph } from "../graph/file-graph.js";
import type {
  AdminRepositories,
  SourceFileProcessingStage,
  SourceFileRecord
} from "../db/admin-repositories.js";
import type { RedisCoordinator } from "../redis/coordination.js";
import type { ModelAssistanceOptions } from "./model-suggestions.js";
import type { SourceFileStageMarker, SourceFileStageRecorder } from "./source-file-stage-types.js";
import type { ResourceBudget } from "../runtime/resource-budget.js";

export async function processSourceFileGraphStage(input: {
  repositories: AdminRepositories;
  redis: RedisCoordinator;
  knowledgeBaseId: string;
  source: SourceFileRecord;
  metadata: SourceMetadataDefaults;
  body: string;
  suggestions: SourceModelSuggestions | null;
  pageSize: number;
  maxCandidateNodes: number | undefined;
  acceptedEdgeLimit: number | undefined;
  genericPhraseThreshold: number | undefined;
  ttlSeconds: number;
  ownerId: string;
  modelAssistance: ModelAssistanceOptions | null;
  progressClock: () => string;
  mark: SourceFileStageMarker;
  recordStage: SourceFileStageRecorder;
  graphQueryBudget?: ResourceBudget;
  databaseMutationBudget?: ResourceBudget;
}): Promise<{
  affectedSourceFileIds: string[];
  edgeIds: string[];
  removedEdgeIds: string[];
}> {
  const stage: SourceFileProcessingStage = "graph_generation";
  const startedAt = input.progressClock();
  let graphLockAcquired = false;
  let severity: "info" | "warning" = "info";

  await input.mark({ status: "running", stage, endedAt: null });
  await input.recordStage(stage, { startedAt, endedAt: null, severity: "info" });

  if (!input.repositories.graph) {
    await input.recordStage(stage, {
      startedAt: null,
      endedAt: input.progressClock(),
      severity: "info"
    });
    return {
      affectedSourceFileIds: [input.source.id],
      edgeIds: [],
      removedEdgeIds: []
    };
  }

  let affectedSourceFileIds = [input.source.id];
  let edgeIds: string[] = [];
  let removedEdgeIds: string[] = [];

  try {
    graphLockAcquired = await input.redis.acquireSourceFileGraphLock(
      input.source.id,
      input.ownerId,
      input.ttlSeconds
    );

    if (!graphLockAcquired) {
      throw new Error("Source file graph lock was not acquired");
    }

    await input.redis.recordSourceFileGraphState(
      { knowledgeBaseId: input.knowledgeBaseId, sourceFileId: input.source.id },
      {
        knowledgeBaseId: input.knowledgeBaseId,
        status: "running",
        startedAt
      },
      input.ttlSeconds
    );

    const graphResult = await buildSourceFileGraph({
      graph: input.repositories.graph,
      knowledgeBaseId: input.knowledgeBaseId,
      source: input.source,
      metadata: input.metadata,
      body: input.body,
      suggestions: input.suggestions,
      pageSize: input.pageSize,
      ...(input.maxCandidateNodes ? { maxCandidateNodes: input.maxCandidateNodes } : {}),
      ...(input.acceptedEdgeLimit ? { acceptedEdgeLimit: input.acceptedEdgeLimit } : {}),
      ...(input.genericPhraseThreshold
        ? { genericPhraseThreshold: input.genericPhraseThreshold }
        : {}),
      modelConfirmation: input.modelAssistance
        ? {
            client: input.modelAssistance.client,
            modelName: input.modelAssistance.modelName,
            contextWindowTokens: input.modelAssistance.contextWindowTokens,
            receiveTimeouts: input.modelAssistance.receiveTimeouts
          }
        : null,
      ...(input.graphQueryBudget ? { graphQueryBudget: input.graphQueryBudget } : {}),
      ...(input.databaseMutationBudget
        ? { databaseMutationBudget: input.databaseMutationBudget }
        : {})
    });
    affectedSourceFileIds = graphResult.affectedSourceFileIds;
    edgeIds = graphResult.edgeIds;
    removedEdgeIds = graphResult.removedEdgeIds;
    severity = graphResult.warnings.length > 0 ? "warning" : "info";

    await input.redis.recordSourceFileGraphState(
      { knowledgeBaseId: input.knowledgeBaseId, sourceFileId: input.source.id },
      {
        knowledgeBaseId: input.knowledgeBaseId,
        status: "completed",
        edgeCount: graphResult.edgeCount,
        endedAt: input.progressClock()
      },
      input.ttlSeconds
    );

  } catch (error) {
    await input.redis
      .recordSourceFileGraphState(
        { knowledgeBaseId: input.knowledgeBaseId, sourceFileId: input.source.id },
        {
          knowledgeBaseId: input.knowledgeBaseId,
          status: "failed",
          errorCode: "GRAPH_GENERATION_FAILED",
          endedAt: input.progressClock()
        },
        input.ttlSeconds
      )
      .catch(() => undefined);
    throw error;
  } finally {
    if (graphLockAcquired) {
      await input.redis.releaseSourceFileGraphLock(input.source.id, input.ownerId);
    }
  }

  await input.recordStage(stage, {
    startedAt: null,
    endedAt: input.progressClock(),
    severity
  });

  return { affectedSourceFileIds, edgeIds, removedEdgeIds };
}
