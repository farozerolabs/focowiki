import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const source = fs.readFileSync(
  new URL("../../../apps/api/scripts/capture-storage-vnext-before-state.ts", import.meta.url),
  "utf8"
);

test("captures strict before or after snapshots without overwriting evidence", () => {
  assert.match(source, /FOCOWIKI_STORAGE_VNEXT_STATE_PHASE/u);
  assert.match(source, /phase !== "before" && phase !== "after"/u);
  assert.match(source, /`focowiki-storage-vnext-\$\{phase\}-state`/u);
  assert.match(source, /`\$\{proof\.filesystemScope\}\/\$\{phase\}-state\.json`/u);
  assert.match(source, /flag: "wx"/u);
});
