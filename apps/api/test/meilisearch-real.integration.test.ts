import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMeilisearchTransport
} from "../src/infrastructure/meilisearch/meilisearch-transport.js";
import {
  createSearchIndexDefinition
} from "../src/search/index-definitions.js";
import {
  createSearchIndexManager
} from "../src/search/search-index-manager.js";

const configuredEndpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const configuredApiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const configuredMetricsApiKey =
  process.env.FOCOWIKI_TEST_MEILISEARCH_METRICS_API_KEY;
const endpoint = configuredEndpoint ?? "http://127.0.0.1:7700";
const apiKey = configuredApiKey ?? "unused-test-key";
const describeReal = configuredEndpoint && configuredApiKey ? describe : describe.skip;
const indexPrefix = `focowiki_test_${randomUUID().replaceAll("-", "")}`;
const createdIndexes: string[] = [];

describeReal("real Meilisearch integration", () => {
  const transport = createMeilisearchTransport({
    endpoint,
    apiKey,
    metricsApiKey: configuredMetricsApiKey ?? apiKey,
    timeoutMs: 5_000,
    maxAttempts: 2,
    retryDelayMs: 25
  });
  const manager = createSearchIndexManager({
    transport,
    pollIntervalMs: 25,
    taskTimeoutMs: 15_000
  });
  const content = createSearchIndexDefinition({
    indexPrefix,
    knowledgeBaseId: "kb-real-integration",
    kind: "content",
    pendingEpoch: 1,
    searchCutoffMs: 1_000
  });
  const graph = createSearchIndexDefinition({
    indexPrefix,
    knowledgeBaseId: "kb-real-integration",
    kind: "graph",
    pendingEpoch: 1,
    searchCutoffMs: 1_000
  });
  createdIndexes.push(
    content.activeUid,
    content.stagingUid,
    graph.activeUid,
    graph.stagingUid
  );

  afterAll(async () => {
    for (const indexUid of createdIndexes) {
      await manager.deleteIndexIfPresent(indexUid).catch(() => undefined);
    }
  });

  it("configures, indexes, queries, swaps, replays, and deletes documents", async () => {
    await expect(transport.health()).resolves.toEqual({ available: true });
    await expect(transport.getPressure()).resolves.toEqual({
      queueLatencyMs: expect.any(Number),
      residentMemoryBytes: expect.any(Number),
      databaseSizeBytes: expect.any(Number),
      taskQueueSizeBytes: expect.any(Number)
    });

    await manager.prepareStagingIndex({
      indexUid: content.stagingUid,
      primaryKey: content.primaryKey,
      settings: content.settings,
      settingsChecksum: content.settingsChecksum,
      buildId: `${content.stagingUid}:generation-one`
    });
    await manager.prepareStagingIndex({
      indexUid: graph.stagingUid,
      primaryKey: graph.primaryKey,
      settings: graph.settings,
      settingsChecksum: graph.settingsChecksum,
      buildId: `${graph.stagingUid}:generation-one`
    });

    const contentTask = await transport.addDocuments({
      indexUid: content.stagingUid,
      primaryKey: content.primaryKey,
      correlation: "real-content-batch",
      documents: [{
        id: "content-segment-one",
        knowledgeBaseId: "kb-real-integration",
        sourceFileId: "source-one",
        sourceRevisionId: "revision-one",
        logicalPath: "pages/contracts/example.md",
        fileKind: "page",
        title: "Employment Contract Guide",
        headingPath: ["Terms"],
        body: "劳动 合同 employment contract termination notice",
        sourceUrl: "https://example.com/contracts",
        visibleFromEpoch: 1,
        visibleUntilEpoch: null,
        schemaVersion: content.schemaVersion
      }]
    });
    await manager.waitForTask(contentTask.taskUid);
    await expect(transport.findTaskByCorrelation?.({
      indexUid: content.stagingUid,
      correlation: "real-content-batch"
    })).resolves.toEqual({
      taskUid: contentTask.taskUid,
      status: "succeeded",
      errorCode: null
    });

    const graphTask = await transport.addDocuments({
      indexUid: graph.stagingUid,
      primaryKey: graph.primaryKey,
      correlation: "real-graph-batch",
      documents: [{
        id: "graph-seed-one",
        knowledgeBaseId: "kb-real-integration",
        sourceFileId: "source-one",
        sourceRevisionId: "revision-one",
        logicalPath: "pages/contracts/example.md",
        title: "Employment Contract Guide",
        lexicalText: "劳动 合同 employment contract",
        phraseTerms: ["employment contract"],
        exactTerms: ["劳动合同"],
        explicitReferences: [],
        visibleFromEpoch: 1,
        visibleUntilEpoch: null,
        schemaVersion: graph.schemaVersion
      }]
    });
    await manager.waitForTask(graphTask.taskUid);

    const staged = await transport.search({
      indexUid: content.stagingUid,
      query: "劳动 合同",
      filter: [
        'knowledgeBaseId = "kb-real-integration"',
        "visibleFromEpoch <= 1",
        "(visibleUntilEpoch IS NULL OR visibleUntilEpoch > 1)",
        `schemaVersion = ${JSON.stringify(content.schemaVersion)}`
      ].join(" AND "),
      limit: 10,
      attributesToRetrieve: ["sourceFileId", "logicalPath", "title"],
      attributesToCrop: [],
      cropLength: 20,
      matchingStrategy: "all",
      distinct: "sourceFileId"
    });
    expect(staged.hits).toEqual([
      expect.objectContaining({
        sourceFileId: "source-one",
        logicalPath: "pages/contracts/example.md"
      })
    ]);

    const activations = [{
      activeUid: content.activeUid,
      stagingUid: content.stagingUid,
      primaryKey: content.primaryKey,
      buildId: `${content.stagingUid}:generation-one`
    }, {
      activeUid: graph.activeUid,
      stagingUid: graph.stagingUid,
      primaryKey: graph.primaryKey,
      buildId: `${graph.stagingUid}:generation-one`
    }];
    const activationTask = await manager.submitStagingIndexActivation(activations);
    expect(activationTask).not.toBeNull();
    await expect(transport.findIndexSwapTask?.({
      pairs: activations.map((activation) => ({
        left: activation.activeUid,
        right: activation.stagingUid
      }))
    })).resolves.toEqual({
      taskUid: activationTask!.taskUid,
      status: expect.stringMatching(/^(enqueued|processing|succeeded)$/u),
      errorCode: null
    });
    await manager.waitForTask(activationTask!.taskUid);
    await manager.assertStagingIndexesActivated(activations);
    await manager.activateStagingIndexes(activations);

    const active = await transport.search({
      indexUid: content.activeUid,
      query: "employment contract",
      filter: 'knowledgeBaseId = "kb-real-integration"',
      limit: 10,
      attributesToRetrieve: ["sourceFileId"],
      attributesToCrop: [],
      cropLength: 20,
      matchingStrategy: "all",
      distinct: "sourceFileId"
    });
    expect(active.hits).toEqual([
      expect.objectContaining({ sourceFileId: "source-one" })
    ]);

    const deletion = await transport.deleteDocuments({
      indexUid: content.activeUid,
      filter: 'knowledgeBaseId = "kb-real-integration"',
      correlation: "real-delete"
    });
    await manager.waitForTask(deletion.taskUid);
    const deleted = await transport.search({
      indexUid: content.activeUid,
      query: "employment",
      filter: 'knowledgeBaseId = "kb-real-integration"',
      limit: 10,
      attributesToRetrieve: ["sourceFileId"],
      attributesToCrop: [],
      cropLength: 20,
      matchingStrategy: "all"
    });
    expect(deleted.hits).toEqual([]);
  });

  it("maps an invalid credential without exposing it", async () => {
    const invalidCredential = "invalid-real-integration-key";
    const invalid = createMeilisearchTransport({
      endpoint,
      apiKey: invalidCredential,
      timeoutMs: 2_000,
      maxAttempts: 1,
      retryDelayMs: 1
    });

    await expect(invalid.createIndex({
      indexUid: `${indexPrefix}_unauthorized`,
      primaryKey: "id"
    })).rejects.toMatchObject({
      code: "SEARCH_ENGINE_AUTHENTICATION_FAILED",
      retryable: false
    });
    await expect(invalid.createIndex({
      indexUid: `${indexPrefix}_unauthorized_two`,
      primaryKey: "id"
    })).rejects.not.toThrow(invalidCredential);
  });

  it("reports a real asynchronous document task failure safely", async () => {
    const failedIndexUid = `${indexPrefix}_failed_task`;
    createdIndexes.push(failedIndexUid);
    const creation = await transport.createIndex({
      indexUid: failedIndexUid,
      primaryKey: "customId"
    });
    await manager.waitForTask(creation.taskUid);

    const submission = await transport.addDocuments({
      indexUid: failedIndexUid,
      primaryKey: "customId",
      documents: [{ id: "missing-custom-primary-key" }],
      correlation: "real-failed-task"
    });
    await expect(manager.waitForTask(submission.taskUid)).rejects.toMatchObject({
      code: "SEARCH_INDEX_TASK_FAILED",
      message: "Search index task did not complete"
    });
    await expect(transport.getTask(submission.taskUid)).resolves.toEqual({
      taskUid: submission.taskUid,
      status: "failed",
      errorCode: "SEARCH_INDEX_TASK_FAILED"
    });
  });
});
