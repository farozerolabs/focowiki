import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildComprehensiveAdminManualReview
} from "../lib/comprehensive-admin-manual-review.mjs";

test("builds one independently evidenced manual row for every Admin API inventory item", (t) => {
  const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "focowiki-admin-review-"));
  t.after(() => fs.rmSync(repositoryRoot, { recursive: true, force: true }));
  fs.mkdirSync(path.join(repositoryRoot, "apps/api/src/admin"), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, "apps/admin/src/lib"), { recursive: true });
  fs.mkdirSync(path.join(repositoryRoot, "apps/api/test"), { recursive: true });
  fs.writeFileSync(path.join(repositoryRoot, "apps/api/src/admin/routes.ts"), [
    "app.post(\"/admin/api/things\", async (context) => {",
    "  requireAuth(context);",
    "  const name = body.name;",
    "  return context.json({ error: { code: \"VALIDATION_ERROR\" } });",
    "});"
  ].join("\n"));
  fs.writeFileSync(path.join(repositoryRoot, "apps/admin/src/lib/admin-api.ts"), [
    "export const createThing = () => fetch(\"/admin/api/things\");"
  ].join("\n"));
  fs.writeFileSync(path.join(repositoryRoot, "apps/api/test/admin.test.ts"), [
    "expect(response.error.code).toBe(\"VALIDATION_ERROR\");"
  ].join("\n"));

  const inventory = [{
    id: "admin-api:route:POST:/admin/api/things",
    kind: "route",
    source: "apps/api/src/admin/routes.ts",
    method: "POST",
    path: "/admin/api/things",
    manualRequired: true
  }, {
    id: "body-field:apps/api/src/admin/routes.ts:3:name",
    kind: "body-field",
    source: "apps/api/src/admin/routes.ts",
    line: 3,
    name: "name",
    manualRequired: true
  }, {
    id: "error:apps/api/src/admin/routes.ts:4:VALIDATION_ERROR",
    kind: "error",
    source: "apps/api/src/admin/routes.ts",
    line: 4,
    name: "VALIDATION_ERROR",
    manualRequired: true
  }, {
    id: "security-rule:apps/api/src/admin/routes.ts:2:requireAuth",
    kind: "security-rule",
    source: "apps/api/src/admin/routes.ts",
    line: 2,
    name: "requireAuth",
    manualRequired: true
  }, {
    id: "ui-consumer:apps/admin/src/lib/admin-api.ts:1:/admin/api/things",
    kind: "ui-consumer",
    source: "apps/admin/src/lib/admin-api.ts",
    line: 1,
    name: "/admin/api/things",
    method: "POST",
    manualRequired: true
  }];
  const report = buildComprehensiveAdminManualReview({
    repositoryRoot,
    adminApiInventory: inventory,
    responseReconciliation: {
      ok: true,
      routes: [{
        routeId: "POST:/admin/api/things",
        method: "POST",
        path: "/admin/api/things",
        productionSource: "apps/api/src/admin/routes.ts",
        positiveCaseCount: 1,
        boundaryCaseCount: 1,
        dimensions: {
          uiConsumer: { status: "pass" },
          productionService: { status: "pass" },
          auditEvent: { status: "pass" },
          postgresRows: { status: "pass" },
          redisCoordination: { status: "pass" },
          s3Objects: { status: "not_applicable" },
          providerWork: { status: "not_applicable" },
          generatedOutput: { status: "not_applicable" },
          cleanupDisposition: { status: "not_applicable" }
        }
      }],
      sideEffectCases: [{
        contractRouteId: "POST:/admin/api/things",
        disposition: "accepted",
        pass: true
      }, {
        contractRouteId: "POST:/admin/api/things",
        disposition: "rejected",
        pass: true
      }]
    },
    fieldReconciliation: {
      ok: true,
      rows: [{
        sourceId: "body-field:apps/api/src/admin/routes.ts:3:name",
        requiredCases: ["omitted", "invalid_type"],
        executedCases: { omitted: ["boundary:omitted"], invalid_type: ["boundary:type"] },
        missingCases: [],
        pass: true
      }]
    },
    runtimeReports: [{
      name: "admin-security-boundary.json",
      report: { ok: true, rows: [{ errorCode: "VALIDATION_ERROR", pass: true }] }
    }]
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.expectedItemCount, 5);
  assert.equal(report.summary.reviewedItemCount, 5);
  assert.equal(report.summary.missingItemCount, 0);
  assert.equal(report.summary.undocumentedSkipCount, 0);
  assert.equal(report.rows.filter((row) => row.manualStatus === "pass").length, 5);
  assert.ok(report.rows.every((row) => row.sourceEvidence.sourceSha256.length === 64));
  assert.ok(report.rows.every((row) => row.itemEvidence.length > 0));
  assert.equal(report.rows.find((row) => row.kind === "error").observed.runtimeCount, 1);
});

test("fails closed when field or route evidence is missing", () => {
  assert.throws(() => buildComprehensiveAdminManualReview({
    repositoryRoot: process.cwd(),
    adminApiInventory: [{
      id: "admin-api:route:GET:/admin/api/missing",
      kind: "route",
      source: "apps/api/src/admin/routes.ts",
      method: "GET",
      path: "/admin/api/missing",
      manualRequired: true
    }],
    responseReconciliation: { ok: true, routes: [], sideEffectCases: [] },
    fieldReconciliation: { ok: true, rows: [] },
    runtimeReports: []
  }), /manual review evidence mismatch/u);
});
