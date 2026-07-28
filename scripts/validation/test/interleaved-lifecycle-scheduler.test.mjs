import assert from "node:assert/strict";
import test from "node:test";
import {
  createDeferredLifecycleAction,
  executeLifecycleSchedule
} from "../lib/interleaved-lifecycle-scheduler.mjs";

test("defers lifecycle completion without blocking sibling starts", async () => {
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const events = [];
  const action = createDeferredLifecycleAction(async () => {
    events.push("work-started");
    await gate;
    events.push("work-completed");
    return { state: "completed" };
  });

  await Promise.resolve();
  assert.deepEqual(events, ["work-started"]);

  const settled = action.settle();
  assert.deepEqual(events, ["work-started"]);
  release();

  assert.deepEqual(await settled, { state: "completed" });
  assert.deepEqual(events, ["work-started", "work-completed"]);
});

test("starts every lifecycle in the requested order before settling work", async () => {
  const events = [];
  const actions = Object.fromEntries(
    ["upload", "modification", "deletion"].map((lifecycle) => [
      lifecycle,
      async () => {
        events.push(`start:${lifecycle}`);
        return {
          async settle() {
            events.push(`settle:${lifecycle}`);
            return { state: "completed" };
          }
        };
      }
    ])
  );

  const result = await executeLifecycleSchedule({
    order: ["upload", "modification", "deletion"],
    actions
  });

  assert.deepEqual(events, [
    "start:upload",
    "start:modification",
    "start:deletion",
    "settle:upload",
    "settle:modification",
    "settle:deletion"
  ]);
  assert.deepEqual(
    result.outcomes.map((outcome) => [outcome.lifecycle, outcome.state]),
    [
      ["upload", "completed"],
      ["modification", "completed"],
      ["deletion", "completed"]
    ]
  );
});

test("records one rejected lifecycle without hiding sibling outcomes", async () => {
  const result = await executeLifecycleSchedule({
    order: ["upload", "deletion"],
    actions: {
      upload: async () => ({
        settle: async () => {
          const error = new Error("Upload lost the ownership race.");
          error.code = "RESOURCE_CONFLICT";
          throw error;
        }
      }),
      deletion: async () => ({
        settle: async () => ({ state: "completed" })
      })
    }
  });

  assert.deepEqual(result.outcomes, [
    {
      lifecycle: "upload",
      state: "failed",
      errorCode: "RESOURCE_CONFLICT"
    },
    {
      lifecycle: "deletion",
      state: "completed",
      errorCode: null
    }
  ]);
});

test("bounds lifecycle settlement by the scenario deadline", async () => {
  const startedAt = Date.now();
  const result = await executeLifecycleSchedule({
    order: ["maintenance", "deletion"],
    deadlineMs: 25,
    actions: {
      maintenance: async () => ({
        settle: async () => new Promise(() => undefined)
      }),
      deletion: async () => ({
        settle: async () => ({ state: "completed" })
      })
    }
  });

  assert.ok(Date.now() - startedAt < 1_000);
  assert.deepEqual(result.outcomes, [
    {
      lifecycle: "maintenance",
      state: "failed",
      errorCode: "LIFECYCLE_DEADLINE_EXCEEDED"
    },
    {
      lifecycle: "deletion",
      state: "completed",
      errorCode: null
    }
  ]);
});

test("rejects duplicate or unsupported lifecycle schedules", async () => {
  await assert.rejects(
    executeLifecycleSchedule({
      order: ["upload", "upload"],
      actions: { upload: async () => ({}) }
    }),
    /unique/u
  );
  await assert.rejects(
    executeLifecycleSchedule({
      order: ["upload", "maintenance"],
      actions: { upload: async () => ({}) }
    }),
    /missing action/u
  );
});
