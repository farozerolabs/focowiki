import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  assertRuntimeProcessingSettingsShape,
  createAdminTreeSearchQuery,
  expectedModelStageEventCount,
  shouldKeepValidationKnowledgeBase
} from "../cleaned-markdown-flow.mjs";

test("validates current processing settings without removed upload admission fields", () => {
  const source = fs.readFileSync("scripts/validation/cleaned-markdown-flow.mjs", "utf8");

  assert.doesNotMatch(source, /uploadGeneration\.[A-Za-z]/);
  assert.match(source, /worker\.sourceQueueHardDepth/);
  assert.match(source, /publication\.impactBatchSize/);
  assert.match(source, /publication\.indexShardSize/);
});

test("accepts the worker cleanup boolean alongside positive numeric budgets", () => {
  assert.doesNotThrow(() =>
    assertRuntimeProcessingSettingsShape({
      worker: {
        sourceQueueHardDepth: 100,
        hardDeleteVersionPurgeEnabled: false
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
          hardDeleteVersionPurgeEnabled: "false"
        },
        publication: {
          impactBatchSize: 50,
          impactConcurrency: 4
        }
      }),
    /must be a boolean/
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

test("expects one complete model stage event per source file", () => {
  assert.equal(expectedModelStageEventCount(24), 24);
});
