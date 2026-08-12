import assert from "node:assert/strict";
import test from "node:test";

import {
  requestWithRateLimitRetry
} from "../lib/comprehensive-rate-limit-retry.mjs";

test("retries a bounded Admin validation request after the documented delay", async () => {
  const responses = [
    { status: 429, retryAfter: "2" },
    { status: 200, retryAfter: null }
  ];
  const waits = [];

  const result = await requestWithRateLimitRetry({
    request: async () => responses.shift(),
    wait: async (milliseconds) => waits.push(milliseconds),
    maximumRetries: 2
  });

  assert.equal(result.status, 200);
  assert.deepEqual(waits, [2_000]);
});

test("fails closed when repeated rate limits exhaust the retry budget", async () => {
  let calls = 0;

  await assert.rejects(
    requestWithRateLimitRetry({
      request: async () => {
        calls += 1;
        return { status: 429, retryAfter: "0" };
      },
      wait: async () => {},
      maximumRetries: 1
    }),
    /Rate-limit retry budget exhausted/u
  );
  assert.equal(calls, 2);
});

test("bounds invalid or excessive retry-after values", async () => {
  const waits = [];
  const responses = [
    { status: 429, retryAfter: "invalid" },
    { status: 429, retryAfter: "600" },
    { status: 204, retryAfter: null }
  ];

  await requestWithRateLimitRetry({
    request: async () => responses.shift(),
    wait: async (milliseconds) => waits.push(milliseconds),
    maximumRetries: 2
  });

  assert.deepEqual(waits, [1_000, 60_000]);
});
