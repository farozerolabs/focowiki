import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { validateOpenApiContinuity } from "../lib/openapi-continuity.mjs";

test("classifies every Developer OpenAPI operation and verifies its next public edge", () => {
  const document = JSON.parse(
    fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
  );
  const result = validateOpenApiContinuity(document);

  assert.equal(result.operationCount, 43);
  assert.equal(result.classifiedOperationCount, 43);
  assert.equal(result.ok, true, result.failures.join("; "));
});
