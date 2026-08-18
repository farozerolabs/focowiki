import assert from "node:assert/strict";
import test from "node:test";

import {
  assertCorpusExpectationLedger,
  buildCorpusExpectationLedger,
  buildSanitizedCorpusManifest
} from "../lib/comprehensive-corpus.mjs";

function files(family, count) {
  return Array.from({ length: count }, (_, index) => ({
    relativePath: `${family}/file-${String(index).padStart(3, "0")}.md`,
    checksumSha256: String(index + 1).padStart(64, "0"),
    sizeBytes: index + 1,
    frontmatterReadable: true,
    bodyReadable: true,
    metadataClassification: family === "official" ? "native-v02" : "legacy-v01"
  }));
}

test("builds an exact sanitized 53 plus 147 corpus manifest", () => {
  const manifest = buildSanitizedCorpusManifest({
    official: files("official", 53),
    legacy: files("legacy", 147)
  });
  assert.deepEqual(manifest.counts, { official: 53, legacy: 147, total: 200 });
  assert.equal(manifest.rows.every((row) => !JSON.stringify(row).includes("relativePath")), true);
  assert.equal(new Set(manifest.rows.map((row) => row.pathHash)).size, 200);
});

test("prepares every per-file expectation before upload", () => {
  const manifest = buildSanitizedCorpusManifest({
    official: files("official", 53),
    legacy: files("legacy", 147)
  });
  const ledger = buildCorpusExpectationLedger(manifest);
  assert.doesNotThrow(() => assertCorpusExpectationLedger(manifest, ledger));
  delete ledger.rows[0].expectations.search;
  assert.throws(() => assertCorpusExpectationLedger(manifest, ledger), /incomplete/u);
});

test("rejects incomplete and colliding corpus families", () => {
  assert.throws(() => buildSanitizedCorpusManifest({
    official: files("official", 52),
    legacy: files("legacy", 147)
  }), /exactly/u);
  const legacy = files("legacy", 147);
  legacy[0].relativePath = "official/file-000.md";
  assert.throws(() => buildSanitizedCorpusManifest({
    official: files("official", 53),
    legacy
  }), /colliding/u);
});
