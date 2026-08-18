import assert from "node:assert/strict";
import test from "node:test";

import {
  createChangedObjectCounter,
  createDeterministicEmbedding,
  createNormalizedGraphRagOutput,
  createOperationBarrier,
  createProviderVectorExpectation,
  runBoundedConcurrent,
  sampleProcessResources
} from "../lib/semantic-test-helpers.mjs";

test("deterministic embeddings are finite, normalized, stable, and dimensioned", () => {
  const first = createDeterministicEmbedding("alpha", 12);
  const second = createDeterministicEmbedding("alpha", 12);
  assert.deepEqual(first, second);
  assert.equal(first.length, 12);
  assert.ok(first.every(Number.isFinite));
  assert.ok(Math.abs(Math.sqrt(first.reduce((sum, value) => sum + value * value, 0)) - 1) < 1e-12);
});

test("GraphRAG and provider fixtures expose only Focowiki-owned normalized shapes", () => {
  assert.deepEqual(createNormalizedGraphRagOutput().entities, []);
  const expectation = createProviderVectorExpectation({ family: "entity" });
  assert.equal(expectation.family, "entity");
  assert.equal(expectation.vector.length, expectation.dimension);
});

test("operation barriers hold work until the test releases it", async () => {
  const barrier = createOperationBarrier(2);
  const order = [];
  const first = barrier.arrive().then(() => order.push("first"));
  const second = barrier.arrive().then(() => order.push("second"));
  await barrier.ready;
  assert.equal(barrier.arrivals, 2);
  assert.deepEqual(order, []);
  barrier.release();
  await Promise.all([first, second]);
  assert.deepEqual(order.sort(), ["first", "second"]);
});

test("changed-object counters retain bounded owner evidence", () => {
  const counter = createChangedObjectCounter();
  counter.record("vector-write", "entity-b");
  counter.record("vector-write", "entity-a");
  counter.record("vector-write", "entity-a");
  assert.equal(counter.count("vector-write"), 3);
  assert.deepEqual(counter.ownerPublicIds("vector-write"), ["entity-a", "entity-b"]);
  assert.deepEqual(counter.snapshot(), { "vector-write": 3 });
});

test("resource samples are finite and bounded concurrency preserves result order", async () => {
  const sample = sampleProcessResources();
  assert.ok(sample.rssBytes > 0);
  assert.ok(sample.heapUsedBytes > 0);
  assert.ok(Number.isFinite(sample.userCpuMicros));

  let active = 0;
  let maximumActive = 0;
  const results = await runBoundedConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setImmediate(resolve));
    active -= 1;
    return value * 2;
  });
  assert.deepEqual(results, [2, 4, 6, 8, 10]);
  assert.equal(maximumActive, 2);
});
