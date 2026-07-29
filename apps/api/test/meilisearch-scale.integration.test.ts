import { mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import {
  createMeilisearchTransport
} from "../src/infrastructure/meilisearch/meilisearch-transport.js";
import {
  SEARCH_CONTENT_SCHEMA_VERSION
} from "../src/search/content-segment-mapper.js";
import {
  SEARCH_GRAPH_SEED_SCHEMA_VERSION
} from "../src/search/graph-seed-mapper.js";
import {
  createSearchIndexDefinition
} from "../src/search/index-definitions.js";
import {
  createSearchIndexManager
} from "../src/search/search-index-manager.js";
import {
  createSearchRetrieval
} from "../src/search/search-retrieval.js";

const configuredEndpoint = process.env.FOCOWIKI_TEST_MEILISEARCH_URL;
const configuredApiKey = process.env.FOCOWIKI_TEST_MEILISEARCH_API_KEY;
const endpoint = configuredEndpoint ?? "http://127.0.0.1:7700";
const apiKey = configuredApiKey ?? "unused-test-key";
const metricsApiKey =
  process.env.FOCOWIKI_TEST_MEILISEARCH_METRICS_API_KEY ?? apiKey;
const describeScale = configuredEndpoint
  && configuredApiKey
  && process.env.FOCOWIKI_RUN_MEILISEARCH_SCALE_TESTS === "true"
  ? describe
  : describe.skip;

describeScale("Meilisearch 100k scale integration", () => {
  const runId = randomUUID().replaceAll("-", "");
  const indexPrefix = `focowiki_scale_${runId}`;
  const knowledgeBaseId = "kb-meilisearch-scale";
  const transport = createMeilisearchTransport({
    endpoint,
    apiKey,
    metricsApiKey,
    timeoutMs: 10_000,
    maxAttempts: 3,
    retryDelayMs: 50
  });
  const manager = createSearchIndexManager({
    transport,
    pollIntervalMs: 25,
    taskTimeoutMs: 120_000
  });
  const content = createSearchIndexDefinition({
    indexPrefix,
    knowledgeBaseId,
    kind: "content",
    pendingEpoch: 1,
    searchCutoffMs: 1_000
  });
  const graph = createSearchIndexDefinition({
    indexPrefix,
    knowledgeBaseId,
    kind: "graph",
    pendingEpoch: 1,
    searchCutoffMs: 1_000
  });
  const report: {
    generatedAt: string;
    scales: Array<Record<string, unknown>>;
    concurrentSearch: Record<string, unknown> | null;
    pressure: Record<string, unknown> | null;
  } = {
    generatedAt: new Date().toISOString(),
    scales: [],
    concurrentSearch: null,
    pressure: null
  };

  afterAll(async () => {
    for (const uid of [
      content.activeUid,
      content.stagingUid,
      graph.activeUid,
      graph.stagingUid
    ]) {
      await manager.deleteIndexIfPresent(uid).catch(() => undefined);
    }
  });

  it("indexes and queries 10k and 100k generic source-backed files", async () => {
    await manager.prepareStagingIndex({
      indexUid: content.stagingUid,
      primaryKey: content.primaryKey,
      settings: content.settings,
      settingsChecksum: content.settingsChecksum,
      buildId: `${content.stagingUid}:scale`
    });
    await manager.prepareStagingIndex({
      indexUid: graph.stagingUid,
      primaryKey: graph.primaryKey,
      settings: graph.settings,
      settingsChecksum: graph.settingsChecksum,
      buildId: `${graph.stagingUid}:scale`
    });

    let indexed = 0;
    for (const target of [10_000, 100_000]) {
      const indexingStartedAt = performance.now();
      for (let start = indexed; start < target; start += 1_000) {
        const end = Math.min(target, start + 1_000);
        const [contentTask, graphTask] = await Promise.all([
          transport.addDocuments({
            indexUid: content.stagingUid,
            primaryKey: content.primaryKey,
            correlation: `scale-content-${start}-${end}`,
            documents: createContentDocuments(start, end)
          }),
          transport.addDocuments({
            indexUid: graph.stagingUid,
            primaryKey: graph.primaryKey,
            correlation: `scale-graph-${start}-${end}`,
            documents: createGraphDocuments(start, end)
          })
        ]);
        await Promise.all([
          manager.waitForTask(contentTask.taskUid),
          manager.waitForTask(graphTask.taskUid)
        ]);
      }
      const indexingDurationMs = performance.now() - indexingStartedAt;
      indexed = target;
      const queryEvidence = await runQueryMatrix({
        indexUid: content.stagingUid,
        graphIndexUid: graph.stagingUid,
        targetFile: target - 1
      });
      report.scales.push({
        fileCount: target,
        indexingDurationMs,
        indexedFilesPerSecond: (target === 10_000 ? 10_000 : 90_000)
          / (indexingDurationMs / 1_000),
        queries: queryEvidence
      });
    }

    await manager.activateStagingIndexes([
      {
        activeUid: content.activeUid,
        stagingUid: content.stagingUid,
        primaryKey: content.primaryKey,
        buildId: `${content.stagingUid}:scale`
      },
      {
        activeUid: graph.activeUid,
        stagingUid: graph.stagingUid,
        primaryKey: graph.primaryKey,
        buildId: `${graph.stagingUid}:scale`
      }
    ]);

    const retrieval = createSearchRetrieval({
      transport,
      indexPrefix,
      branchCandidateLimit: 100,
      fusedCandidateLimit: 200,
      cropLength: 240
    });
    const exactResult = await retrieval.searchContent({
      knowledgeBaseId,
      activeEpoch: 1,
      query: "Exact Architecture Handbook 99999",
      limit: 20,
      cursor: null
    });
    expect(exactResult.items[0]).toMatchObject({
      sourceFileId: "source-scale-99999",
      logicalPath: "pages/scale/99999/architecture-handbook.md",
      exactPriority: 2
    });

    const concurrencyStartedAt = performance.now();
    const concurrentResults = await Promise.all(
      Array.from({ length: 64 }, (_, index) => {
        const query = index % 4 === 0
          ? "分布式系统 一致性"
          : index % 4 === 1
            ? "OpenAPI 中文 retrieval"
            : index % 4 === 2
              ? "event driven publication"
              : `Knowledge Document ${90_000 + index}`;
        const startedAt = performance.now();
        return retrieval.searchContent({
          knowledgeBaseId,
          activeEpoch: 1,
          query,
          limit: 20,
          cursor: null
        }).then((result) => ({
          durationMs: performance.now() - startedAt,
          resultCount: result.items.length
        }));
      })
    );
    const durations = concurrentResults
      .map((item) => item.durationMs)
      .sort((left, right) => left - right);
    const p95 = durations[Math.floor(durations.length * 0.95)] ?? 0;
    report.concurrentSearch = {
      requestCount: concurrentResults.length,
      totalDurationMs: performance.now() - concurrencyStartedAt,
      p95DurationMs: p95,
      maxDurationMs: durations.at(-1) ?? 0,
      emptyResultCount: concurrentResults.filter((item) =>
        item.resultCount === 0
      ).length
    };
    report.pressure = await transport.getPressure();

    expect(p95).toBeLessThan(3_000);
    expect(concurrentResults.every((item) => item.resultCount > 0)).toBe(true);
    await writeReport(report);
  }, 900_000);

  async function runQueryMatrix(input: {
    indexUid: string;
    graphIndexUid: string;
    targetFile: number;
  }): Promise<Record<string, unknown>> {
    const queries = [
      {
        name: "exact_title",
        indexUid: input.indexUid,
        query: `Exact Architecture Handbook ${input.targetFile}`,
        attributesToSearchOn: ["title"]
      },
      {
        name: "exact_path",
        indexUid: input.indexUid,
        query: `pages scale ${input.targetFile} architecture handbook md`,
        attributesToSearchOn: ["logicalPath"]
      },
      {
        name: "chinese_multi_term",
        indexUid: input.indexUid,
        query: "分布式系统 一致性 故障恢复"
      },
      {
        name: "mixed_script",
        indexUid: input.indexUid,
        query: "OpenAPI 中文 retrieval"
      },
      {
        name: "phrase",
        indexUid: input.indexUid,
        query: "event driven publication pipeline"
      },
      {
        name: "typo",
        indexUid: input.indexUid,
        query: "resilient retrievel pipeline",
        matchingStrategy: "last" as const
      },
      {
        name: "broad",
        indexUid: input.indexUid,
        query: "common"
      },
      {
        name: "graph_seed",
        indexUid: input.graphIndexUid,
        query: `dependency route ${input.targetFile}`
      }
    ];
    const evidence: Record<string, unknown> = {};
    for (const query of queries) {
      const startedAt = performance.now();
      const result = await transport.search({
        indexUid: query.indexUid,
        query: query.query,
        filter: [
          `knowledgeBaseId = ${JSON.stringify(knowledgeBaseId)}`,
          "visibleFromEpoch <= 1",
          "(visibleUntilEpoch IS NULL OR visibleUntilEpoch > 1)",
          `schemaVersion = ${JSON.stringify(
            query.indexUid === input.graphIndexUid
              ? SEARCH_GRAPH_SEED_SCHEMA_VERSION
              : SEARCH_CONTENT_SCHEMA_VERSION
          )}`
        ].join(" AND "),
        limit: 50,
        ...(query.attributesToSearchOn
          ? { attributesToSearchOn: query.attributesToSearchOn }
          : {}),
        attributesToRetrieve: [
          "sourceFileId",
          "sourceRevisionId",
          "logicalPath",
          "title"
        ],
        attributesToCrop: [],
        cropLength: 20,
        matchingStrategy: query.matchingStrategy ?? "all",
        distinct: "sourceFileId"
      });
      expect(result.hits.length, query.name).toBeGreaterThan(0);
      expect(result.hits.length, query.name).toBeLessThanOrEqual(50);
      evidence[query.name] = {
        wallDurationMs: performance.now() - startedAt,
        engineDurationMs: result.processingTimeMs,
        resultCount: result.hits.length,
        estimatedTotalHits: result.estimatedTotalHits,
        firstSourceFileId: result.hits[0]?.sourceFileId ?? null
      };
    }

    const [firstPage, secondPage] = await Promise.all([
      transport.search(pageRequest(input.indexUid, 0)),
      transport.search(pageRequest(input.indexUid, 50))
    ]);
    const firstIds = new Set(firstPage.hits.map((hit) => hit.sourceFileId));
    expect(secondPage.hits.some((hit) => firstIds.has(hit.sourceFileId))).toBe(false);
    evidence.pagination = {
      firstPage: firstPage.hits.length,
      secondPage: secondPage.hits.length,
      duplicates: 0
    };
    return evidence;
  }

  function pageRequest(indexUid: string, offset: number) {
    return {
      indexUid,
      query: "common",
      filter: [
        `knowledgeBaseId = ${JSON.stringify(knowledgeBaseId)}`,
        "visibleFromEpoch <= 1",
        "(visibleUntilEpoch IS NULL OR visibleUntilEpoch > 1)",
        `schemaVersion = ${JSON.stringify(SEARCH_CONTENT_SCHEMA_VERSION)}`
      ].join(" AND "),
      limit: 50,
      offset,
      attributesToRetrieve: ["sourceFileId"],
      attributesToCrop: [],
      cropLength: 20,
      matchingStrategy: "all" as const,
      distinct: "sourceFileId"
    };
  }

  function createContentDocuments(start: number, end: number) {
    return Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      return {
        id: `content-scale-${index}`,
        knowledgeBaseId,
        sourceFileId: `source-scale-${index}`,
        sourceRevisionId: `revision-scale-${index}`,
        logicalPath: `pages/scale/${index}/architecture-handbook.md`,
        fileKind: "page",
        title: index === 99_999 || index === 9_999
          ? `Exact Architecture Handbook ${index}`
          : `Knowledge Document ${index}`,
        headingPath: ["Architecture", `Section ${index % 100}`],
        body: [
          "common source-backed knowledge content",
          "event driven publication pipeline",
          "resilient retrieval pipeline",
          "分布式系统 一致性 故障恢复",
          "OpenAPI 中文 retrieval",
          index === 99_999 || index === 9_999
            ? `late body quantum retrieval anchor ${index}`
            : `document evidence ${index}`
        ].join(" "),
        metadataText: `generic knowledge ${index % 20}`,
        sourceUrl: `https://example.test/documents/${index}`,
        checksumSha256: index.toString(16).padStart(64, "0"),
        segmentOrdinal: 0,
        segmentTotal: 1,
        visibleFromEpoch: 1,
        visibleUntilEpoch: null,
        schemaVersion: SEARCH_CONTENT_SCHEMA_VERSION
      };
    });
  }

  function createGraphDocuments(start: number, end: number) {
    return Array.from({ length: end - start }, (_, offset) => {
      const index = start + offset;
      return {
        id: `graph-scale-${index}`,
        knowledgeBaseId,
        sourceFileId: `source-scale-${index}`,
        sourceRevisionId: `revision-scale-${index}`,
        logicalPath: `pages/scale/${index}/architecture-handbook.md`,
        title: `Knowledge Document ${index}`,
        lexicalText: `common relationship dependency route ${index}`,
        phraseTerms: [`dependency route ${index}`],
        exactTerms: [`source ${index}`],
        explicitReferences: index > 0 ? [`source-scale-${index - 1}`] : [],
        sourceUrl: `https://example.test/documents/${index}`,
        fingerprint: index.toString(16).padStart(64, "0"),
        visibleFromEpoch: 1,
        visibleUntilEpoch: null,
        schemaVersion: SEARCH_GRAPH_SEED_SCHEMA_VERSION
      };
    });
  }
});

async function writeReport(report: Record<string, unknown>): Promise<void> {
  const directory = resolve(
    process.cwd(),
    "ReferenceDocs/validate-meilisearch-search"
  );
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, "meilisearch-scale.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
}
