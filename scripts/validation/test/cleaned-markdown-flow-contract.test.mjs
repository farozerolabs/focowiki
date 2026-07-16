import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createAdminTreeSearchQuery,
  shouldKeepValidationKnowledgeBase
} from "../cleaned-markdown-flow.mjs";

test("validates current upload-session bounds without removed max-files settings", () => {
  const source = fs.readFileSync("scripts/validation/cleaned-markdown-flow.mjs", "utf8");

  assert.doesNotMatch(source, /uploadGeneration\.maxFiles/);
  assert.match(source, /uploadGeneration\.manifestPageSize/);
  assert.match(source, /uploadGeneration\.contentBatchMaxFiles/);
  assert.match(source, /uploadGeneration\.contentBatchMaxBytes/);
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
