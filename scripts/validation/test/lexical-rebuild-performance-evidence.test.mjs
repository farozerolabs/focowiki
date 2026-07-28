import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

const rootDir = resolve(import.meta.dirname, "../../..");

test("lexical rebuild performance evidence freezes comparable boundaries", () => {
  const profile = JSON.parse(readFileSync(
    resolve(rootDir, "ReferenceDocs/performance/lexical-rebuild/benchmark-profile.json"),
    "utf8"
  ));
  const baseline = JSON.parse(readFileSync(
    resolve(rootDir, "ReferenceDocs/performance/lexical-rebuild/baseline.json"),
    "utf8"
  ));

  assert.equal(profile.dataset.sourceCount, 29_735);
  assert.equal(profile.dataset.largeValidationSourceCount, 10_000);
  assert.equal(
    profile.dataset.largeValidationSelection,
    "first 10000 Markdown files sorted by normalized logical path"
  );
  assert.match(profile.runtime.storageClass, /external S3-compatible/);
  assert.deepEqual(profile.optimizedSettings, {
    concurrency: 4,
    sourceReadConcurrency: 2,
    databaseWriteConcurrency: 2,
    claimBatchSize: 500,
    databaseBatchSize: 50,
    maxInFlightSourceBytes: 67_108_864
  });
  assert.deepEqual(profile.privacy, {
    endpointNamesCommitted: false,
    credentialsCommitted: false,
    sourceBodiesCommitted: false,
    privatePathsCommitted: false
  });
  assert.equal(baseline.largeProfile.effectiveFilesPerSecond, 0.44);
  assert.deepEqual(baseline.acceptance, {
    minimumEffectiveImprovement: 5,
    minimumSustainedFilesPerSecond: 3,
    maximumCompletionSeconds: 10_800,
    maximumClaimGapPollIntervals: 2
  });
  const benchmark = readFileSync(
    resolve(rootDir, "apps/api/scripts/lexical-rebuild-scale-evidence.ts"),
    "utf8"
  );
  assert.match(benchmark, /external S3-compatible object storage/);
  assert.match(benchmark, /processLexicalRebuildClaims/);
  assert.match(benchmark, /runLexicalRebuildFinalization/);
  assert.match(benchmark, /sourceReadLatencyAverageMs/);
  assert.match(benchmark, /databaseWriteDurationMs/);
  assert.match(benchmark, /eventLoopDelayP95Ms/);
  assert.match(benchmark, /Developer OpenAPI/);
  assert.match(benchmark, /modelCalls: 0/);
  assert.match(benchmark, /purgePrefix/);
});

test("optimized lexical evidence preserves reads, search, and sanitized reporting", () => {
  const optimizedPath = resolve(
    rootDir,
    "ReferenceDocs/performance/lexical-rebuild/optimized-120.json"
  );
  const optimizedText = readFileSync(optimizedPath, "utf8");
  const optimized = JSON.parse(optimizedText);

  assert.equal(optimized.dataset.sourceCount, 120);
  assert.equal(optimized.result.completed_work_items, 120);
  assert.equal(optimized.result.failed_work_items, 0);
  assert.ok(optimized.comparison.throughputMultiple >= 5);
  assert.ok(optimized.result.filesPerSecond >= 3);
  assert.equal(optimized.acceptance.passed, true);
  assert.deepEqual(optimized.acceptance.failures, []);

  assert.equal(optimized.httpReads.security.adminLoginAuthenticated, true);
  assert.equal(optimized.httpReads.security.openApiUnauthorizedStatus, 401);
  assert.equal(optimized.httpReads.security.openApiUnauthorizedErrorCode, "UNAUTHORIZED");
  assert.ok(optimized.httpReads.security.invalidCursorStatus >= 400);
  assert.ok(optimized.httpReads.security.invalidCursorStatus < 500);
  assert.ok(optimized.httpReads.security.invalidCursorErrorCode);
  assert.deepEqual(optimized.httpReads.cursor, {
    available: true,
    continuous: true,
    generationConsistent: true
  });
  assert.equal(optimized.httpReads.loaded.statusesOk, true);
  assert.equal(optimized.httpReads.loaded.contentStable, true);
  assert.equal(optimized.httpReads.loaded.activeGenerationConsistent, true);
  assert.equal(optimized.httpReads.idleBefore.content.count, 128);
  assert.equal(optimized.httpReads.idleAfter.content.count, 128);
  assert.equal(optimized.httpReads.acceptance.contentDriftEnforced, true);
  assert.equal(optimized.httpReads.acceptance.passed, true);

  for (const mode of ["file", "graph", "hybrid"]) {
    const before = optimized.searchComparison.before[mode];
    const after = optimized.searchComparison.after[mode];
    assert.ok(before.resultCount > 0);
    assert.ok(after.resultCount > 0);
    assert.equal(before.generationConsistent, true);
    assert.equal(after.generationConsistent, true);
    assert.equal(after.topPath, "pages/evidence/source-0000000.md");
    assert.match(after.topSourceUrl, /^https:\/\/flk\.npc\.gov\.cn\//);
  }
  assert.equal(
    optimized.searchComparison.acceptedEdgesAfter,
    optimized.searchComparison.acceptedEdgesBefore
  );

  assert.match(optimized.comparison.stages.activeProcessing.baseline, /1,000-source slice/);
  assert.match(optimized.comparison.stages.activeProcessing.optimized, /120 sources/);
  assert.equal(optimized.comparison.stages.sourceRead.baseline, "not captured");
  assert.equal(optimized.comparison.stages.databasePersistence.baseline, "not captured");

  assert.doesNotMatch(optimizedText, /(?:access|secret)[_-]?key/i);
  assert.doesNotMatch(optimizedText, /\/Users\//);
  assert.doesNotMatch(optimizedText, /https?:\/\/[^"]*(?:r2|amazonaws|s3)[^"]*/i);
  assert.doesNotMatch(optimizedText, /lexical-rebuild-evidence\//);
});

test("10,000-file real-content lexical evidence passes every release gate", () => {
  const optimizedPath = resolve(
    rootDir,
    "ReferenceDocs/performance/lexical-rebuild/optimized-10000.json"
  );
  const optimizedText = readFileSync(optimizedPath, "utf8");
  const optimized = JSON.parse(optimizedText);

  assert.equal(optimized.dataset.identity, "frozen-real-markdown-10000");
  assert.equal(optimized.dataset.sourceCount, 10_000);
  assert.equal(
    optimized.dataset.selection,
    "first 10000 Markdown files sorted by normalized logical path"
  );
  assert.equal(optimized.settings.sourceReadConcurrency, 2);
  assert.equal(optimized.result.claimed, 10_000);
  assert.equal(optimized.result.completed_work_items, 10_000);
  assert.equal(optimized.result.failed_work_items, 0);
  assert.equal(optimized.result.retried, 0);
  assert.equal(optimized.result.activated, true);
  assert.ok(optimized.result.activeProcessingElapsedMs > 0);
  assert.ok(optimized.result.filesPerSecond >= 3);
  assert.ok(optimized.comparison.throughputMultiple >= 5);
  assert.ok(optimized.result.elapsedMs <= 10_800_000);
  assert.ok(optimized.result.maximumClaimGapMs <= 2_000);
  assert.ok(
    optimized.resources.rssGrowthBytes
      <= optimized.settings.maxInFlightSourceBytes * 2
  );
  assert.equal(optimized.settingsRevision, 1);
  assert.equal(
    optimized.storage.readRequests,
    10_000 + optimized.storage.retries
  );
  assert.equal(optimized.storage.readBytes, optimized.dataset.sourceBytes);
  assert.equal(optimized.storage.errors, optimized.storage.retries);
  assert.ok(optimized.storage.readLatency.p50Ms > 0);
  assert.ok(optimized.storage.readLatency.p95Ms >=
    optimized.storage.readLatency.p50Ms);
  assert.ok(optimized.postgres.databaseBatchLatency.p50Ms > 0);
  assert.ok(optimized.postgres.databaseBatchLatency.p95Ms >=
    optimized.postgres.databaseBatchLatency.p50Ms);
  assert.ok(optimized.postgres.sessions.sampleCount > 0);
  assert.ok(optimized.postgres.sessions.maximumTotal > 0);
  assert.ok(optimized.postgres.sessions.maximumActive >= 0);
  assert.equal(optimized.httpReads.idleBefore.content.count, 128);
  assert.equal(optimized.httpReads.idleAfter.content.count, 128);
  assert.equal(optimized.httpReads.loaded.statusesOk, true);
  assert.equal(optimized.httpReads.loaded.contentStable, true);
  assert.equal(optimized.httpReads.loaded.activeGenerationConsistent, true);
  assert.equal(optimized.httpReads.acceptance.passed, true);
  assert.equal(optimized.searchComparison.acceptedEdgesAfter,
    optimized.searchComparison.acceptedEdgesBefore);
  assert.equal(optimized.acceptance.passed, true);
  assert.deepEqual(optimized.acceptance.failures, []);

  assert.doesNotMatch(optimizedText, /(?:access|secret)[_-]?key/i);
  assert.doesNotMatch(optimizedText, /\/Users\//);
  assert.doesNotMatch(optimizedText, /https?:\/\/[^"]*(?:r2|amazonaws|s3)[^"]*/i);
  assert.doesNotMatch(optimizedText, /lexical-rebuild-evidence\//);
});
