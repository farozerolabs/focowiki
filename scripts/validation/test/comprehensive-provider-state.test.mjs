import assert from "node:assert/strict";
import test from "node:test";

import {
  assertComprehensiveProviderSwitchReuse,
  classifyComprehensiveCleanupIndexes,
  classifyComprehensiveQuarantinedIndexes,
  classifyComprehensiveRetainedLexicalIndexes,
  classifyComprehensiveRetainedSemanticIndexes,
  classifyComprehensiveMeilisearchTasks,
  createComprehensiveMaintenanceIdempotencyKey,
  extractComprehensiveMeilisearchVectorDimension,
  reconcileComprehensiveMeilisearchPhase,
  reconcileComprehensiveProviderCluster,
  reconcileComprehensiveProviderState
} from "../lib/comprehensive-provider-state.mjs";

test("retains historical semantic indexes only while live vector rows own documents", () => {
  assert.deepEqual(classifyComprehensiveRetainedSemanticIndexes({
    rows: [{
      indexUid: "focowiki_dev_semantic_owned",
      liveDocumentCount: 54
    }, {
      indexUid: "focowiki_dev_semantic_released",
      liveDocumentCount: 0
    }]
  }), [{
    indexUid: "focowiki_dev_semantic_owned",
    documentCount: 54
  }]);
});

test("classifies only undeclared provider indexes inside staging retention", () => {
  assert.deepEqual(classifyComprehensiveQuarantinedIndexes({
    provider: "opensearch",
    now: "2026-08-12T08:00:00.000Z",
    stagingRetentionHours: 24,
    declaredIndexUids: ["focowiki_dev_active"],
    rows: [{
      indexUid: "focowiki_dev_active",
      documentCount: 200,
      updatedAt: "2026-08-10T08:00:00.000Z"
    }, {
      indexUid: "focowiki_dev_quarantined",
      documentCount: 53,
      updatedAt: "2026-08-11T08:00:00.001Z"
    }]
  }), [{
    indexUid: "focowiki_dev_quarantined",
    documentCount: 53,
    updatedAt: "2026-08-11T08:00:00.001Z"
  }]);

  assert.throws(() => classifyComprehensiveQuarantinedIndexes({
    provider: "opensearch",
    now: "2026-08-12T08:00:00.000Z",
    stagingRetentionHours: 24,
    declaredIndexUids: [],
    rows: [{
      indexUid: "focowiki_dev_overdue",
      documentCount: 1,
      updatedAt: "2026-08-11T08:00:00.000Z"
    }]
  }), /overdue/u);
});

test("retains every live provider cleanup index with its durable document count", () => {
  assert.deepEqual(classifyComprehensiveCleanupIndexes({
    provider: "opensearch",
    rows: [{
      actionKind: "provider_adoption",
      cleanupPlane: "search",
      searchProviderKind: "opensearch",
      resourceKind: "search_index",
      resourcePublicId: "focowiki_dev_semantic_retired",
      state: "queued",
      checkpoint: {
        providerIndexUid: "focowiki_dev_semantic_retired",
        documentCount: 54,
        semanticVectorIndex: true
      }
    }]
  }), [{
    indexUid: "focowiki_dev_semantic_retired",
    documentCount: 54
  }]);
});

test("retains failed lexical candidates only inside the configured quarantine window", () => {
  assert.deepEqual(classifyComprehensiveRetainedLexicalIndexes({
    now: "2026-08-11T12:30:00.000Z",
    quarantineGracePeriodSeconds: 86_400,
    rows: [{
      indexUid: "focowiki_dev_candidate_recent",
      documentCount: 882,
      projectionRole: "candidate",
      state: "failed",
      updatedAt: "2026-08-10T15:30:00.000Z"
    }, {
      indexUid: "focowiki_dev_candidate_overdue",
      documentCount: 882,
      projectionRole: "candidate",
      state: "failed",
      updatedAt: "2026-08-10T12:29:59.000Z"
    }]
  }), [{
    indexUid: "focowiki_dev_candidate_recent",
    documentCount: 882
  }]);
});

test("reconciles every owned provider index and alias against exact document counts", () => {
  const expectedIndexes = [
    { indexUid: "focowiki_dev_lexical", documentCount: 3 },
    { indexUid: "focowiki_dev_vector", documentCount: 2 }
  ];
  assert.deepEqual(reconcileComprehensiveProviderCluster({
    provider: "opensearch",
    expectedIndexes,
    retainedIndexes: [],
    expectedAliases: [],
    cluster: {
      indices: [
        { indexUid: "focowiki_dev_vector", documentCount: 2, status: "open", health: "green" },
        { indexUid: "focowiki_dev_lexical", documentCount: 3, status: "open", health: "yellow" }
      ],
      aliases: []
    }
  }), {
    ok: true,
    provider: "opensearch",
    indexCount: 2,
    activeIndexCount: 2,
    retainedIndexCount: 0,
    quarantinedIndexCount: 0,
    aliasCount: 0,
    indexes: [
      { indexUid: "focowiki_dev_lexical", documentCount: 3, pass: true },
      { indexUid: "focowiki_dev_vector", documentCount: 2, pass: true }
    ],
    retainedIndexes: [],
    quarantinedIndexes: [],
    aliases: []
  });

  assert.deepEqual(reconcileComprehensiveProviderCluster({
    provider: "meilisearch",
    expectedIndexes,
    retainedIndexes: [
      { indexUid: "focowiki_dev_vector_previous", documentCount: 5 }
    ],
    cluster: {
      indexes: {
        focowiki_dev_lexical: { numberOfDocuments: 3, isIndexing: false },
        focowiki_dev_vector: { numberOfDocuments: 2, isIndexing: false },
        focowiki_dev_vector_previous: { numberOfDocuments: 5, isIndexing: false }
      }
    }
  }), {
    ok: true,
    provider: "meilisearch",
    indexCount: 3,
    activeIndexCount: 2,
    retainedIndexCount: 1,
    quarantinedIndexCount: 0,
    aliasCount: 0,
    indexes: [
      { indexUid: "focowiki_dev_lexical", documentCount: 3, pass: true },
      { indexUid: "focowiki_dev_vector", documentCount: 2, pass: true }
    ],
    retainedIndexes: [
      { indexUid: "focowiki_dev_vector_previous", documentCount: 5, pass: true }
    ],
    quarantinedIndexes: [],
    aliases: []
  });

  assert.throws(() => reconcileComprehensiveProviderCluster({
    provider: "opensearch",
    expectedIndexes,
    expectedAliases: [],
    cluster: {
      indices: [
        ...expectedIndexes.map((item) => ({ ...item, status: "open", health: "green" })),
        { indexUid: "focowiki_dev_stale", documentCount: 1, status: "open", health: "green" }
      ],
      aliases: []
    }
  }), /index identities/u);

  assert.equal(reconcileComprehensiveProviderCluster({
    provider: "meilisearch",
    expectedIndexes,
    cluster: {
      indexes: {
        focowiki_dev_lexical: { numberOfDocuments: 3, isIndexing: false },
        focowiki_dev_vector: { numberOfDocuments: 2, isIndexing: false }
      }
    }
  }).ok, true);

  assert.throws(() => reconcileComprehensiveProviderCluster({
    provider: "meilisearch",
    expectedIndexes,
    retainedIndexes: [
      { indexUid: "focowiki_dev_vector_previous", documentCount: 5 }
    ],
    cluster: {
      indexes: {
        focowiki_dev_lexical: { numberOfDocuments: 3, isIndexing: false },
        focowiki_dev_vector_previous: { numberOfDocuments: 5, isIndexing: false }
      }
    }
  }), /active index identities/u);

  assert.throws(() => reconcileComprehensiveProviderCluster({
    provider: "meilisearch",
    expectedIndexes,
    retainedIndexes: [
      { indexUid: "focowiki_dev_vector_previous", documentCount: 5 }
    ],
    cluster: {
      indexes: {
        focowiki_dev_lexical: { numberOfDocuments: 3, isIndexing: false },
        focowiki_dev_vector: { numberOfDocuments: 2, isIndexing: false },
        focowiki_dev_foreign: { numberOfDocuments: 1, isIndexing: false }
      }
    }
  }), /cluster index identities/u);
});

test("reconciles explicitly quarantined provider indexes without treating them as active", () => {
  const result = reconcileComprehensiveProviderCluster({
    provider: "opensearch",
    expectedIndexes: [{ indexUid: "focowiki_dev_active", documentCount: 200 }],
    retainedIndexes: [],
    quarantinedIndexes: [{
      indexUid: "focowiki_dev_quarantined",
      documentCount: 53,
      updatedAt: "2026-08-12T07:00:00.000Z"
    }],
    expectedAliases: [],
    cluster: {
      indices: [{
        indexUid: "focowiki_dev_active",
        documentCount: 200,
        status: "open",
        health: "green"
      }, {
        indexUid: "focowiki_dev_quarantined",
        documentCount: 53,
        status: "open",
        health: "yellow"
      }],
      aliases: []
    }
  });

  assert.equal(result.indexCount, 2);
  assert.equal(result.activeIndexCount, 1);
  assert.equal(result.retainedIndexCount, 0);
  assert.equal(result.quarantinedIndexCount, 1);
  assert.deepEqual(result.quarantinedIndexes, [{
    indexUid: "focowiki_dev_quarantined",
    documentCount: 53,
    updatedAt: "2026-08-12T07:00:00.000Z",
    pass: true
  }]);
});

test("reconcileComprehensiveMeilisearchPhase gates every query, read, mapping, task and vector", () => {
  const result = reconcileComprehensiveMeilisearchPhase({
    search: {
      ok: true,
      provider: "meilisearch",
      counts: {
        expectedFiles: 200,
        completedFiles: 200,
        expectedQueries: 2061,
        completedQueries: 2061,
        successfulQueries: 2061,
        sourceReads: 400,
        failures: 0,
        expectedFilterDispositions: 600,
        completedFilterDispositions: 600
      }
    },
    providerState: {
      ok: true,
      provider: "meilisearch",
      knowledgeBases: [
        {
          lexical: { documents: [{ id: "lexical-1" }] },
          vector: { documents: [{ id: "vector-1" }] },
          providerEvidence: {
            lexical: { mappingFields: ["id"] },
            vector: { mappingFields: ["id", "family"] }
          }
        }
      ],
      tasks: { activeWriteTaskCount: 0 },
      cluster: { indexCount: 4 },
      clusterReconciliation: {
        ok: true,
        indexCount: 4,
        activeIndexCount: 2,
        retainedIndexCount: 1,
        quarantinedIndexCount: 1
      }
    },
    vectorOracle: {
      ok: true,
      provider: "meilisearch",
      counts: {
        vectorArtifacts: 1,
        vectorQueries: 1,
        successfulVectorQueries: 1,
        failedVectorQueries: 0,
        hydratedSources: 1
      },
      querySummary: { annRecall: { minimum: 1 } }
    },
    taskLedger: {
      ok: true,
      expectedTotal: 3,
      items: [{ uid: 1 }, { uid: 2 }, { uid: 3 }],
      counts: { total: 3, inProgress: 0, failed: 0, foreign: 0 }
    },
    switchReport: { ok: true, reuse: { ok: true } }
  });

  assert.deepEqual(result, {
    ok: true,
    files: 200,
    queries: 2061,
    sourceReads: 400,
    filterDispositions: 600,
    lexicalDocuments: 1,
    vectorDocuments: 1,
    mappingFields: 3,
    providerTasks: 3,
    vectorArtifacts: 1,
    vectorQueryFamilies: 1,
    vectorHydrations: 1,
    minimumAnnRecall: 1,
    activeWriteTasks: 0,
    repeatedCompatibleModelWork: false
  });

  assert.throws(() => reconcileComprehensiveMeilisearchPhase({
    search: { ok: false }
  }), /search (counts|ledger)/u);
});

test("classifyComprehensiveMeilisearchTasks retains every task and explicit failure disposition", () => {
  const result = classifyComprehensiveMeilisearchTasks({
    indexPrefix: "focowiki_dev",
    ownedIndexPrefixes: ["focowiki_dev", "svnext_validation_run-one"],
    tasks: [
      {
        uid: 3,
        status: "succeeded",
        type: "documentAdditionOrUpdate",
        indexUid: "svnext_validation_run-one_active"
      },
      {
        uid: 2,
        status: "failed",
        type: "indexCreation",
        indexUids: ["focowiki_dev_active"],
        error: { code: "index_already_exists" }
      },
      {
        uid: 1,
        status: "succeeded",
        type: "taskDeletion",
        indexUids: []
      }
    ]
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.counts, {
    total: 3,
    completed: 1,
    recoveredIdempotent: 1,
    housekeeping: 1,
    inProgress: 0,
    failed: 0,
    foreign: 0
  });
  assert.deepEqual(result.items.map((item) => item.disposition), [
    "completed",
    "recovered_idempotent",
    "housekeeping"
  ]);

  const invalid = classifyComprehensiveMeilisearchTasks({
    indexPrefix: "focowiki_dev",
    tasks: [{
      uid: 4,
      status: "failed",
      type: "documentAdditionOrUpdate",
      indexUids: ["foreign_index"],
      error: { code: "invalid_document" }
    }]
  });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.counts.failed, 1);
  assert.equal(invalid.counts.foreign, 1);
});

test("createComprehensiveMaintenanceIdempotencyKey separates retry attempts", () => {
  assert.equal(
    createComprehensiveMaintenanceIdempotencyKey({
      provider: "meilisearch",
      knowledgeBaseId: "knowledge-base-one",
      attempt: "retry-1"
    }),
    "comprehensive-switch:meilisearch:retry-1:knowledge-base-one"
  );
  assert.throws(
    () => createComprehensiveMaintenanceIdempotencyKey({
      provider: "meilisearch",
      knowledgeBaseId: "knowledge-base-one",
      attempt: "retry 1"
    }),
    /attempt/u
  );
});

test("extractComprehensiveMeilisearchVectorDimension requires one user-provided embedder", () => {
  assert.equal(extractComprehensiveMeilisearchVectorDimension({
    embedders: {
      focowiki_contract: { source: "userProvided", dimensions: 1024 }
    }
  }), 1024);
  assert.throws(
    () => extractComprehensiveMeilisearchVectorDimension({ embedders: {} }),
    /embedder/u
  );
  assert.throws(
    () => extractComprehensiveMeilisearchVectorDimension({
      embedders: {
        one: { source: "userProvided", dimensions: 1024 },
        two: { source: "userProvided", dimensions: 1024 }
      }
    }),
    /embedder/u
  );
});

test("reconcileComprehensiveProviderState proves lexical and vector ownership exactly", () => {
  const result = reconcileComprehensiveProviderState({
    knowledgeBases: [{
      knowledgeBaseId: "knowledge-base-one",
      sourceFileIds: ["source-file-one"],
      lexical: {
        indexUid: "lexical-one",
        expectedDocumentCount: 2,
        documents: [
          { id: "page-one", knowledgeBaseId: "knowledge-base-one", sourceFileId: "source-file-one", visible: true },
          { id: "page-two", knowledgeBaseId: "knowledge-base-one", sourceFileId: "source-file-one", visible: true }
        ]
      },
      vector: {
        indexUid: "vector-one",
        expectedDocuments: [
          { id: "vector-a", sourceFileId: "source-file-one", family: "content", dimension: 1024 }
        ],
        documents: [
          { id: "vector-a", knowledgeBaseId: "knowledge-base-one", sourceFileId: "source-file-one", family: "content" }
        ],
        mappingDimension: 1024
      }
    }]
  });

  assert.deepEqual(result, {
    ok: true,
    knowledgeBases: [{
      knowledgeBaseId: "knowledge-base-one",
      lexicalIndexUid: "lexical-one",
      lexicalDocumentCount: 2,
      lexicalSourceCount: 1,
      vectorIndexUid: "vector-one",
      vectorDocumentCount: 1,
      vectorSourceCount: 1,
      vectorFamilyCounts: { content: 1 },
      vectorDimension: 1024
    }]
  });
});

test("assertComprehensiveProviderSwitchReuse blocks repeated compatible model work", () => {
  const before = {
    embeddingArtifactCount: 10,
    embeddingArtifactWatermark: "2026-08-10T10:00:00.000Z",
    semanticGenerationCount: 2,
    semanticGenerationWatermark: "2026-08-10T09:00:00.000Z",
    semanticReconciliationCount: 20,
    completedModelSourceCount: 4,
    activeVectorDocumentCount: 30
  };
  assert.deepEqual(
    assertComprehensiveProviderSwitchReuse({ before, after: { ...before } }),
    { ok: true, unchanged: Object.keys(before).sort() }
  );
  assert.throws(
    () => assertComprehensiveProviderSwitchReuse({
      before,
      after: { ...before, embeddingArtifactCount: 11 }
    }),
    /embeddingArtifactCount/u
  );
});

test("reconcileComprehensiveProviderState rejects stale, foreign, and missing documents", () => {
  const base = {
    knowledgeBaseId: "knowledge-base-one",
    sourceFileIds: ["source-file-one"],
    lexical: {
      indexUid: "lexical-one",
      expectedDocumentCount: 1,
      documents: [
        { id: "page-one", knowledgeBaseId: "knowledge-base-one", sourceFileId: "source-file-one", visible: true }
      ]
    },
    vector: {
      indexUid: "vector-one",
      expectedDocuments: [
        { id: "vector-a", sourceFileId: "source-file-one", family: "content", dimension: 1024 }
      ],
      documents: [
        { id: "vector-a", knowledgeBaseId: "knowledge-base-one", sourceFileId: "source-file-one", family: "content" }
      ],
      mappingDimension: 1024
    }
  };

  assert.throws(
    () => reconcileComprehensiveProviderState({
      knowledgeBases: [{
        ...base,
        lexical: {
          ...base.lexical,
          documents: [{ ...base.lexical.documents[0], knowledgeBaseId: "foreign" }]
        }
      }]
    }),
    /lexical knowledge-base ownership/u
  );
  assert.throws(
    () => reconcileComprehensiveProviderState({
      knowledgeBases: [{
        ...base,
        vector: {
          ...base.vector,
          documents: [{ ...base.vector.documents[0], id: "stale-vector" }]
        }
      }]
    }),
    (error) => {
      assert.match(error.message, /vector document identities/u);
      assert.match(error.message, /actual=1 expected=1 missing=1 extra=1/u);
      assert.doesNotMatch(error.message, /stale-vector|vector-a/u);
      return true;
    }
  );
  assert.throws(
    () => reconcileComprehensiveProviderState({
      knowledgeBases: [{
        ...base,
        lexical: {
          ...base.lexical,
          documents: [{ ...base.lexical.documents[0], visible: false }]
        }
      }]
    }),
    /conflicting visibility flag/u
  );
});
