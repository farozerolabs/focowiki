import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMaintenancePreconditionStatements,
  createInterleavedMaintenancePreconditions
} from "../lib/interleaved-maintenance-preconditions.mjs";

test("keeps projection and lexical invalidation scoped to one run-owned knowledge base", () => {
  const projection = buildMaintenancePreconditionStatements({
    kind: "projection-repair",
    strategy: "invalidate-run-owned-projection-version",
    knowledgeBaseId: "kb-owned",
    projectionKind: "tree"
  }, "2026-07-26T00:00:00.000Z");
  const lexical = buildMaintenancePreconditionStatements({
    kind: "lexical-rebuild",
    strategy: "invalidate-run-owned-lexical-version",
    knowledgeBaseId: "kb-owned",
    staleVersion: "validation-run"
  }, "2026-07-26T00:00:00.000Z");

  assert.equal(projection.length, 1);
  assert.match(projection[0].text, /WHERE knowledge_base_id = \$1/u);
  assert.deepEqual(projection[0].parameters, ["kb-owned", "tree"]);

  assert.equal(lexical.length, 1);
  assert.match(lexical[0].text, /knowledge_base\.id = \$1/u);
  assert.match(lexical[0].text, /generation\.id = knowledge_base\.active_generation_id/u);
  assert.deepEqual(lexical[0].parameters, [
    "kb-owned",
    "2026-07-26T00:00:00.000Z"
  ]);
});

test("advances only the configured reconciliation prefix", () => {
  const statements = buildMaintenancePreconditionStatements({
    kind: "storage-reconciliation",
    strategy: "advance-existing-cycle",
    knowledgeBaseId: "kb-owned",
    prefix: "test-prefix/generated/"
  }, "2026-07-26T00:00:00.000Z");

  assert.equal(statements.length, 1);
  assert.match(
    statements[0].text,
    /WHERE focowiki\.storage_reconciliation_cycles\.prefix = \$1/u
  );
  assert.match(statements[0].text, /state IN \('idle', 'failed'\)/u);
  assert.deepEqual(statements[0].parameters, [
    "test-prefix/generated/",
    "2026-07-26T00:00:00.000Z"
  ]);
});

test("executes prepared statements and preserves natural compaction", async () => {
  const calls = [];
  const maintenance = createInterleavedMaintenancePreconditions({
    execute: async (statement) => {
      calls.push(statement);
      return [{ prepared: true }];
    },
    now: () => new Date("2026-07-26T00:00:00.000Z")
  });

  const projection = await maintenance.prepare({
    kind: "projection-repair",
    strategy: "invalidate-run-owned-projection-version",
    knowledgeBaseId: "kb-owned",
    projectionKind: "tree"
  });
  const compaction = await maintenance.prepare({
    kind: "projection-compaction",
    strategy: "natural-segment-amplification",
    knowledgeBaseId: "kb-owned",
    requiredActiveSegmentCount: 9
  });

  assert.equal(calls.length, 1);
  assert.equal(projection.preparedRowCount, 1);
  assert.equal(compaction.preparedRowCount, 0);
  assert.equal(compaction.strategy, "natural-segment-amplification");
});
