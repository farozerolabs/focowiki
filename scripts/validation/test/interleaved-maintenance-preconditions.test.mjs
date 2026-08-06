import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMaintenancePreconditionStatements,
  createInterleavedMaintenancePreconditions
} from "../lib/interleaved-maintenance-preconditions.mjs";

test("does not mutate persistence to manufacture a maintenance precondition", () => {
  const statements = buildMaintenancePreconditionStatements({
    kind: "index-maintenance",
    strategy: "request-run-owned-maintenance",
    knowledgeBaseId: "kb-owned"
  }, "2026-07-26T00:00:00.000Z");

  assert.deepEqual(statements, []);
});

test("records the API-only maintenance precondition without executing SQL", async () => {
  const calls = [];
  const maintenance = createInterleavedMaintenancePreconditions({
    execute: async (statement) => {
      calls.push(statement);
      return [{ prepared: true }];
    },
    now: () => new Date("2026-07-26T00:00:00.000Z")
  });

  const prepared = await maintenance.prepare({
    kind: "index-maintenance",
    strategy: "request-run-owned-maintenance",
    knowledgeBaseId: "kb-owned"
  });

  assert.equal(calls.length, 0);
  assert.equal(prepared.preparedRowCount, 0);
  assert.equal(prepared.strategy, "request-run-owned-maintenance");
});
