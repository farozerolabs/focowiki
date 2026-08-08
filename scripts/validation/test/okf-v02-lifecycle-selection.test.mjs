import assert from "node:assert/strict";
import test from "node:test";

import { createOkfV02MutationScope } from
  "../lib/okf-v02-lifecycle-selection.mjs";

test("OKF 0.2 lifecycle mutation scope leaves official fixtures unchanged", () => {
  const scope = createOkfV02MutationScope("legacy/");
  assert.equal(scope({ relativePath: "official/concepts/guide.md" }), false);
  assert.equal(scope({ relativePath: "legacy/folder/guide.md" }), true);
  assert.equal(scope({ relativePath: "legacy-folder/guide.md" }), false);
});

test("empty lifecycle mutation scope preserves generic validation behavior", () => {
  const scope = createOkfV02MutationScope("");
  assert.equal(scope({ relativePath: "any/path.md" }), true);
});
