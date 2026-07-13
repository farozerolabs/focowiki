import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const validationModules = [
  "scripts/validation/full-system-coverage.mjs",
  "scripts/validation/full-system-release-gate.mjs",
  "scripts/validation/lib/full-system-coverage.mjs",
  "scripts/validation/lib/full-system-plan.mjs",
  "scripts/validation/lib/full-system-report.mjs",
  "scripts/validation/lib/full-system-run-state.mjs"
];

test("full-system validation modules stay independent from product internals", () => {
  for (const filePath of validationModules) {
    const source = fs.readFileSync(filePath, "utf8");
    assert.doesNotMatch(source, /from\s+["'][^"']*apps\//, filePath);
    assert.doesNotMatch(source, /from\s+["'][^"']*packages\//, filePath);
    assert.ok(source.split("\n").length < 320, `${filePath} should remain focused`);
  }
});

test("orchestration delegates coverage, planning, reporting, and redaction", () => {
  const source = fs.readFileSync(
    "scripts/validation/full-system-release-gate.mjs",
    "utf8"
  );

  assert.match(source, /full-system-plan\.mjs/);
  assert.match(source, /full-system-report\.mjs/);
  assert.doesNotMatch(source, /EXPECTED_DEVELOPER_OPENAPI_OPERATIONS/);
  assert.doesNotMatch(source, /writeFileSync/);
});
