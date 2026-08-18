import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildOpenApiDocumentationReview
} from "../lib/comprehensive-openapi-doc-review.mjs";

const document = JSON.parse(
  fs.readFileSync("docs/public/openapi/focowiki-openapi.json", "utf8")
);

test("reviews every operation, locale page, response item, and evidence source", () => {
  const review = buildOpenApiDocumentationReview({
    document,
    repositoryRoot: process.cwd(),
    evidence: createCompleteEvidence(document)
  });

  assert.equal(review.ok, true);
  assert.equal(review.operations.length, 42);
  assert.equal(review.pages.length, 84);
  assert.equal(review.explorerEntries.length, 42);
  assert.equal(review.responseItems.filter((item) => item.kind === "response-field").length, 4091);
  assert.ok(review.responseItems.every((item) => item.contractPresent));
  assert.ok(review.responseItems.every((item) => item.explorerPresent));
  assert.ok(review.operations.every((item) => item.lifecycleVerified));
  assert.ok(review.operations.every((item) => item.securityVerified));
  assert.ok(review.operations.every((item) => item.boundaryVerified));
  assert.ok(review.operations.every((item) => item.rateLimitVerified));
  assert.ok(review.operations.every((item) => item.hostVerified));
});

test("reports exact locale-page drift instead of accepting aggregate coverage", () => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-openapi-doc-review-"));
  try {
    copyDirectory(path.join(process.cwd(), "docs"), path.join(temporaryRoot, "docs"));
    const target = path.join(
      temporaryRoot,
      "docs/zh-CN/openapi/operations/get-developer-open-api-health.md"
    );
    fs.writeFileSync(target, fs.readFileSync(target, "utf8").replace(
      'operationId: "getDeveloperOpenApiHealth"',
      'operationId: "wrongOperation"'
    ));

    const review = buildOpenApiDocumentationReview({
      document,
      repositoryRoot: temporaryRoot,
      evidence: createCompleteEvidence(document)
    });

    assert.equal(review.ok, false);
    assert.ok(review.failures.some((failure) =>
      failure.id === "documentation:getDeveloperOpenApiHealth:zh-CN:frontmatter"
    ));
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function copyDirectory(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
}

function createCompleteEvidence(openApiDocument) {
  const operations = Object.entries(openApiDocument.paths).flatMap(([routePath, pathItem]) =>
    Object.entries(pathItem).flatMap(([method, operation]) =>
      operation?.operationId
        ? [{ operationId: operation.operationId, method: method.toUpperCase(), path: routePath }]
        : []
    )
  );
  return {
    lifecycle: {
      ok: true,
      operationCoverage: {
        complete: true,
        operations: operations.map((operation) => ({
          ...operation,
          authenticationVerified: true,
          businessPathVerified: true
        }))
      }
    },
    security: {
      ok: true,
      rows: operations.map((operation) => ({
        operationId: operation.operationId,
        case: "invalid-key",
        pass: true
      }))
    },
    boundaries: {
      ok: true,
      rows: operations.map((operation) => ({
        operationId: operation.operationId,
        case: "boundary",
        pass: true
      })),
      coverage: { missing: [] }
    },
    rateLimit: {
      ok: true,
      rows: operations.map((operation) => ({
        operationId: operation.operationId,
        case: "rate-limited",
        pass: true
      }))
    },
    host: {
      ok: true,
      rows: operations.map((operation) => ({
        surface: "developer-openapi",
        itemId: operation.operationId,
        case: "unexpected-host",
        pass: true
      }))
    }
  };
}
