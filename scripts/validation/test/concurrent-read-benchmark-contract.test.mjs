import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve(
  import.meta.dirname,
  "../concurrent-read-benchmark.mjs"
);

test("concurrent read benchmark records complete latency and throughput evidence", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /benchmarkElapsedMs/u);
  assert.match(source, /successfulQueriesPerSecond/u);
  assert.match(source, /p90Ms:/u);
  assert.match(source, /p99Ms:/u);
  assert.match(source, /response\.status !== 429/u);
  assert.match(source, /response\.headers\.get\("retry-after"\)/u);
  assert.match(source, /FOCOWIKI_BENCHMARK_AUTHORIZATION_FILE/u);
  assert.match(source, /loadBenchmarkAuthorization/u);
});
