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

  assert.equal(coverage.operationCount, 42);
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
  assert.equal(summary.missingAuthentication.length, 41);
  assert.equal(summary.missingBusinessPath.length, 41);
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

test("fails closed when an operation is missing required cold, warm, or concurrent measurements", () => {
  const coverage = createOpenApiOperationCoverage(openApiDocument);
  const pathname = "/openapi/v2/health";

  coverage.record({
    method: "GET",
    pathname,
    status: 200,
    authorization: "authenticated",
    measurementPhase: "cold",
    durationMs: 20
  });
  coverage.record({
    method: "GET",
    pathname,
    status: 200,
    authorization: "authenticated",
    measurementPhase: "warm",
    durationMs: 10
  });

  const summary = coverage.summary({
    requirePerformanceMeasurements: true,
    concurrentApplicableOperationIds: ["getDeveloperOpenApiHealth"]
  });
  const health = summary.operations.find(
    (entry) => entry.operationId === "getDeveloperOpenApiHealth"
  );

  assert.equal(summary.performanceComplete, false);
  assert.equal(
    summary.missingPerformance.includes("getDeveloperOpenApiHealth:concurrent"),
    true
  );
  assert.equal(health.performance.cold.count, 1);
  assert.equal(health.performance.cold.p95Ms, 20);
  assert.equal(health.performance.warm.p95Ms, 10);
  assert.equal(health.performance.concurrent, null);
});

test("summarizes explicit per-operation performance phases and concurrent throughput", () => {
  const coverage = createOpenApiOperationCoverage(openApiDocument);
  const pathname = "/openapi/v2/health";

  for (const measurement of [
    { measurementPhase: "cold", durationMs: 20 },
    { measurementPhase: "warm", durationMs: 10 },
    {
      measurementPhase: "concurrent",
      durationMs: 12,
      measurementWindowMs: 15
    },
    {
      measurementPhase: "concurrent",
      durationMs: 14,
      measurementWindowMs: 15
    }
  ]) {
    coverage.record({
      method: "GET",
      pathname,
      status: 200,
      authorization: "authenticated",
      ...measurement
    });
  }

  const summary = coverage.summary({
    concurrentApplicableOperationIds: ["getDeveloperOpenApiHealth"]
  });
  const health = summary.operations.find(
    (entry) => entry.operationId === "getDeveloperOpenApiHealth"
  );

  assert.equal(health.performance.concurrent.count, 2);
  assert.equal(health.performance.concurrent.p50Ms, 12);
  assert.equal(health.performance.concurrent.p95Ms, 14);
  assert.equal(health.performance.concurrent.errorRate, 0);
  assert.equal(health.performance.concurrent.throughputPerSecond, 133.333);
});
