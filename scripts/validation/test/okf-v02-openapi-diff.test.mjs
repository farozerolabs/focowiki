import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createOkfV02OpenApiDiff,
  sha256,
  validateReviewedOkfV02OpenApi
} from "../lib/okf-v02-openapi-diff.mjs";

const document = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);
const baseline = JSON.parse(
  fs.readFileSync("scripts/validation/fixtures/okf-v02-prechange-structure.json", "utf8")
);
const continuity = JSON.parse(
  fs.readFileSync("scripts/validation/fixtures/okf-v02-openapi-continuity.json", "utf8")
);

test("requires explicit review for the combined OKF 0.2 and breaking GraphRAG surface", () => {
  const diff = createOkfV02OpenApiDiff(document, baseline);

  assert.equal(diff.compatibility, "review_required");
  assert.deepEqual(diff.pathsMethodsAndOperationIds, {
    beforeCount: 43,
    afterCount: 43,
    unchanged: true
  });
  assert.deepEqual(diff.parameters, {
    added: [
      "okfStatus",
      "okfTrustTier",
      "okfFreshness",
      "rerank",
      "rerankTopK",
      "rerankScoreThreshold"
    ],
    removed: []
  });
  assert.deepEqual(diff.responseFields.GeneratedFile.added, ["okfSignals"]);
  assert.deepEqual(diff.responseFields.FileSearchResult.added, [
    "okfSignals",
    "evidenceTypes",
    "sourceExcerpt"
  ]);
  assert.equal(diff.examples.updated, true);
  assert.equal(diff.errors.unchanged, true);
});

test("rejects a hash-only continuity update without a reviewed structured surface", () => {
  assert.deepEqual(validateReviewedOkfV02OpenApi(document, continuity), {
    ok: true,
    failures: []
  });

  const changed = structuredClone(document);
  changed.paths[
    "/openapi/v2/knowledge-bases/{knowledgeBaseId}/files/search"
  ].get.parameters.pop();
  const hashOnlyEdit = {
    ...continuity,
    contractSha256: sha256(changed)
  };
  const result = validateReviewedOkfV02OpenApi(changed, hashOnlyEdit);

  assert.equal(result.ok, false);
  assert.match(result.failures.join("; "), /reviewed surface/u);
});

test("covers the new evidence and reranker schemas in the reviewed surface", () => {
  const changed = structuredClone(document);
  delete changed.components.schemas.FileSearchResponse.properties.evidenceStatus;
  delete changed.components.schemas.FileSearchResponse.properties.rerankerStatus;
  const hashOnlyEdit = {
    ...continuity,
    contractSha256: sha256(changed)
  };
  const result = validateReviewedOkfV02OpenApi(changed, hashOnlyEdit);

  assert.equal(result.ok, false);
  assert.match(result.failures.join("; "), /reviewed surface/u);
});

test("requires paths, methods, examples, fields, and errors to match the review", () => {
  const changed = structuredClone(document);
  delete changed.components.schemas.FileSearchResult.properties.okfSignals;

  assert.equal(
    createOkfV02OpenApiDiff(changed, baseline).compatibility,
    "review_required"
  );
});
