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
}): Promise<{
  affectedSourceFileIds: string[];
  edgeIds: string[];
  removedEdgeIds: string[];
}> {
  const stage: SourceFileProcessingStage = "graph_generation";
  const startedAt = input.progressClock();
  let graphJobId: string | null = null;
  let graphLockAcquired = false;

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

    const graphJob = await input.repositories.graph.createGraphJob?.({
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFileId: input.source.id,
      startedAt
    });
    graphJobId = graphJob?.id ?? null;
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
        : null
    });
    affectedSourceFileIds = graphResult.affectedSourceFileIds;
    edgeIds = graphResult.edgeIds;
    removedEdgeIds = graphResult.removedEdgeIds;

    if (graphJobId) {
      await input.repositories.graph.completeGraphJob?.({
        id: graphJobId,
        status: "completed",
        endedAt: input.progressClock(),
        errorCode: null
      });
    }

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

    if (graphResult.warnings.length > 0) {
      await input.recordStage(stage, {
        startedAt: null,
        endedAt: input.progressClock(),
        severity: "warning"
      });
    }
  } catch (error) {
    if (graphJobId) {
      await input.repositories.graph.completeGraphJob?.({
        id: graphJobId,
        status: "failed",
        endedAt: input.progressClock(),
        errorCode: "GRAPH_GENERATION_FAILED"
      });
    }
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
    severity: "info"
  });

  return { affectedSourceFileIds, edgeIds, removedEdgeIds };
}
