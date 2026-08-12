import assert from "node:assert/strict";
import test from "node:test";
import {
  createInterleavedPostgresEvidence
} from "../lib/interleaved-postgres-evidence.mjs";

test("collects bounded storage vNext lifecycle evidence without storage keys or bodies", async () => {
  const calls = [];
  const evidence = createInterleavedPostgresEvidence({
    query: async (name, knowledgeBaseId) => {
      calls.push({ name, knowledgeBaseId });
      return fixtures[name] ?? [];
    }
  });

  const snapshot = await evidence.snapshotKnowledgeBase("kb-validation");

  assert.equal(snapshot.knowledgeBase.id, "kb-validation");
  assert.equal(snapshot.sourceFiles[0].resourceRevision, 2);
  assert.equal(snapshot.semanticStages[0].stageKind, "vector");
  assert.equal(snapshot.semanticStages[0].safeErrorCode, "SEARCH_PROVIDER_UNAVAILABLE");
  assert.equal(snapshot.sourceRevisions[0].revisionRole, "current");
  assert.equal(snapshot.releaseRoots[0].rootRole, "active");
  assert.equal(snapshot.activeSnapshots[0].releaseRootId, "root-2");
  assert.equal(snapshot.objectRegistrations[0].objectFormat, "source-markdown-v1");
  assert.doesNotMatch(JSON.stringify(snapshot), /private-bucket|requestJson|storageKey/u);
  assert.ok(calls.every((call) => call.knowledgeBaseId === "kb-validation"));
});

test("rejects missing and cross-scope knowledge-base evidence", async () => {
  const missing = createInterleavedPostgresEvidence({ query: async () => [] });
  await assert.rejects(
    () => missing.snapshotKnowledgeBase("kb-missing"),
    /knowledge base evidence was not found/i
  );

  const crossed = createInterleavedPostgresEvidence({
    query: async (name) => name === "knowledgeBase"
      ? [{ id: "kb-other", resourceRevision: 1 }]
      : []
  });
  await assert.rejects(
    () => crossed.snapshotKnowledgeBase("kb-validation"),
    /knowledge base evidence crossed its requested scope/i
  );
});

test("captures bounded global counts, setting revision, live work, active roots, and objects", async () => {
  const evidence = createInterleavedPostgresEvidence({
    query: async (name) => globalFixtures[name] ?? []
  });

  const snapshot = await evidence.snapshotGlobal();

  assert.equal(snapshot.counts.sourceFiles, 10);
  assert.equal(snapshot.runtimeSettings[0].id, "settings-2");
  assert.equal(snapshot.workers[0].role, "source");
  assert.equal(snapshot.knowledgeBases[0].activeRootPublicId, "root-1");
  assert.equal(snapshot.immutableObjects[0].state, "verified");
});

test("detects live work items across every storage vNext work kind", async () => {
  const observations = [[{ liveCount: "1" }], [{ liveCount: "0" }]];
  const evidence = createInterleavedPostgresEvidence({
    query: async (name, knowledgeBaseId) => {
      assert.equal(name, "liveWorkItemCount");
      assert.equal(knowledgeBaseId, "kb-validation");
      return observations.shift();
    }
  });

  assert.equal(await evidence.hasLiveWorkItems("kb-validation"), true);
  assert.equal(await evidence.hasLiveWorkItems("kb-validation"), false);
});

test("queries only current storage vNext evidence tables and preserves bounded safe errors", async () => {
  const queries = [];
  const sql = async (parts, ...values) => {
    const text = parts.join("$");
    queries.push(text);
    if (
      text.includes("FROM focowiki.knowledge_bases knowledge_base")
      && text.includes("WHERE knowledge_base.public_id =")
    ) {
      return [{
        id: values[0],
        name: "Validation",
        description: null,
        resourceRevision: 1,
        activeRootPublicId: null,
        activeRevision: null,
        deletedAt: null
      }];
    }
    return [];
  };
  sql.end = async () => undefined;
  const evidence = createInterleavedPostgresEvidence({ sql });

  await evidence.snapshotKnowledgeBase("kb-validation");
  await evidence.close();

  const serialized = queries.join("\n");
  for (const table of [
    "operations",
    "operation_work_items",
    "operation_results",
    "semantic_stage_work_items",
    "release_roots",
    "active_snapshots",
    "search_projections",
    "object_owners",
    "object_registrations"
  ]) {
    assert.match(serialized, new RegExp(`focowiki\\.${table}`, "u"));
  }
  assert.match(serialized, /safe_error_message AS "safeErrorMessage"/u);
  assert.match(serialized, /safe_message AS "safeMessage"/u);
  assert.match(serialized, /safe_error_code AS "safeErrorCode"/u);
  assert.doesNotMatch(serialized, /storage_key|settings_values/u);
});

const fixtures = {
  knowledgeBase: [{
    id: "kb-validation",
    name: "Validation",
    description: "Lifecycle validation",
    resourceRevision: 2,
    activeRootPublicId: "root-2",
    activeRevision: 2,
    deletedAt: null
  }],
  sourceFiles: [{
    id: "source-1",
    logicalPath: "reference.md",
    currentRevisionId: "revision-2",
    resourceRevision: 2,
    status: "ready",
    deletedAt: null
  }],
  sourceRevisions: [{
    id: "revision-2",
    sourceFileId: "source-1",
    objectId: "object-source",
    revisionRole: "current",
    checksumSha256: "b".repeat(64)
  }],
  semanticStages: [{
    id: "semantic-stage-1",
    sourceFileId: "source-1",
    stageKind: "vector",
    state: "retry",
    attemptCount: 1,
    maximumAttempts: 8,
    safeErrorCode: "SEARCH_PROVIDER_UNAVAILABLE"
  }],
  releaseRoots: [{
    id: "root-2",
    baseRootId: "root-1",
    rootRole: "active",
    resourceRevision: 2
  }],
  activeSnapshots: [{
    releaseRootId: "root-2",
    searchProjectionId: "search-1",
    operationId: "operation-1",
    resourceRevision: 2
  }],
  objectOwners: [{
    id: "owner-1",
    objectId: "object-source",
    ownerKind: "source_revision",
    sourceRevisionId: "revision-2"
  }],
  objectRegistrations: [{
    id: "object-source",
    checksumSha256: "a".repeat(64),
    objectFormat: "source-markdown-v1",
    state: "verified",
    byteCount: 512
  }]
};

const globalFixtures = {
  globalCounts: [{
    knowledgeBases: 1,
    sourceFiles: 10,
    uploadSessions: 2,
    operations: 3,
    workItems: 1,
    releaseRoots: 2,
    activeSnapshots: 1,
    searchProjections: 1,
    objectRegistrations: 20,
    objectOwners: 20,
    cleanupActions: 0
  }],
  globalRuntimeSettings: [{ id: "settings-2", checksumSha256: "c".repeat(64) }],
  globalWorkers: [{ role: "source", state: "running", activeJobCount: 1 }],
  globalKnowledgeBases: [{
    id: "kb-1",
    activeRootPublicId: "root-1",
    resourceRevision: 1,
    activeRevision: 10
  }],
  globalObjectRegistrations: [{
    state: "verified",
    objectFormat: "source-markdown-v1",
    count: 20,
    totalSizeBytes: 1024
  }]
};
