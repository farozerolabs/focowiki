import assert from "node:assert/strict";
import test from "node:test";

import {
  waitForResourceRevision
} from "../lib/comprehensive-resource-revision-wait.mjs";

test("waits for the active resource revision before dependent mutations", async () => {
  const revisions = [1, 1, 2];
  const waits = [];

  const resource = await waitForResourceRevision({
    expectedRevision: 2,
    read: async () => ({ resourceRevision: revisions.shift() }),
    wait: async (milliseconds) => waits.push(milliseconds),
    intervalMs: 500,
    maximumAttempts: 3
  });

  assert.equal(resource.resourceRevision, 2);
  assert.deepEqual(waits, [500, 500]);
});

test("fails closed when activation does not reach the expected revision", async () => {
  await assert.rejects(
    waitForResourceRevision({
      expectedRevision: 2,
      read: async () => ({ resourceRevision: 1 }),
      wait: async () => {},
      intervalMs: 100,
      maximumAttempts: 2
    }),
    /Timed out waiting for resource revision 2/u
  );
});
