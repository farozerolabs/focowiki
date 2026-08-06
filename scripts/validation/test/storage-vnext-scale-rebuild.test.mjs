import assert from "node:assert/strict";
import test from "node:test";

import {
  buildStorageVnextScaleCorpusManifest,
  STORAGE_VNEXT_SCALE_FILE_COUNT,
  validateStorageVnextScaleCorpusManifest
} from "../lib/storage-vnext-scale-corpus.mjs";
import {
  createRateLimitedFetch
} from "../lib/storage-vnext-rate-limited-fetch.mjs";
import {
  mapWithBoundedConcurrency,
  resolveStorageVnextScaleUploadResume,
  uploadStorageVnextScaleCorpus
} from "../lib/storage-vnext-scale-upload.mjs";
import {
  assertStorageVnextScaleConvergenceCanProgress,
  createStorageVnextScalePublicationSettings,
  createStorageVnextScaleSearchSettings,
  createStorageVnextScaleWorkerSettings,
  createStorageVnextScaleRuntimeEnvironment,
  createStorageVnextValidationProfile,
  recoverStorageVnextScaleCompletionTimes,
  recoverStorageVnextScaleRun,
  summarizeStorageVnextSearchTaskEvidence
} from "../lib/storage-vnext-scale-scope.mjs";

test("defines exact scale and full evidence profiles", () => {
  assert.deepEqual(createStorageVnextValidationProfile("full"), {
    mode: "full",
    expectedFileCount: 29_736,
    expectedSourceBytes: 526_803_253,
    corpusPathEnvironment: "FOCOWIKI_STORAGE_VNEXT_FULL_CORPUS_PATH",
    rebuildKind: "focowiki-storage-vnext-full-rebuild",
    rebuildFileName: "full-rebuild.json",
    readsKind: "focowiki-storage-vnext-full-reads",
    readsFileName: "full-reads.json",
    resourcesKind: "focowiki-storage-vnext-full-resources",
    resourcesFileName: "full-resources.json",
    tuningKind: "focowiki-storage-vnext-full-tuning",
    tuningFileName: "full-tuning.json",
    targetNameSuffix: "full target"
  });
  assert.equal(createStorageVnextValidationProfile().expectedFileCount, 10_000);
  assert.throws(() => createStorageVnextValidationProfile("other"), /scale or full/u);
});

test("builds an exact 10,000-file manifest without retaining local paths or bodies", () => {
  const samples = Array.from({ length: STORAGE_VNEXT_SCALE_FILE_COUNT }, (_value, index) => {
    const relativePath = `group/file-${String(index).padStart(5, "0")}.md`;
    const bytes = Buffer.from(`# File ${index}\n`, "utf8");
    return {
      relativePath,
      filePath: `/private/corpus/${relativePath}`,
      sizeBytes: bytes.byteLength,
      bytes
    };
  });
  const manifest = buildStorageVnextScaleCorpusManifest({
    createdAt: "2026-08-03T00:00:00.000Z",
    corpusName: "cleaned-corpus",
    totalCandidateFiles: 29_736,
    samples,
    readBytes: (sample) => sample.bytes
  });

  assert.equal(manifest.fileCount, STORAGE_VNEXT_SCALE_FILE_COUNT);
  assert.equal(manifest.files.length, STORAGE_VNEXT_SCALE_FILE_COUNT);
  assert.match(manifest.manifestChecksumSha256, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.totalSizeBytes, samples.reduce((sum, item) => sum + item.sizeBytes, 0));
  assert.equal(JSON.stringify(manifest).includes("/private/corpus"), false);
  assert.equal(JSON.stringify(manifest).includes("bytes"), false);
});

test("rejects an incomplete scale corpus and changed file bytes", () => {
  assert.throws(() => buildStorageVnextScaleCorpusManifest({
    createdAt: "2026-08-03T00:00:00.000Z",
    corpusName: "cleaned-corpus",
    totalCandidateFiles: 29_736,
    samples: [],
    readBytes: () => Buffer.alloc(0)
  }), /exactly 10,000/u);

  const bytes = Buffer.from("# changed\n", "utf8");
  assert.throws(() => buildStorageVnextScaleCorpusManifest({
    createdAt: "2026-08-03T00:00:00.000Z",
    corpusName: "cleaned-corpus",
    totalCandidateFiles: 29_736,
    samples: Array.from({ length: STORAGE_VNEXT_SCALE_FILE_COUNT }, (_value, index) => ({
      relativePath: `file-${index}.md`,
      sizeBytes: index === 0 ? bytes.byteLength + 1 : bytes.byteLength
    })),
    readBytes: () => bytes
  }), /size changed/u);
});

test("accepts an explicit full-corpus count without weakening the 10,000-file default", () => {
  const samples = Array.from({ length: 3 }, (_value, index) => ({
    relativePath: `formal/file-${index}.md`,
    sizeBytes: 1,
    bytes: Buffer.from([index])
  }));
  const manifest = buildStorageVnextScaleCorpusManifest({
    createdAt: "2026-08-03T00:00:00.000Z",
    corpusName: "cleaned-corpus",
    totalCandidateFiles: 3,
    expectedFileCount: 3,
    selectionStrategy: "complete-formal-corpus-v1",
    samples,
    readBytes: (sample) => sample.bytes
  });

  assert.equal(
    validateStorageVnextScaleCorpusManifest(manifest, { expectedFileCount: 3 }).fileCount,
    3
  );
  assert.throws(
    () => validateStorageVnextScaleCorpusManifest(manifest),
    /invalid/u
  );
});

test("passes an explicit full-corpus count through the upload validator", async () => {
  const manifest = buildStorageVnextScaleCorpusManifest({
    createdAt: "2026-08-03T00:00:00.000Z",
    corpusName: "cleaned-corpus",
    totalCandidateFiles: 3,
    expectedFileCount: 3,
    samples: Array.from({ length: 3 }, (_value, index) => ({
      relativePath: `formal/file-${index}.md`,
      sizeBytes: 1,
      bytes: Buffer.from([index])
    })),
    readBytes: (sample) => sample.bytes
  });
  const result = await uploadStorageVnextScaleCorpus({
    manifest,
    expectedFileCount: 3,
    client: {
      json: async () => ({
        session: {
          id: "upload-test",
          state: "completed",
          counts: { selected: 3, uploaded: 3 }
        },
        transport: { manifestPageSize: 100, contentUploadConcurrency: 1 }
      })
    },
    knowledgeBaseId: "knowledge-base-test",
    idempotencyKey: "full-upload-test",
    readBytes: async () => Buffer.alloc(0)
  });

  assert.equal(result.uploadedFiles, 3);
});

test("retries a rate-limited request using the declared retry window", async () => {
  const waits = [];
  let attempts = 0;
  const fetchWithRetry = createRateLimitedFetch({
    async fetchImpl() {
      attempts += 1;
      return attempts === 1
        ? new Response("limited", { status: 429, headers: { "retry-after": "2" } })
        : new Response("ok", { status: 200 });
    },
    wait: async (milliseconds) => waits.push(milliseconds),
    maximumRetries: 2
  });

  const response = await fetchWithRetry("http://127.0.0.1/test", { method: "PUT" });
  assert.equal(response.status, 200);
  assert.equal(attempts, 2);
  assert.deepEqual(waits, [2_000]);
});

test("fails after the bounded rate-limit retry count", async () => {
  const fetchWithRetry = createRateLimitedFetch({
    fetchImpl: async () => new Response("limited", { status: 429 }),
    wait: async () => undefined,
    maximumRetries: 1
  });

  await assert.rejects(
    fetchWithRetry("http://127.0.0.1/test"),
    /retry budget exhausted/u
  );
});

test("bounds file-body work without accumulating the complete corpus", async () => {
  let active = 0;
  let peak = 0;
  const result = await mapWithBoundedConcurrency(
    Array.from({ length: 50 }, (_value, index) => index),
    4,
    async (value) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return value * 2;
    }
  );

  assert.equal(peak, 4);
  assert.deepEqual(result, Array.from({ length: 50 }, (_value, index) => index * 2));
});

test("resumes a complete manifest without appending duplicate entries", () => {
  assert.deepEqual(resolveStorageVnextScaleUploadResume({
    session: {
      state: "manifest_building",
      counts: { selected: 10_000, uploaded: 0 }
    },
    expectedFileCount: 10_000
  }), {
    appendManifest: false,
    sealManifest: true,
    selectedFiles: 10_000,
    uploadedFiles: 0
  });

  assert.deepEqual(resolveStorageVnextScaleUploadResume({
    session: {
      state: "uploading",
      counts: { selected: 10_000, uploaded: 2_500 }
    },
    expectedFileCount: 10_000
  }), {
    appendManifest: false,
    sealManifest: false,
    selectedFiles: 10_000,
    uploadedFiles: 2_500
  });
});

test("rejects partial or incompatible scale upload resume state", () => {
  assert.throws(() => resolveStorageVnextScaleUploadResume({
    session: {
      state: "manifest_building",
      counts: { selected: 9_999, uploaded: 0 }
    },
    expectedFileCount: 10_000
  }), /cannot resume/u);
});

test("derives runtime endpoints only inside the exact owned proof scope", () => {
  const environment = createStorageVnextScaleRuntimeEnvironment({
    proof: {
      runId: "svnext-20260803T120000Z-26a200000001",
      filesystemScope: "/tmp/svnext-20260803T120000Z-26a200000001",
      postgresScope: "focowiki_svnext_20260803t120000z_26a200000001",
      objectScope: "focowiki-validation/svnext-20260803T120000Z-26a200000001/",
      searchScope: "svnext_20260803t120000z_26a200000001_",
      coordinationScope: "focowiki:validation:svnext-20260803T120000Z-26a200000001:"
    },
    env: {
      DATABASE_URL: "postgres://user:secret@127.0.0.1:55432/postgres",
      REDIS_URL: "redis://127.0.0.1:56379/0",
      S3_ENDPOINT: "http://127.0.0.1:43300",
      MEILI_HOST: "http://127.0.0.1:57700",
      MEILI_MASTER_KEY: "local-key"
    }
  });

  assert.equal(
    new URL(environment.DATABASE_URL).pathname,
    "/focowiki_svnext_20260803t120000z_26a200000001"
  );
  assert.equal(
    environment.S3_PREFIX,
    "focowiki-validation/svnext-20260803T120000Z-26a200000001"
  );
  assert.equal(environment.MEILI_INDEX_PREFIX, "svnext_20260803t120000z_26a200000001_");
  assert.equal(
    environment.REDIS_KEY_PREFIX,
    "focowiki:validation:svnext-20260803T120000Z-26a200000001:"
  );
  assert.deepEqual([
    environment.DATABASE_POOL_MAX,
    environment.SOURCE_WORKER_DATABASE_POOL_MAX,
    environment.PUBLICATION_WORKER_DATABASE_POOL_MAX,
    environment.MAINTENANCE_WORKER_DATABASE_POOL_MAX
  ], ["1", "6", "4", "2"]);
  assert.equal(environment.LOG_FILE_DIR.endsWith("/logs"), true);
  assert.equal(environment.MEILI_API_KEY, "local-key");
});

test("configures a measured publication window for the 10,000-file scale run", () => {
  assert.deepEqual(createStorageVnextScaleWorkerSettings({
    lockTtlSeconds: 900,
    heartbeatIntervalMs: 15_000,
    jobMaxAttempts: 3,
    claimBatchSize: 10,
    pollIntervalMs: 1_000,
    databaseMutationConcurrency: 2
  }), {
    lockTtlSeconds: 7_200,
    heartbeatIntervalMs: 15_000,
    jobMaxAttempts: 5,
    claimBatchSize: 10,
    pollIntervalMs: 10_000,
    databaseMutationConcurrency: 1
  });
});

test("uses the measured memory-safe search batch for the tuned scale rerun", () => {
  assert.deepEqual(createStorageVnextScaleSearchSettings({
    indexBatchDocumentCount: 500,
    indexBatchCompressedBytes: 8 * 1_024 * 1_024,
    maxInFlightTasks: 2
  }), {
    indexBatchDocumentCount: 10_000,
    indexBatchCompressedBytes: 8 * 1_024 * 1_024,
    maxInFlightTasks: 2
  });
});

test("bounds tuned publication concurrency without changing unrelated settings", () => {
  assert.deepEqual(createStorageVnextScalePublicationSettings({
    mode: "per_file",
    intervalSeconds: 300,
    roleConcurrency: 1,
    impactConcurrency: 8,
    projectionPartitionConcurrency: 4,
    generatedObjectWriteConcurrency: 4,
    directoryMaterializationConcurrency: 4,
    indexShardSize: 1_000
  }), {
    mode: "batch",
    intervalSeconds: 10,
    roleConcurrency: 1,
    impactConcurrency: 1,
    projectionPartitionConcurrency: 1,
    generatedObjectWriteConcurrency: 1,
    directoryMaterializationConcurrency: 1,
    indexShardSize: 1_000
  });
});

test("fails fast after the owned publication operation reaches a failed terminal state", () => {
  assert.throws(() => assertStorageVnextScaleConvergenceCanProgress({
    failedSources: 0,
    failedPublicationOperations: 1
  }), /failed publication operation/u);

  assert.doesNotThrow(() => assertStorageVnextScaleConvergenceCanProgress({
    failedSources: 0,
    failedPublicationOperations: 0
  }));
});

test("measures search throughput from the complete owned provider task window", () => {
  const evidence = summarizeStorageVnextSearchTaskEvidence({
    providerIndexUid: "owned-index",
    expectedDocumentCount: 1_000,
    taskPage: {
      total: 2,
      next: null,
      results: [
        {
          indexUid: "owned-index",
          status: "succeeded",
          type: "documentAdditionOrUpdate",
          details: { indexedDocuments: 500 },
          startedAt: "2026-08-03T11:43:36.000Z",
          finishedAt: "2026-08-03T11:43:40.000Z"
        },
        {
          indexUid: "owned-index",
          status: "succeeded",
          type: "documentAdditionOrUpdate",
          details: { indexedDocuments: 500 },
          startedAt: "2026-08-03T11:43:41.000Z",
          finishedAt: "2026-08-03T11:43:46.000Z"
        }
      ]
    }
  });

  assert.deepEqual(evidence, {
    evidenceSource: "provider_tasks",
    providerTaskHistoryRetained: true,
    providerDocumentTaskCount: 2,
    providerIndexedDocumentCount: 1_000,
    startedAt: "2026-08-03T11:43:36.000Z",
    finishedAt: "2026-08-03T11:43:46.000Z",
    durationMs: 10_000
  });
});

test("uses durable projection and provider stats after finished tasks are cleaned", () => {
  const evidence = summarizeStorageVnextSearchTaskEvidence({
    providerIndexUid: "owned-index",
    expectedDocumentCount: 1_000,
    taskPage: { total: 0, next: null, results: [] },
    durableProjection: {
      documentCount: 1_000,
      batchCount: 2,
      createdAt: "2026-08-03T11:43:36.000Z",
      updatedAt: "2026-08-03T11:43:46.000Z"
    },
    providerStats: {
      numberOfDocuments: 1_000,
      isIndexing: false
    }
  });

  assert.deepEqual(evidence, {
    evidenceSource: "durable_projection_after_provider_task_cleanup",
    providerTaskHistoryRetained: false,
    providerDocumentTaskCount: 2,
    providerIndexedDocumentCount: 1_000,
    startedAt: "2026-08-03T11:43:36.000Z",
    finishedAt: "2026-08-03T11:43:46.000Z",
    durationMs: 10_000
  });
});

test("recovers original completion times from durable full-run milestones", () => {
  assert.deepEqual(recoverStorageVnextScaleCompletionTimes({
    startedAt: "2026-08-03T10:00:00.000Z",
    uploadDurationMs: 60_000,
    fileCount: 3,
    milestones: [
      {
        at: "2026-08-03T10:02:00.000Z",
        readySources: 3,
        liveSourceWork: 0,
        graphNodes: 3,
        activeSnapshots: 0,
        activeSourceCatalogEntries: 0,
        livePublicationWork: 1,
        liveSearchWork: 0
      },
      {
        at: "2026-08-03T10:05:00.000Z",
        readySources: 3,
        liveSourceWork: 0,
        graphNodes: 3,
        activeSnapshots: 1,
        activeSourceCatalogEntries: 3,
        livePublicationWork: 0,
        liveSearchWork: 0
      }
    ]
  }), {
    uploadCompletedAtMs: Date.parse("2026-08-03T10:01:00.000Z"),
    sourceCompletedAtMs: Date.parse("2026-08-03T10:02:00.000Z"),
    graphCompletedAtMs: Date.parse("2026-08-03T10:02:00.000Z"),
    publicationCompletedAtMs: Date.parse("2026-08-03T10:05:00.000Z"),
    activationCompletedAtMs: Date.parse("2026-08-03T10:05:00.000Z"),
    totalCompletedAtMs: Date.parse("2026-08-03T10:05:00.000Z")
  });
});

test("rejects incomplete or foreign search provider task evidence", () => {
  const task = {
    indexUid: "foreign-index",
    status: "succeeded",
    type: "documentAdditionOrUpdate",
    details: { indexedDocuments: 500 },
    startedAt: "2026-08-03T11:43:36.000Z",
    finishedAt: "2026-08-03T11:43:40.000Z"
  };

  assert.throws(() => summarizeStorageVnextSearchTaskEvidence({
    providerIndexUid: "owned-index",
    expectedDocumentCount: 500,
    taskPage: { total: 1, next: null, results: [task] }
  }), /outside the active provider index/u);
  assert.throws(() => summarizeStorageVnextSearchTaskEvidence({
    providerIndexUid: "foreign-index",
    expectedDocumentCount: 500,
    taskPage: { total: 2, next: 1, results: [task] }
  }), /incomplete/u);
});

test("recovers only the knowledge base owned by the same scale report", () => {
  const corpus = {
    fileCount: 10_000,
    totalSizeBytes: 123,
    manifestChecksumSha256: "a".repeat(64)
  };
  const upload = { filesPerSecond: 18.478, durationMs: 541_179 };
  const convergence = { readySources: 10_000, activeUnifiedIndexes: 1 };
  const throughput = {
    uploadAcceptedFilesPerSecond: 18.478,
    sourceCompletedFilesPerSecond: 1.862,
    publicationCompletedFilesPerSecond: 1.372,
    searchIndexedFileEquivalentsPerSecond: 1.372,
    graphCompletedFilesPerSecond: 1.862,
    totalCompletedFilesPerSecond: 1.277
  };
  const recovered = recoverStorageVnextScaleRun({
    runId: "svnext-20260803T120000Z-26a200000001",
    corpus,
    report: {
      kind: "focowiki-storage-vnext-scale-rebuild",
      version: 1,
      runId: "svnext-20260803T120000Z-26a200000001",
      corpus,
      knowledgeBaseId: "knowledge-base-11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-03T00:00:00.000Z",
      milestones: [{ readySources: 500 }],
      upload,
      convergence,
      throughput
    }
  });

  assert.deepEqual(recovered, {
    knowledgeBaseId: "knowledge-base-11111111-1111-4111-8111-111111111111",
    startedAt: "2026-08-03T00:00:00.000Z",
    milestones: [{ readySources: 500 }],
    upload,
    convergence,
    throughput,
    searchIndexing: null
  });
  assert.throws(() => recoverStorageVnextScaleRun({
    runId: "svnext-20260803T120000Z-26a200000001",
    corpus,
    report: { ...recovered, kind: "wrong", version: 1, corpus }
  }), /incompatible/u);

  assert.equal(recoverStorageVnextScaleRun({
    runId: "svnext-20260803T120000Z-26a200000001",
    corpus,
    reportKind: "focowiki-storage-vnext-full-rebuild",
    report: {
      kind: "focowiki-storage-vnext-full-rebuild",
      version: 1,
      runId: "svnext-20260803T120000Z-26a200000001",
      corpus,
      knowledgeBaseId: "knowledge-base-11111111-1111-4111-8111-111111111111",
      startedAt: "2026-08-03T00:00:00.000Z"
    }
  }).knowledgeBaseId, "knowledge-base-11111111-1111-4111-8111-111111111111");
});
