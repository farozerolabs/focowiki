import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterleavedPostgresEvidence
} from "../lib/interleaved-postgres-evidence.mjs";

test("collects bounded lifecycle evidence without storage keys or request bodies", async () => {
  const calls = [];
  const query = async (name, knowledgeBaseId) => {
    calls.push({ name, knowledgeBaseId });
    return fixtures[name] ?? [];
  };
  const evidence = createInterleavedPostgresEvidence({ query });

  const snapshot = await evidence.snapshotKnowledgeBase("kb-validation");

  assert.equal(snapshot.knowledgeBase.id, "kb-validation");
  assert.equal(snapshot.sourceFiles[0].resourceRevision, 2);
  assert.equal(snapshot.sourceRevisions[0].revision, 2);
  assert.equal(snapshot.generations[0].predecessorGenerationId, "generation-1");
  assert.equal(snapshot.activeProjections[0].logicalPath, "pages/reference.md");
  assert.equal(snapshot.immutableObjects[0].checksumSha256, "a".repeat(64));
  assert.doesNotMatch(JSON.stringify(snapshot), /private-bucket/u);
  assert.doesNotMatch(JSON.stringify(snapshot), /requestJson/u);
  assert.ok(calls.every((call) => call.knowledgeBaseId === "kb-validation"));
});

test("rejects missing and cross-scope knowledge-base evidence", async () => {
  const missing = createInterleavedPostgresEvidence({
    query: async () => []
  });
  await assert.rejects(
    () => missing.snapshotKnowledgeBase("kb-missing"),
    /knowledge base evidence was not found/i
  );

  const crossed = createInterleavedPostgresEvidence({
    query: async (name) =>
      name === "knowledgeBase"
        ? [{ id: "kb-other", resourceRevision: 1, catalogGeneration: 0 }]
        : []
  });
  await assert.rejects(
    () => crossed.snapshotKnowledgeBase("kb-validation"),
    /knowledge base evidence crossed its requested scope/i
  );
});

test("captures bounded global counts, settings versions, workers, and active generations", async () => {
  const evidence = createInterleavedPostgresEvidence({
    query: async (name) => globalFixtures[name] ?? []
  });

  const snapshot = await evidence.snapshotGlobal();

  assert.equal(snapshot.counts.sourceFiles, 10);
  assert.equal(snapshot.runtimeSettings[0].key, "worker");
  assert.equal(snapshot.workers[0].role, "source");
  assert.equal(snapshot.knowledgeBases[0].activeGenerationId, "generation-1");
  assert.equal(snapshot.immutableObjects[0].lifecycleState, "active");
});

test("captures every lexical rebuild generation referenced by work items", async () => {
  const queries = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("$");
    queries.push(text);
    if (
      text.includes("FROM focowiki.knowledge_bases")
      && text.includes("WHERE id =")
    ) {
      return [{
        id: values[0],
        name: "Validation",
        description: null,
        activeGenerationId: null,
        resourceRevision: 1,
        catalogGeneration: 0,
        deletedAt: null
      }];
    }
    return [];
  };
  sql.end = async () => undefined;
  const evidence = createInterleavedPostgresEvidence({ sql });

  await evidence.snapshotKnowledgeBase("kb-validation");
  await evidence.close();

  const lexicalRebuildQuery = queries.find((query) =>
    query.includes("FROM focowiki.knowledge_base_lexical_rebuilds")
  );
  assert.ok(lexicalRebuildQuery);
  assert.doesNotMatch(lexicalRebuildQuery, /LIMIT 1/u);
  assert.match(
    lexicalRebuildQuery,
    /ORDER BY created_at, target_generation_id/u
  );
  const lexicalWorkItemQuery = queries.find((query) =>
    query.includes("FROM focowiki.lexical_rebuild_work_items")
  );
  assert.ok(lexicalWorkItemQuery);
  assert.match(
    lexicalWorkItemQuery,
    /JOIN focowiki\.knowledge_base_lexical_rebuilds/u
  );
});

test("preserves bounded safe failure messages needed to diagnose cleaned scenarios", async () => {
  const queries = new Map();
  const sql = async (parts, ...values) => {
    const text = parts.join("$");
    if (
      text.includes("FROM focowiki.knowledge_bases")
      && text.includes("WHERE id =")
    ) {
      return [{
        id: values[0],
        name: "Validation",
        description: null,
        activeGenerationId: null,
        resourceRevision: 1,
        catalogGeneration: 0,
        deletedAt: null
      }];
    }
    for (const table of [
      "source_files",
      "role_jobs",
      "publication_generations",
      "publication_progress",
      "publication_impacts",
      "publication_subtasks"
    ]) {
      if (text.includes(`FROM focowiki.${table}`)) queries.set(table, text);
    }
    return [];
  };
  sql.end = async () => undefined;
  const evidence = createInterleavedPostgresEvidence({ sql });

  await evidence.snapshotKnowledgeBase("kb-validation");
  await evidence.close();

  assert.match(queries.get("source_files") ?? "", /terminal_failure_message AS "terminalFailureMessage"/u);
  assert.match(queries.get("role_jobs") ?? "", /last_error_message AS "lastErrorMessage"/u);
  assert.match(queries.get("publication_generations") ?? "", /safe_error_message AS "safeErrorMessage"/u);
  assert.match(queries.get("publication_progress") ?? "", /safe_error_message AS "safeErrorMessage"/u);
  assert.match(queries.get("publication_impacts") ?? "", /last_error_message AS "lastErrorMessage"/u);
  assert.match(queries.get("publication_subtasks") ?? "", /last_error_message AS "lastErrorMessage"/u);
});

const fixtures = {
  knowledgeBase: [{
    id: "kb-validation",
    name: "Validation",
    description: "Lifecycle validation",
    activeGenerationId: "generation-2",
    resourceRevision: 2,
    catalogGeneration: 2,
    deletedAt: null
  }],
  sourceFiles: [{
    id: "source-1",
    relativePath: "reference.md",
    activeRevisionId: "revision-2",
    resourceRevision: 2,
    contentRevision: 2,
    processingStatus: "completed",
    processingStage: "generation_activation",
    generatedOutputStatus: "visible",
    deletionIntentId: null,
    candidateOperationId: null,
    deletedAt: null
  }],
  sourceRevisions: [{
    id: "revision-2",
    sourceFileId: "source-1",
    revision: 2,
    processingStatus: "completed",
    checksumSha256: "b".repeat(64)
  }],
  generations: [{
    id: "generation-2",
    predecessorGenerationId: "generation-1",
    successorGenerationId: null,
    state: "active",
    safeErrorCode: null
  }],
  activeProjections: [{
    projectionKind: "tree",
    recordId: "record-1",
    sourceFileId: "source-1",
    relatedSourceFileId: null,
    logicalPath: "pages/reference.md",
    lastChangedGenerationId: "generation-2"
  }],
  immutableObjects: [{
    checksumSha256: "a".repeat(64),
    formatVersion: 1,
    lifecycleState: "active",
    sizeBytes: 512,
    integrityErrorCode: null,
    objectKey: "private-bucket/generated.md"
  }]
};

const globalFixtures = {
  globalCounts: [{
    knowledgeBases: 1,
    sourceFiles: 10,
    uploadSessions: 2,
    resourceOperations: 3,
    deletionIntents: 1,
    roleJobs: 4,
    generations: 5,
    activeProjectionRecords: 30,
    immutableObjects: 20
  }],
  globalRuntimeSettings: [{ key: "worker", version: 2, source: "admin" }],
  globalWorkers: [{
    role: "source",
    activeJobCount: 0,
    lastSeenAt: "2026-07-26T00:00:00.000Z"
  }],
  globalKnowledgeBases: [{
    id: "kb-1",
    activeGenerationId: "generation-1",
    resourceRevision: 1,
    catalogGeneration: 10
  }],
  globalImmutableObjects: [{
    lifecycleState: "active",
    count: 20,
    totalSizeBytes: 1024
  }]
};
