import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const lockedFixturePaths = [
  "scripts/validation/fixtures/comprehensive-production-authenticity.json",
  "scripts/validation/fixtures/comprehensive-release-inventory.json",
  "scripts/validation/fixtures/comprehensive-test-inventory.json"
];

const generatorPaths = [
  "scripts/validation/generate-comprehensive-authenticity.mjs",
  "scripts/validation/generate-comprehensive-inventory.mjs",
  "scripts/validation/generate-comprehensive-test-baseline.mjs"
];

test("validates the live repository without committed source inventory snapshots", () => {
  for (const fixturePath of lockedFixturePaths) {
    assert.equal(fs.existsSync(fixturePath), false, fixturePath);
  }

  for (const generatorPath of generatorPaths) {
    const source = fs.readFileSync(generatorPath, "utf8");
    assert.doesNotMatch(source, /fixtures\/comprehensive-/u, generatorPath);
    assert.doesNotMatch(source, /process\.argv\.includes\("--write"\)/u, generatorPath);
  }
});
