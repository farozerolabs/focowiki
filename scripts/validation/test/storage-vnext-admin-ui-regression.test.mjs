import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../storage-vnext-admin-ui-regression.mjs", import.meta.url);

test("keeps Admin UI browser regression isolated to one run-owned knowledge base", async () => {
  const source = await readFile(scriptUrl, "utf8");

  assert.match(source, /kb-run-owned-/);
  assert.match(source, /controlKnowledgeBase/);
  assert.match(source, /assertRunOwnedWrite/);
  assert.match(source, /writeTargets/);
  assert.match(source, /\*\*\/admin\/api\/\*\*/);
  assert.match(source, /createServer/);
  assert.match(source, /chromium\.launch/);
  assert.match(source, /browser\.close/);
  assert.match(source, /server\.close/);
});

test("covers released Admin UI state without changing or recording UI artifacts", async () => {
  const source = await readFile(scriptUrl, "utf8");

  for (const state of [
    "list",
    "detail",
    "settings",
    "upload",
    "mutation",
    "delete",
    "maintenance",
    "polling",
    "navigation",
    "layout",
    "productCopy"
  ]) {
    assert.match(source, new RegExp(`recordCheck\\(\\s*[\"']${state}[\"']`));
  }

  assert.doesNotMatch(source, /process\.env/);
  assert.doesNotMatch(source, /\.env/);
  assert.doesNotMatch(source, /screenshot\s*\(/);
  assert.doesNotMatch(source, /writeFile/);
  assert.doesNotMatch(source, /browser-validation-report/);
  assert.doesNotMatch(source, /\.playwright-cli/);
});
