import assert from "node:assert/strict";
import test from "node:test";

import {
  OKF_V02_RUNTIME_VARIANTS,
  buildOkfV02ValidMarkdown
} from "../lib/okf-v02-runtime-cases.mjs";

test("runtime variants cover each required non-blocking signal family one by one", () => {
  assert.deepEqual(
    OKF_V02_RUNTIME_VARIANTS.map((variant) => variant.id),
    [
      "missing-standard-fields",
      "status-wrong-type",
      "status-unsupported-value",
      "stale-after-wrong-format",
      "generated-wrong-type",
      "generated-date-only-datetime",
      "verified-wrong-shape",
      "sources-wrong-shape",
      "runtime-wrong-type",
      "parameters-wrong-type",
      "executor-wrong-type",
      "attester-wrong-type"
    ]
  );
  assert.equal(new Set(OKF_V02_RUNTIME_VARIANTS.map((item) => item.id)).size, 12);
  assert.equal(OKF_V02_RUNTIME_VARIANTS.every((item) => item.markdown.includes("okfv02e2etoken")), true);
});

test("valid runtime fixture is native OKF 0.2 with truthful trust signals", () => {
  const markdown = buildOkfV02ValidMarkdown("restored");
  assert.match(markdown, /okf_version: ['"]0\.2['"]/u);
  assert.match(markdown, /sources:/u);
  assert.match(markdown, /generated:/u);
  assert.match(markdown, /verified:/u);
  assert.match(markdown, /status: stable/u);
  assert.match(markdown, /stale_after: ['"]2027-12-31['"]/u);
  assert.doesNotMatch(markdown, /timestamp:/u);
  assert.doesNotMatch(markdown, /\[\^\d+\]/u);
});
