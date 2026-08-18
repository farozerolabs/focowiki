import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPostgresQueryPathLedger,
  buildPostgresQueryPathLedger,
  selectPostgresQueryPathRuntimeCandidates
} from "../lib/comprehensive-postgres-query-path-ledger.mjs";
import {
  createPostgresQueryShape
} from "../lib/comprehensive-persistence-inventory.mjs";

const query = `
  SELECT public_id
  FROM focowiki.knowledge_bases
  WHERE public_id = $1
`;
const shape = createPostgresQueryShape(query);
const inventory = [{
  id: "critical-query-path:repository.ts:10:read:knowledge_bases",
  kind: "critical-query-path",
  source: "repository.ts",
  statementLine: 10,
  tables: ["knowledge_bases"],
  operation: "read",
  queryClass: "catalog",
  queryFingerprint: shape.fingerprint,
  queryAnchorFingerprint: shape.anchorFingerprint,
  queryAnchorTokenHashes: shape.anchorTokenHashes,
  parameterCount: 1
}];

test("builds item-level runtime and generic-plan evidence without raw SQL", () => {
  const report = buildPostgresQueryPathLedger({
    phase: "positive-crud",
    inventory,
    observedStatements: [{
      queryId: "42",
      query,
      calls: 4,
      plans: 1,
      rows: 4,
      totalPlanTimeMs: 0.4,
      totalExecTimeMs: 1.2,
      maximumExecTimeMs: 0.5,
      sharedBlocksHit: 8,
      sharedBlocksRead: 0,
      tempBlocksWritten: 0,
      walRecords: 0,
      walBytes: 0
    }],
    planEvidence: [{
      queryId: "42",
      plan: [{
        Plan: {
          "Node Type": "Index Scan",
          "Relation Name": "knowledge_bases",
          "Index Name": "knowledge_bases_public_id_key",
          "Plan Rows": 1,
          "Total Cost": 8.3
        }
      }]
    }],
    runtime: {
      databaseDeadlocks: 0,
      blockedSessions: 0,
      longestTransactionMs: 0
    }
  });

  assert.doesNotThrow(() => assertPostgresQueryPathLedger(report));
  assert.equal(report.ok, true);
  assert.equal(report.counts.expected, 1);
  assert.equal(report.counts.observed, 1);
  assert.equal(report.counts.planned, 1);
  assert.deepEqual(report.rows[0].plan.indexNames, ["knowledge_bases_public_id_key"]);
  assert.deepEqual(report.rows[0].plan.nodeTypes, ["Index Scan"]);
  assert.equal(report.rows[0].runtime.rowsPerCall, 1);
  assert.doesNotMatch(JSON.stringify(report), /SELECT public_id/u);
});

test("fails closed when an exact inventory path has no runtime or plan evidence", () => {
  const report = buildPostgresQueryPathLedger({
    phase: "positive-crud",
    inventory,
    observedStatements: [],
    planEvidence: [],
    runtime: {
      databaseDeadlocks: 0,
      blockedSessions: 0,
      longestTransactionMs: 0
    }
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.counts, {
    expected: 1,
    observed: 0,
    planned: 0,
    missingRuntime: 1,
    missingPlan: 1
  });
  assert.throws(
    () => assertPostgresQueryPathLedger(report),
    /PostgreSQL query-path ledger is incomplete/u
  );
});

test("does not substitute a different query that happens to touch the same table", () => {
  const differentQuery = "SELECT name FROM focowiki.knowledge_bases ORDER BY name";
  const report = buildPostgresQueryPathLedger({
    phase: "positive-crud",
    inventory,
    observedStatements: [{
      queryId: "99",
      query: differentQuery,
      calls: 1,
      plans: 1,
      rows: 1,
      totalPlanTimeMs: 0,
      totalExecTimeMs: 0.1,
      maximumExecTimeMs: 0.1,
      sharedBlocksHit: 1,
      sharedBlocksRead: 0,
      tempBlocksWritten: 0,
      walRecords: 0,
      walBytes: 0
    }],
    planEvidence: [],
    runtime: {
      databaseDeadlocks: 0,
      blockedSessions: 0,
      longestTransactionMs: 0
    }
  });

  assert.equal(report.rows[0].runtime, null);
  assert.equal(report.ok, false);
});

test("maps one uniquely anchored runtime expansion of a dynamic SQL fragment", () => {
  const dynamicShape = createPostgresQueryShape(`
    SELECT source.public_id
    FROM focowiki.source_files AS source
    \${optionalJoin}
    WHERE source.knowledge_base_id = \${knowledgeBaseId}
    ORDER BY source.public_id
  `);
  const expandedQuery = `
    SELECT source.public_id
    FROM focowiki.source_files AS source
    JOIN focowiki.source_file_active_revisions AS current_revision
      ON current_revision.source_file_public_id = source.public_id
    WHERE source.knowledge_base_id = $1
    ORDER BY source.public_id
  `;
  const dynamicInventory = [{
    ...inventory[0],
    id: "critical-query-path:dynamic.ts:10:read:source_files",
    source: "dynamic.ts",
    tables: ["source_files"],
    queryFingerprint: dynamicShape.fingerprint,
    queryAnchorFingerprint: dynamicShape.anchorFingerprint,
    queryAnchorTokenHashes: dynamicShape.anchorTokenHashes,
    parameterCount: dynamicShape.parameterCount
  }];
  const runtime = {
    queryId: "dynamic-1",
    query: expandedQuery,
    calls: 2,
    plans: 1,
    rows: 2,
    totalPlanTimeMs: 0.1,
    totalExecTimeMs: 0.2,
    maximumExecTimeMs: 0.1,
    sharedBlocksHit: 2,
    sharedBlocksRead: 0,
    tempBlocksWritten: 0,
    walRecords: 0,
    walBytes: 0
  };
  const report = buildPostgresQueryPathLedger({
    phase: "dynamic",
    inventory: dynamicInventory,
    observedStatements: [runtime],
    planEvidence: [{ queryId: runtime.queryId, plan: [{ Plan: { "Node Type": "Nested Loop" } }] }],
    runtime: {
      databaseDeadlocks: 0,
      blockedSessions: 0,
      longestTransactionMs: 0
    }
  });

  assert.equal(report.ok, true);
  assert.equal(report.rows[0].runtime.matchMode, "anchor");
  assert.deepEqual(
    selectPostgresQueryPathRuntimeCandidates({
      inventory: dynamicInventory,
      observedStatements: [runtime, {
        ...runtime,
        queryId: "unrelated",
        query: "SELECT public_id FROM focowiki.openapi_keys"
      }]
    }).map((item) => item.queryId),
    ["dynamic-1"]
  );
});
