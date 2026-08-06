import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertBoundedSourceFileLifecycle,
  assertResumeSampleIdentity,
  assertRunOwnedSourceIdentity,
  assertRuntimeProcessingSettingsShape,
  createAdminTreeSearchQuery,
  shouldKeepValidationKnowledgeBase,
  validateSourceFileModelEvidence
} from "../cleaned-markdown-flow.mjs";

test("resumes only when the selected sample identity is unchanged", () => {
  const samples = [{ basename: "source.md", checksumSha256: "checksum-1" }];

  assert.doesNotThrow(() => assertResumeSampleIdentity(samples, samples));
  assert.throws(
    () => assertResumeSampleIdentity(
      samples,
      [{ basename: "source.md", checksumSha256: "checksum-2" }]
    ),
    /sample identity changed/
  );
});

test("preserves ownership after one validated source deletion is purged", () => {
  assert.doesNotThrow(() => assertRunOwnedSourceIdentity(
    [{ id: "source-2", relativePath: "nested/two.md" }],
    [
      { relativePath: "nested/one.md" },
      { relativePath: "nested/two.md" }
    ],
    "nested/one.md"
  ));
});

test("validates current processing settings without removed upload admission fields", () => {
  const source = fs.readFileSync("scripts/validation/cleaned-markdown-flow.mjs", "utf8");
  const browserSource = fs.readFileSync("scripts/validation/cleaned-markdown-browser.mjs", "utf8");

  assert.doesNotMatch(source, /uploadGeneration\.[A-Za-z]/);
  assert.doesNotMatch(source, /generationBatchSize|hardDeleteVersionPurgeEnabled/);
  assert.doesNotMatch(browserSource, /worker-generationBatchSize/);
  assert.match(source, /worker\.claimBatchSize/);
  assert.match(browserSource, /worker-claimBatchSize/);
  assert.match(source, /worker\.sourceQueueHardDepth/);
  assert.match(source, /publication\.impactBatchSize/);
  assert.match(source, /publication\.indexShardSize/);
});

test("accepts current positive numeric worker and publication budgets", () => {
  assert.doesNotThrow(() =>
    assertRuntimeProcessingSettingsShape({
      worker: {
        sourceQueueHardDepth: 100,
        claimBatchSize: 20
      },
      publication: {
        impactBatchSize: 50,
        impactConcurrency: 4
      }
    })
  );
});

test("rejects invalid runtime processing setting types", () => {
  assert.throws(
    () =>
      assertRuntimeProcessingSettingsShape({
        worker: {
          sourceQueueHardDepth: 100,
          claimBatchSize: 0
        },
        publication: {
          impactBatchSize: 50,
          impactConcurrency: 4
        }
      }),
    /must be a positive integer/
  );
});

test("derives Admin tree search terms from the logical filename", () => {
  assert.equal(
    createAdminTreeSearchQuery({
      logicalPath: "pages/product/product-overview.md",
      title: "Atlas Workspace Overview"
    }),
    "product-overview"
  );
});

test("keeps the validation knowledge base only when explicitly requested", () => {
  assert.equal(shouldKeepValidationKnowledgeBase({}), false);
  assert.equal(
    shouldKeepValidationKnowledgeBase({ FOCOWIKI_VALIDATION_KEEP_KNOWLEDGE_BASE: "false" }),
    false
  );
  assert.equal(
    shouldKeepValidationKnowledgeBase({ FOCOWIKI_VALIDATION_KEEP_KNOWLEDGE_BASE: "true" }),
    true
  );
});

test("accepts bounded source rows without per-invocation model history", () => {
  const report = {
    checks: [],
    manualReviewItems: [],
    modelAssistance: { enabled: true, modelName: "model-v2" }
  };

  assert.doesNotThrow(() =>
    validateSourceFileModelEvidence(
      [{
        relativePath: "nested/source.md",
        modelInvocationStatus: null,
        modelInvocationModelName: null
      }],
      [{ relativePath: "nested/source.md" }],
      {},
      report
    )
  );
  assert.equal(report.checks.length, 1);
});

test("rejects source rows that retain per-invocation model history", () => {
  assert.throws(
    () =>
      validateSourceFileModelEvidence(
        [{
          relativePath: "source.md",
          modelInvocationStatus: "completed",
          modelInvocationModelName: "model-v2"
        }],
        [{ relativePath: "source.md" }],
        {},
        {
          checks: [],
          manualReviewItems: [],
          modelAssistance: { enabled: true, modelName: "model-v2" }
        }
      ),
    /per-invocation model history/
  );
});

test("accepts a visible source row without per-stage processing history", () => {
  assert.doesNotThrow(() =>
    assertBoundedSourceFileLifecycle({
      id: "source-file-current",
      state: "visible",
      processingStartedAt: null,
      processingEndedAt: null
    })
  );
});

test("rejects non-visible or historically timed source rows", () => {
  assert.throws(
    () =>
      assertBoundedSourceFileLifecycle({
        id: "source-file-running",
        state: "running",
        processingStartedAt: null,
        processingEndedAt: null
      }),
    /visible lifecycle state/
  );
  assert.throws(
    () =>
      assertBoundedSourceFileLifecycle({
        id: "source-file-history",
        state: "visible",
        processingStartedAt: "2026-08-06T00:00:00.000Z",
        processingEndedAt: "2026-08-06T00:00:01.000Z"
      }),
    /per-stage processing history/
  );
});
