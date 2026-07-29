import type {
  SearchEngineTransport
} from "../application/ports/search-engine-transport.js";
import {
  createSearchIndexDefinition
} from "./index-definitions.js";
import {
  createSearchIndexManager,
  SearchIndexManagerError,
  type SearchIndexManager
} from "./search-index-manager.js";

export async function activeSearchProjectionNeedsRebuild(input: {
  transport: SearchEngineTransport;
  indexPrefix: string;
  knowledgeBaseId: string;
  activeEpoch: number;
  searchCutoffMs: number;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  manager?: Pick<SearchIndexManager, "assertActiveIndex">;
}): Promise<boolean> {
  if (input.activeEpoch < 1) return true;
  const manager = input.manager ?? createSearchIndexManager({
    transport: input.transport,
    pollIntervalMs: input.pollIntervalMs,
    taskTimeoutMs: input.taskTimeoutMs
  });

  try {
    await Promise.all((["content", "graph"] as const).map(async (kind) => {
      const definition = createSearchIndexDefinition({
        indexPrefix: input.indexPrefix,
        knowledgeBaseId: input.knowledgeBaseId,
        kind,
        pendingEpoch: input.activeEpoch + 1,
        searchCutoffMs: input.searchCutoffMs
      });
      await manager.assertActiveIndex({
        indexUid: definition.activeUid,
        primaryKey: definition.primaryKey,
        settingsChecksum: definition.settingsChecksum
      });
    }));
    return false;
  } catch (error) {
    if (
      error instanceof SearchIndexManagerError
      && error.code === "SEARCH_INDEX_INCOMPATIBLE"
    ) {
      return true;
    }
    throw error;
  }
}
