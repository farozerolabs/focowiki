import assert from "node:assert/strict";
import test from "node:test";

import {
  assertNoSensitiveEvidence,
  createSanitizedEvidence
} from "../lib/comprehensive-release-evidence.mjs";
import { assertSafeStagedArtifacts } from "../lib/comprehensive-release-staging.mjs";

const syntheticHomePath = ["", "Users", "private", "Desktop", "corpus", "file.md"].join("/");
const syntheticHomePrefix = ["", "Users", "private"].join("/");

test("redacts and hashes bounded evidence without retaining provider or private payloads", () => {
  const evidence = createSanitizedEvidence("http-response", {
    localPath: syntheticHomePath,
    Authorization: "Bearer private-token",
    objectKey: "knowledge-bases/private/source.md",
    vector: [0.1, 0.2, 0.3],
    providerPayload: { input: "private corpus body" },
    status: 200
  });

  assert.match(evidence.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(evidence.observation.status, 200);
  assert.equal(JSON.stringify(evidence).includes("private corpus body"), false);
  assert.equal(JSON.stringify(evidence).includes(syntheticHomePrefix), false);
  assert.doesNotThrow(() => assertNoSensitiveEvidence(evidence));
});

test("rejects unredacted secrets, paths, object keys, vectors, and provider payloads", () => {
  for (const unsafe of [
    { text: syntheticHomePath },
    { Authorization: "Bearer secret-value" },
    { objectKey: "knowledge-bases/private/source.md" },
    { vector: Array.from({ length: 16 }, (_, index) => index / 10) },
    { providerPayload: { input: "raw corpus body" } }
  ]) {
    assert.throws(() => assertNoSensitiveEvidence(unsafe), /sensitive/u);
  }
});

test("staging guard rejects raw evidence, corpus, screenshots, secrets, and ignored artifacts", () => {
  const safe = [{ path: "scripts/validation/test/example.test.mjs", ignored: false, content: "safe" }];
  assert.doesNotThrow(() => assertSafeStagedArtifacts(safe));
  for (const artifact of [
    { path: "ReferenceDocs/validation/report.json", ignored: true, content: "{}" },
    { path: "validation/screenshots/private.png", ignored: false, content: "binary" },
    { path: ".env", ignored: true, content: "MODEL_API_KEY=secret" },
    { path: "fixtures/corpus/legal-document.md", ignored: false, content: "raw body" }
  ]) {
    assert.throws(() => assertSafeStagedArtifacts([artifact]), /staged artifact/u);
  }
});
