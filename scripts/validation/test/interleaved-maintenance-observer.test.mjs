import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyMaintenanceObservation,
  maintenanceObservationQuery,
  waitForMaintenanceStart,
  waitForMaintenanceLifecycle
} from "../lib/interleaved-maintenance-observer.mjs";

test("builds knowledge-base-scoped maintenance observation queries", () => {
  const query = maintenanceObservationQuery({
    kind: "index-maintenance",
    knowledgeBaseId: "kb-owned"
  });
  assert.match(query.text, /FROM focowiki\.operations AS operation/u);
  assert.match(query.text, /operation\.knowledge_base_id = \$1/u);
  assert.match(query.text, /operation\.operation_kind = 'maintenance'/u);
  assert.deepEqual(query.parameters, ["kb-owned"]);
});

test("classifies fast terminal maintenance as started after the precondition", () => {
  const observation = classifyMaintenanceObservation({
    kind: "index-maintenance",
    preparedAt: "2026-07-26T00:00:00.000Z",
    row: {
      state: "completed",
      phase: "completed",
      created_at: "2026-07-26T00:00:01.000Z",
      updated_at: "2026-07-26T00:00:02.000Z",
      completed_at: "2026-07-26T00:00:02.000Z",
      last_error_code: null
    }
  });

  assert.equal(observation.started, true);
  assert.equal(observation.terminal, true);
  assert.equal(observation.succeeded, true);
});

test("waits for a maintenance lifecycle to start and finish", async () => {
  const rows = [
    null,
    {
      state: "running",
      phase: "tree",
      created_at: "2026-07-26T00:00:01.000Z",
      updated_at: "2026-07-26T00:00:01.000Z",
      completed_at: null,
      last_error_code: null
    },
    {
      state: "completed",
      phase: "completed",
      created_at: "2026-07-26T00:00:01.000Z",
      updated_at: "2026-07-26T00:00:02.000Z",
      completed_at: "2026-07-26T00:00:02.000Z",
      last_error_code: null
    }
  ];
  const observed = [];
  let index = 0;
  const result = await waitForMaintenanceLifecycle({
    kind: "index-maintenance",
    preparedAt: "2026-07-26T00:00:00.000Z",
    observe: async () => rows[Math.min(index++, rows.length - 1)],
    pollIntervalMs: 1,
    timeoutMs: 100,
    onObservation: (item) => observed.push(item)
  });

  assert.equal(result.succeeded, true);
  assert.ok(observed.some((item) => item.started && !item.terminal));
  assert.equal(observed.at(-1).terminal, true);
});

test("returns at the first observed running maintenance barrier", async () => {
  const rows = [
    null,
    {
      state: "running",
      phase: "tree",
      created_at: "2026-07-26T00:00:01.000Z",
      updated_at: "2026-07-26T00:00:01.000Z",
      completed_at: null,
      last_error_code: null
    }
  ];
  let index = 0;
  const result = await waitForMaintenanceStart({
    kind: "index-maintenance",
    preparedAt: "2026-07-26T00:00:00.000Z",
    observe: async () => rows[Math.min(index++, rows.length - 1)],
    pollIntervalMs: 1,
    timeoutMs: 100
  });

  assert.equal(result.started, true);
  assert.equal(result.terminal, false);
  assert.equal(result.phase, "tree");
});
