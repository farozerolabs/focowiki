import assert from "node:assert/strict";
import test from "node:test";
import { createEvidenceRedactor } from "../lib/interleaved-evidence-redaction.mjs";
import {
  createInterleavedRedisEvidence
} from "../lib/interleaved-redis-evidence.mjs";

test("records Redis key aliases and types without reading values or exposing keys", async () => {
  const valueReads = [];
  const client = {
    async *scanIterator() {
      yield "focowiki:queue:private";
      yield "focowiki:lock:private";
    },
    async type(key) {
      return key.includes("queue") ? "list" : "string";
    },
    async get(key) {
      valueReads.push(key);
    }
  };
  const evidence = createInterleavedRedisEvidence({ client });
  const snapshot = await evidence.snapshot({
    redactor: createEvidenceRedactor("run-seed")
  });

  assert.equal(snapshot.totalKeys, 2);
  assert.deepEqual(snapshot.byType, { list: 1, string: 1 });
  assert.equal(snapshot.keys.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), /queue:private|lock:private/u);
  assert.deepEqual(valueReads, []);
});

test("destroys an owned Redis client whose connection never became ready", async () => {
  const calls = [];
  const client = {
    isOpen: true,
    isReady: false,
    async quit() {
      calls.push("quit");
    },
    destroy() {
      calls.push("destroy");
    }
  };
  const evidence = createInterleavedRedisEvidence({
    client,
    ownsClient: true
  });

  await evidence.close();

  assert.deepEqual(calls, ["destroy"]);
});
