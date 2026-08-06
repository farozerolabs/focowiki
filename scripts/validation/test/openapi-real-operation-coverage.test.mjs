import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import {
  createOpenApiOperationCoverage
} from "../lib/openapi-real-operation-coverage.mjs";

const openApiDocument = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);

test("tracks concrete requests against every released OpenAPI operation", () => {
  const coverage = createOpenApiOperationCoverage(openApiDocument);

  assert.equal(coverage.operationCount, 43);
  coverage.record({
    method: "GET",
    pathname: "/openapi/v2/knowledge-bases/kb-example?limit=1",
    status: 401,
    authorization: "unauthenticated"
  });
  coverage.record({
    method: "GET",
    pathname: "/openapi/v2/knowledge-bases/kb-example?limit=1",
    status: 200,
    authorization: "authenticated"
  });

  const operation = coverage.summary().operations.find(
    (entry) => entry.operationId === "getKnowledgeBase"
  );
  assert.deepEqual(operation.unauthenticatedStatuses, [401]);
  assert.deepEqual(operation.authenticatedStatuses, [200]);
});

test("reports authentication and business-path gaps per operation", () => {
  const coverage = createOpenApiOperationCoverage(openApiDocument);
  coverage.record({
    method: "POST",
    pathname: "/openapi/v2/knowledge-bases/kb-example/source-files/source-example/retry",
    status: 401,
    authorization: "unauthenticated"
  });
  coverage.record({
    method: "POST",
    pathname: "/openapi/v2/knowledge-bases/kb-example/source-files/source-example/retry",
    status: 409,
    authorization: "authenticated"
  });

  const summary = coverage.summary({
    acceptedAuthenticatedStatuses: {
      retryKnowledgeBaseSourceFile: [409]
    }
  });
  const retry = summary.operations.find(
    (entry) => entry.operationId === "retryKnowledgeBaseSourceFile"
  );
  assert.equal(retry.authenticationVerified, true);
  assert.equal(retry.businessPathVerified, true);
  assert.equal(summary.complete, false);
  assert.equal(summary.missingAuthentication.length, 42);
  assert.equal(summary.missingBusinessPath.length, 42);
});

test("rejects requests that do not match the released contract", () => {
  const coverage = createOpenApiOperationCoverage(openApiDocument);

  assert.throws(() => coverage.record({
    method: "GET",
    pathname: "/openapi/v2/unknown",
    status: 404,
    authorization: "authenticated"
  }), /does not match a released OpenAPI operation/u);
});
