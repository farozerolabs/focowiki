import type {
  SearchEngineSettings,
  SearchEngineTransport
} from "../application/ports/search-engine-transport.js";
import { createSearchIndexSettingsChecksum } from "./index-definitions.js";

export class SearchIndexManagerError extends Error {
  public constructor(
    public readonly code:
      | "SEARCH_INDEX_INCOMPATIBLE"
      | "SEARCH_INDEX_TASK_FAILED"
      | "SEARCH_INDEX_TASK_TIMEOUT",
    message: string
  ) {
    super(message);
    this.name = "SearchIndexManagerError";
  }
}

export type SearchIndexManager = {
  settingsChecksum(settings: SearchEngineSettings): string;
  prepareStagingIndex(input: {
    indexUid: string;
    primaryKey: string;
    settings: SearchEngineSettings;
    settingsChecksum: string;
    buildId: string;
  }): Promise<void>;
  assertActiveIndex(input: {
    indexUid: string;
    primaryKey: string;
    settingsChecksum: string;
  }): Promise<void>;
  submitStagingIndexActivation(
    input: SearchIndexActivation[]
  ): Promise<{ taskUid: number } | null>;
  assertStagingIndexesActivated(input: SearchIndexActivation[]): Promise<void>;
  activateStagingIndexes(input: SearchIndexActivation[]): Promise<void>;
  deleteIndexIfPresent(indexUid: string): Promise<void>;
  waitForTask(taskUid: number): Promise<void>;
};

export type SearchIndexActivation = {
  activeUid: string;
  stagingUid: string;
  primaryKey: string;
  buildId: string;
};

export function createSearchIndexManager(input: {
  transport: SearchEngineTransport;
  pollIntervalMs: number;
  taskTimeoutMs: number;
  sleep?: (milliseconds: number) => Promise<void>;
}): SearchIndexManager {
  const buildMarkerId = "__focowiki_index_build__";
  const sleep = input.sleep ?? wait;

  async function waitForTask(taskUid: number): Promise<void> {
    const deadline = Date.now() + input.taskTimeoutMs;
    while (Date.now() <= deadline) {
      const task = await input.transport.getTask(taskUid);
      if (task.status === "succeeded") return;
      if (
        task.status === "failed"
        || task.status === "canceled"
        || task.status === "unknown"
      ) {
        throw new SearchIndexManagerError(
          "SEARCH_INDEX_TASK_FAILED",
          "Search index task did not complete"
        );
      }
      await sleep(input.pollIntervalMs);
    }
    throw new SearchIndexManagerError(
      "SEARCH_INDEX_TASK_TIMEOUT",
      "Search index task timed out"
    );
  }

  return {
    settingsChecksum: createSearchIndexSettingsChecksum,

    async prepareStagingIndex(preparation) {
      let existing = await input.transport.getIndex({
        indexUid: preparation.indexUid
      });
      if (existing && existing.primaryKey !== preparation.primaryKey) {
        throw new SearchIndexManagerError(
          "SEARCH_INDEX_INCOMPATIBLE",
          "Search index primary key is incompatible"
        );
      }
      if (existing) {
        const marker = await input.transport.getDocument({
          indexUid: preparation.indexUid,
          documentId: buildMarkerId
        });
        if (marker?.buildId !== preparation.buildId) {
          const deleted = await input.transport.deleteIndex(preparation.indexUid);
          await waitForTask(deleted.taskUid);
          existing = null;
        }
      }
      if (!existing) {
        const created = await input.transport.createIndex({
          indexUid: preparation.indexUid,
          primaryKey: preparation.primaryKey
        });
        await waitForTask(created.taskUid);
      }

      const settingsTask = await input.transport.updateSettings({
        indexUid: preparation.indexUid,
        settings: preparation.settings
      });
      await waitForTask(settingsTask.taskUid);
      const applied = await input.transport.getSettings(preparation.indexUid);
      if (
        createSearchIndexSettingsChecksum(applied)
        !== preparation.settingsChecksum
      ) {
        throw new SearchIndexManagerError(
          "SEARCH_INDEX_INCOMPATIBLE",
          "Search index settings verification failed"
        );
      }
      const markerTask = await input.transport.addDocuments({
        indexUid: preparation.indexUid,
        primaryKey: preparation.primaryKey,
        documents: [{
          id: buildMarkerId,
          buildId: preparation.buildId,
          knowledgeBaseId: "__focowiki_internal__",
          visibleFromEpoch: Number.MAX_SAFE_INTEGER,
          visibleUntilEpoch: Number.MAX_SAFE_INTEGER,
          schemaVersion: "__focowiki_internal__"
        }],
        correlation: `search-index-build:${preparation.buildId}`
      });
      await waitForTask(markerTask.taskUid);
    },

    async assertActiveIndex(assertion) {
      const active = await input.transport.getIndex({
        indexUid: assertion.indexUid
      });
      if (!active || active.primaryKey !== assertion.primaryKey) {
        throw new SearchIndexManagerError(
          "SEARCH_INDEX_INCOMPATIBLE",
          "Active search index is unavailable"
        );
      }
      const settings = await input.transport.getSettings(assertion.indexUid);
      if (
        createSearchIndexSettingsChecksum(settings)
        !== assertion.settingsChecksum
      ) {
        throw new SearchIndexManagerError(
          "SEARCH_INDEX_INCOMPATIBLE",
          "Active search index settings are incompatible"
        );
      }
    },

    async submitStagingIndexActivation(activations) {
      const pendingPairs: Array<{ left: string; right: string }> = [];
      for (const activation of activations) {
        let active = await input.transport.getIndex({
          indexUid: activation.activeUid
        });
        if (active && active.primaryKey !== activation.primaryKey) {
          throw new SearchIndexManagerError(
            "SEARCH_INDEX_INCOMPATIBLE",
            "Active search index primary key is incompatible"
          );
        }
        if (!active) {
          const created = await input.transport.createIndex({
            indexUid: activation.activeUid,
            primaryKey: activation.primaryKey
          });
          await waitForTask(created.taskUid);
          active = {
            uid: activation.activeUid,
            primaryKey: activation.primaryKey
          };
        }
        const activeMarker = await input.transport.getDocument({
          indexUid: activation.activeUid,
          documentId: buildMarkerId
        });
        if (activeMarker?.buildId === activation.buildId) continue;

        const staging = await input.transport.getIndex({
          indexUid: activation.stagingUid
        });
        if (!staging || staging.primaryKey !== activation.primaryKey) {
          throw new SearchIndexManagerError(
            "SEARCH_INDEX_INCOMPATIBLE",
            "Search staging index is unavailable"
          );
        }
        const stagingMarker = await input.transport.getDocument({
          indexUid: activation.stagingUid,
          documentId: buildMarkerId
        });
        if (stagingMarker?.buildId !== activation.buildId) {
          throw new SearchIndexManagerError(
            "SEARCH_INDEX_INCOMPATIBLE",
            "Search staging index build is incompatible"
          );
        }
        pendingPairs.push({
          left: activation.activeUid,
          right: activation.stagingUid
        });
      }
      if (pendingPairs.length > 0) {
        const recovered = await input.transport.findIndexSwapTask?.({
          pairs: pendingPairs
        });
        if (recovered) return { taskUid: recovered.taskUid };
        return input.transport.swapIndexes({
          pairs: pendingPairs
        });
      }
      return null;
    },

    async assertStagingIndexesActivated(activations) {
      for (const activation of activations) {
        const marker = await input.transport.getDocument({
          indexUid: activation.activeUid,
          documentId: buildMarkerId
        });
        if (marker?.buildId !== activation.buildId) {
          throw new SearchIndexManagerError(
            "SEARCH_INDEX_INCOMPATIBLE",
            "Search index activation verification failed"
          );
        }
      }
    },

    async activateStagingIndexes(activations) {
      const task = await this.submitStagingIndexActivation(activations);
      if (task) await waitForTask(task.taskUid);
      await this.assertStagingIndexesActivated(activations);
    },

    async deleteIndexIfPresent(indexUid) {
      const existing = await input.transport.getIndex({ indexUid });
      if (!existing) return;
      const deleted = await input.transport.deleteIndex(indexUid);
      await waitForTask(deleted.taskUid);
    },

    waitForTask
  };
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
