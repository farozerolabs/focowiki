export type StorageVnextFullRestoreProjection = {
  knowledgeBaseId: string;
  projectionRole: string;
  state: string;
  providerIndexUid: string;
  documentCount: number | string;
};

export type StorageVnextFullRestoreSearchSettings = {
  engineSearchCutoffMs: number;
  indexBatchDocumentCount: number;
  indexBatchCompressedBytes: number;
  taskPollIntervalMs: number;
  taskTimeoutMs: number;
};

export type StorageVnextFullRestoreRebuildPlan = {
  knowledgeBaseId: string;
  providerIndexUid: string;
  expectedDocumentCount: number;
  sourceCount: number;
  graphNodeCount: number;
  pageSize: number;
  maximumSourceBytes: number;
  search: StorageVnextFullRestoreSearchSettings;
};

export function resolveFullRestoreRebuildPlan(input: {
  expectedKnowledgeBaseId: string;
  expectedIndexPrefix: string;
  projections: StorageVnextFullRestoreProjection[];
  sourceCount: number | string;
  graphNodeCount: number | string;
  settings: { search?: Partial<StorageVnextFullRestoreSearchSettings> };
  maximumSourceBytes: number;
  pageSize: number;
}): StorageVnextFullRestoreRebuildPlan {
  const projection = input.projections[0];
  if (
    input.projections.length !== 1
    || !projection
    || projection.knowledgeBaseId !== input.expectedKnowledgeBaseId
    || projection.projectionRole !== "active"
    || projection.state !== "ready"
    || !projection.providerIndexUid.startsWith(input.expectedIndexPrefix)
  ) {
    throw new Error("Full restore requires exactly one run-owned ready active projection");
  }
  const expectedDocumentCount = safeCount(
    projection.documentCount,
    "active projection document count"
  );
  const sourceCount = safeCount(input.sourceCount, "source count");
  const graphNodeCount = safeCount(input.graphNodeCount, "graph node count");
  if (sourceCount < 1 || graphNodeCount !== sourceCount) {
    throw new Error("Full restore authority counts are invalid");
  }
  assertInteger(input.maximumSourceBytes, 1, Number.MAX_SAFE_INTEGER, "source byte limit");
  assertInteger(input.pageSize, 1, 1_000, "page size");
  const search = input.settings.search;
  if (!search) throw new Error("Full restore runtime search settings are unavailable");
  assertInteger(search.engineSearchCutoffMs, 50, 10_000, "search cutoff");
  assertInteger(search.indexBatchDocumentCount, 1, 2_000, "search batch documents");
  assertInteger(
    search.indexBatchCompressedBytes,
    64 * 1_024,
    32 * 1_024 * 1_024,
    "search batch bytes"
  );
  assertInteger(search.taskPollIntervalMs, 10, 60_000, "task poll interval");
  assertInteger(search.taskTimeoutMs, 1_000, 3_600_000, "task timeout");
  return {
    knowledgeBaseId: projection.knowledgeBaseId,
    providerIndexUid: projection.providerIndexUid,
    expectedDocumentCount,
    sourceCount,
    graphNodeCount,
    pageSize: input.pageSize,
    maximumSourceBytes: input.maximumSourceBytes,
    search: search as StorageVnextFullRestoreSearchSettings
  };
}

function safeCount(value: number | string, label: string): number {
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`Full restore ${label} is invalid`);
  }
  return result;
}

function assertInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  label: string
): asserts value is number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`Full restore ${label} is invalid`);
  }
}
