import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("live model probe treats absent resources as already clean and registers created resources", () => {
  const source = fs.readFileSync(
    "scripts/validation/comprehensive-live-model-probe.mjs",
    "utf8"
  );

  assert.match(source, /cleanup:\s*\{\s*knowledgeBaseDeleted:\s*true,\s*keyDeleted:\s*true,\s*settingsRestored:\s*true\s*\}/u);
  assert.match(source, /knowledgeBaseId\s*=\s*createdKnowledgeBase\.knowledgeBase\?\.id;\s*report\.cleanup\.knowledgeBaseDeleted\s*=\s*false;/u);
  assert.match(source, /keyId\s*=\s*createdKey\.key\?\.id;\s*report\.cleanup\.keyDeleted\s*=\s*false;/u);
  assert.match(source, /originalPublication\s*=\s*runtime\.settings\.publication;\s*report\.cleanup\.settingsRestored\s*=\s*false;/u);
});
