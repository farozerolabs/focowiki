import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const sourcePath = path.resolve(
  import.meta.dirname,
  "../folder-aware-resource-lifecycle.mjs"
);
const interleavedPath = path.resolve(
  import.meta.dirname,
  "../run-interleaved-lifecycle-e2e.mjs"
);
const boundaryPath = path.resolve(
  import.meta.dirname,
  "../run-interleaved-boundaries.mjs"
);

test("resource lifecycle polling respects the public API rate limit", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /const OPERATION_POLL_INTERVAL_MS = 5_000;/u);
  assert.match(source, /response\.status !== 429/u);
  assert.match(source, /response\.headers\.get\("retry-after"\)/u);
});

test("resource lifecycle proves every OpenAPI operation through real responses", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /createOpenApiOperationCoverage/u);
  assert.match(source, /checkEveryOperationRejectsMissingAuthentication/u);
  assert.match(source, /report\.operationCoverage = operationCoverage\.summary/u);
  assert.match(source, /retryKnowledgeBaseSourceFile: \[409\]/u);
  assert.match(source, /operationCoverage\.complete/u);
});

test("resource lifecycle invokes upload reconciliation even without contention", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /`\$\{base\}\/\$\{encodeURIComponent\(sessionId\)\}\/reconcile`/u
  );
});

test("resource lifecycle does not submit removed publication settings", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.doesNotMatch(source, /batchSize/u);
  assert.match(source, /intervalSeconds: 5/u);
});

test("resource lifecycle shortens only validation retry delays", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /jobRetryDelayMs: 100/u);
  assert.match(source, /hardDeleteRetryDelayMs: 100/u);
});

test("resource lifecycle selects a link-closed sample with corpus-relative paths", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /selectClosedMarkdownSample\(\{/u);
  assert.match(source, /const selectedPaths = exactOkfCorpus\s+\? markdownFiles/u);
  assert.match(source, /RESERVED_SOURCE_FILENAME/u);
  assert.match(source, /!RESERVED_SOURCE_FILENAME\.test\(path\.basename\(filePath\)\)/u);
  assert.match(source, /path\.relative\(sampleRoot, filePath\)/u);
  assert.doesNotMatch(source, /real-corpus\/group-/u);
});

test("exact corpus webhook coverage observes the delete-and-recreate source event", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(
    source,
    /const recreateWebhookId = exactOkfCorpus[\s\S]*?uploadAfterDeletion[\s\S]*?verifyWebhookOperations\(recreateWebhookId\)/u
  );
  assert.doesNotMatch(source, /webhook-replace/u);
});

test("retained lifecycle validates knowledge-base deletion on an isolated fixture", async () => {
  const source = await readFile(sourcePath, "utf8");

  assert.match(source, /await checkTemporaryKnowledgeBaseDeletion\(\);/u);
  assert.match(
    source,
    /async function checkTemporaryKnowledgeBaseDeletion\(\)[\s\S]*?method: "DELETE"[\s\S]*?waitUntilMissing/u
  );
});

test("interleaved lifecycle preserves linked corpus basenames and mutates controls", async () => {
  const source = await readFile(interleavedPath, "utf8");

  assert.match(source, /selectClosedMarkdownSample\(\{/u);
  assert.match(source, /relativePath: `baseline\/\$\{sample\.basename\}`/u);
  assert.match(source, /relativePath: "baseline\/nested\/primary\.md"/u);
  assert.match(source, /relativePath: "baseline\/secondary\.md"/u);
  assert.match(source, /A link-free source for interleaved upload/u);
  assert.doesNotMatch(
    source,
    /relativePath: "baseline\/nested\/primary\.md",\s+bytes: sampleBytes/u
  );
});

test("boundary identity fixture retains its live upload entry before terminal compaction", async () => {
  const source = await readFile(boundaryPath, "utf8");

  assert.match(source, /const entry = missing\.entries\?\.items\?\.\[0\];/u);
  assert.match(source, /await upload\.finalize\(sessionId\);/u);
  assert.doesNotMatch(
    source,
    /const completed = await upload\.get\(sessionId, \{ limit: 500 \}\);/u
  );
});
