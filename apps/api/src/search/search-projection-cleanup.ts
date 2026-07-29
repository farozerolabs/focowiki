import type {
  SearchEngineTransport
} from "../application/ports/search-engine-transport.js";
import type {
  SearchProjectionStateRepository
} from "../application/ports/search-projection-state-repository.js";
import {
  createStableSearchIndexUid,
  createStagingSearchIndexUid
} from "./index-definitions.js";
import { createSearchIndexManager } from "./search-index-manager.js";

export type SearchProjectionCleanup = {
  deleteKnowledgeBase(input: {
    knowledgeBaseId: string;
    correlation: string;
  }): Promise<void>;
};

export function createSearchProjectionCleanup(input: {
  transport: SearchEngineTransport;
  states: Pick<SearchProjectionStateRepository, "getState">;
  indexPrefix: string;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
}): SearchProjectionCleanup {
  const manager = createSearchIndexManager({
    transport: input.transport,
    pollIntervalMs: input.taskPollIntervalMs,
    taskTimeoutMs: input.taskTimeoutMs
  });

  return {
    async deleteKnowledgeBase(request) {
      const state = await input.states.getState(request.knowledgeBaseId);
      for (const kind of ["content", "graph"] as const) {
        const activeUid = createStableSearchIndexUid({
          indexPrefix: input.indexPrefix,
          knowledgeBaseId: request.knowledgeBaseId,
          kind
        });
        await manager.deleteIndexIfPresent(activeUid);
        if (state?.pendingEpoch === null || state?.pendingEpoch === undefined) {
          continue;
        }
        await manager.deleteIndexIfPresent(createStagingSearchIndexUid({
          indexPrefix: input.indexPrefix,
          knowledgeBaseId: request.knowledgeBaseId,
          kind,
          pendingEpoch: state.pendingEpoch
        }));
      }
    }
  };
}
