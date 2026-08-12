import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_FIELD_CASE_KINDS,
  adminRateLimitDrainWaitMs,
  adminFieldCaseKindFromEvidenceId,
  buildAdminFieldOccurrenceMatrix,
  createAdminBoundaryRateLimitLease,
  createPublicationIntervalLease,
  enumerateRequiredAdminFieldCases,
  locateAdminFieldRoute,
  remainingAdminRateLimitWindowMs,
  reconcileAdminFieldOccurrenceMatrix
} from "../lib/comprehensive-admin-field-matrix.mjs";

const inventory = [{
  id: "request-field:apps/api/src/admin/example.ts:10:query:limit",
  kind: "request-field",
  source: "apps/api/src/admin/example.ts",
  line: 10,
  name: "query:limit"
}, {
  id: "body-field:apps/api/src/admin/example.ts:20:name",
  kind: "body-field",
  source: "apps/api/src/admin/example.ts",
  line: 20,
  name: "name"
}];

test("creates one explicit case disposition for every field occurrence and case kind", () => {
  const rows = buildAdminFieldOccurrenceMatrix({
    inventory,
    occurrencePolicies: {
      [inventory[0].id]: {
        routeId: "GET:/admin/api/examples",
        required: ["omitted", "minimum", "maximum", "belowMinimum", "aboveMaximum", "invalidType", "pagination"],
        applicable: {
          omitted: ["positive:list-default"],
          minimum: ["boundary:limit-minimum"],
          maximum: ["boundary:limit-maximum"],
          belowMinimum: ["boundary:limit-below"],
          aboveMaximum: ["boundary:limit-above"],
          invalidType: ["boundary:limit-wrong-type"],
          pagination: ["positive:list-next-page"]
        }
      },
      [inventory[1].id]: {
        routeId: "POST:/admin/api/examples",
        applicable: {
          omitted: ["boundary:name-omitted"],
          null: ["boundary:name-null"],
          invalidType: ["boundary:name-wrong-type"],
          minimum: ["positive:name-minimum"]
        }
      }
    },
    evidenceIds: new Set([
      "positive:list-default",
      "boundary:limit-minimum",
      "boundary:limit-maximum",
      "boundary:limit-below",
      "boundary:limit-above",
      "boundary:limit-wrong-type",
      "positive:list-next-page",
      "boundary:name-omitted",
      "boundary:name-null",
      "boundary:name-wrong-type",
      "positive:name-minimum"
    ])
  });

  assert.equal(rows.length, inventory.length);
  assert.equal(rows[0].cases.length, ADMIN_FIELD_CASE_KINDS.length);
  assert.equal(rows[0].cases.find((item) => item.kind === "minimum")?.disposition, "executed");
  assert.equal(rows[0].cases.find((item) => item.kind === "invalidEnum")?.disposition, "not_applicable");
  assert.match(
    rows[0].cases.find((item) => item.kind === "invalidEnum")?.reason ?? "",
    /not an enum/iu
  );
});

test("rejects missing per-occurrence policy and missing live evidence", () => {
  assert.throws(
    () => buildAdminFieldOccurrenceMatrix({
      inventory,
      occurrencePolicies: { [inventory[0].id]: { routeId: "GET:/admin/api/examples", applicable: {} } },
      evidenceIds: new Set()
    }),
    /Missing Admin field policy/u
  );

  assert.throws(
    () => buildAdminFieldOccurrenceMatrix({
      inventory: [inventory[0]],
      occurrencePolicies: {
        [inventory[0].id]: {
          routeId: "GET:/admin/api/examples",
          applicable: { omitted: ["missing:evidence"] }
        }
      },
      evidenceIds: new Set()
    }),
    /Missing live evidence/u
  );

  assert.throws(
    () => buildAdminFieldOccurrenceMatrix({
      inventory: [inventory[0]],
      occurrencePolicies: {
        [inventory[0].id]: {
          routeId: "GET:/admin/api/examples",
          required: ["minimum"],
          applicable: {}
        }
      },
      evidenceIds: new Set()
    }),
    /Missing required Admin field case/u
  );
});

test("reconciliation fails aggregate or duplicated occurrence rows", () => {
  const row = {
    sourceId: inventory[0].id,
    cases: ADMIN_FIELD_CASE_KINDS.map((kind) => ({
      kind,
      disposition: "not_applicable",
      reason: "The field is not an enum."
    }))
  };

  assert.deepEqual(reconcileAdminFieldOccurrenceMatrix({ inventory: [inventory[0]], rows: [row] }), {
    ok: true,
    expectedOccurrenceCount: 1,
    observedOccurrenceCount: 1,
    expectedCaseCount: ADMIN_FIELD_CASE_KINDS.length,
    observedCaseCount: ADMIN_FIELD_CASE_KINDS.length,
    missingSourceIds: [],
    duplicateSourceIds: [],
    invalidRows: []
  });

  const failed = reconcileAdminFieldOccurrenceMatrix({ inventory: [inventory[0]], rows: [row, row] });
  assert.equal(failed.ok, false);
  assert.deepEqual(failed.duplicateSourceIds, [inventory[0].id]);
});

test("associates a field occurrence with its exact enclosing Admin route", () => {
  const source = [
    "const base = \"/admin/api/examples\";",
    "app.get(base, requireAuth, async (context) => {",
    "  const limit = context.req.query(\"limit\");",
    "});",
    "app.patch(`/admin/api/examples/:exampleId`, requireAuth, async (context) => {",
    "  const body = await context.req.json();",
    "  return body.name;",
    "});"
  ].join("\n");

  assert.equal(locateAdminFieldRoute({ source, line: 3 }), "GET:/admin/api/examples");
  assert.equal(locateAdminFieldRoute({ source, line: 7 }), "PATCH:/admin/api/examples/:exampleId");
  assert.equal(locateAdminFieldRoute({ source, line: 1 }), null);
});

test("enumerates semantic boundary obligations for each Admin field kind", () => {
  assert.deepEqual(enumerateRequiredAdminFieldCases({
    kind: "request-field",
    name: "query:limit"
  }), [
    "omitted", "minimum", "maximum", "belowMinimum", "aboveMaximum",
    "invalidType", "duplicate", "pagination"
  ]);
  assert.deepEqual(enumerateRequiredAdminFieldCases({
    kind: "request-field",
    name: "header:if-match"
  }), [
    "omitted", "minimum", "belowMinimum", "invalidType", "staleRevision", "conflict"
  ]);
  assert.deepEqual(enumerateRequiredAdminFieldCases({
    kind: "body-field",
    name: "configuration"
  }), ["omitted", "null", "invalidType", "unknownField"]);
  assert.deepEqual(enumerateRequiredAdminFieldCases({
    kind: "request-field",
    name: "header:idempotency-key"
  }, {
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance"
  }), ["omitted", "duplicate", "idempotency"]);
  assert.deepEqual(enumerateRequiredAdminFieldCases({
    kind: "body-field",
    name: "idempotencyKey"
  }, {
    routeId: "POST:/admin/api/knowledge-bases/:knowledgeBaseId/index-maintenance"
  }), ["omitted", "null", "invalidType", "duplicate", "idempotency"]);
});

test("classifies live Admin boundary evidence without category-only inference", () => {
  assert.equal(adminFieldCaseKindFromEvidenceId("occurrence:list:query:limit:below-minimum", "query:limit"), "belowMinimum");
  assert.equal(adminFieldCaseKindFromEvidenceId("occurrence:list:query:limit:maximum", "query:limit"), "maximum");
  assert.equal(adminFieldCaseKindFromEvidenceId("param:sourceFileId:missing", "param:sourceFileId"), "invalidIdentifier");
  assert.equal(adminFieldCaseKindFromEvidenceId("identifier:source-file-retry:source-file", "param:sourceFileId"), "invalidIdentifier");
  assert.equal(adminFieldCaseKindFromEvidenceId("query:state:invalid", "query:state"), "invalidEnum");
  assert.equal(adminFieldCaseKindFromEvidenceId("header:if-match:invalid", "header:if-match"), "belowMinimum");
  assert.equal(adminFieldCaseKindFromEvidenceId("body:entries:wrong-type", "entries"), "invalidType");
  assert.equal(adminFieldCaseKindFromEvidenceId("body:entries:invalid-identifier", "entries"), "invalidIdentifier");
  assert.equal(adminFieldCaseKindFromEvidenceId("occurrence:logout:header:cookie:invalid", "header:cookie"), "invalidIdentifier");
  assert.equal(adminFieldCaseKindFromEvidenceId("settings:embedding:update:configuration:unknown-field", "configuration"), "unknownField");
});

test("raises temporary Admin boundary capacities and preserves an exact restore snapshot", () => {
  const original = {
    adminLogin: { max: 8, windowSeconds: 900 },
    adminApi: { max: 600, windowSeconds: 60 },
    publicOpenApi: { max: 1_200, windowSeconds: 60 }
  };
  const lease = createAdminBoundaryRateLimitLease(original, {
    adminLoginMax: 100,
    adminApiMax: 10_000
  });

  assert.deepEqual(lease.elevated, {
    ...original,
    adminLogin: { max: 100, windowSeconds: 900 },
    adminApi: { max: 10_000, windowSeconds: 60 }
  });
  assert.deepEqual(lease.restore, original);
  lease.elevated.adminLogin.max = 200;
  assert.equal(lease.restore.adminLogin.max, 8);
  assert.deepEqual(original.adminLogin, { max: 8, windowSeconds: 900 });
});

test("creates a temporary fast publication lease without mutating the restore snapshot", () => {
  const original = { mode: "batch", intervalSeconds: 300, claimBatchSize: 10 };
  const lease = createPublicationIntervalLease(original, 1);

  assert.deepEqual(lease.elevated, {
    mode: "batch",
    intervalSeconds: 1,
    claimBatchSize: 10
  });
  assert.deepEqual(lease.restore, original);
  assert.deepEqual(original, { mode: "batch", intervalSeconds: 300, claimBatchSize: 10 });
});

test("waits only for the unelapsed Admin rate-limit window plus a bounded cushion", () => {
  assert.equal(remainingAdminRateLimitWindowMs({
    startedAtMs: 1_000,
    nowMs: 21_000,
    windowSeconds: 60,
    cushionMs: 250
  }), 40_250);
  assert.equal(remainingAdminRateLimitWindowMs({
    startedAtMs: 1_000,
    nowMs: 62_000,
    windowSeconds: 60,
    cushionMs: 250
  }), 0);
});

test("drains the latest Admin rate-limit window after a long elevated-capacity run", () => {
  assert.equal(adminRateLimitDrainWaitMs({
    startedAtMs: 1_000,
    nowMs: 21_000,
    windowSeconds: 60,
    cushionMs: 250,
    requestCount: 600,
    restoredMaximum: 600
  }), 0);
  assert.equal(adminRateLimitDrainWaitMs({
    startedAtMs: 1_000,
    nowMs: 21_000,
    windowSeconds: 60,
    cushionMs: 250,
    requestCount: 601,
    restoredMaximum: 600
  }), 40_250);
  assert.equal(adminRateLimitDrainWaitMs({
    startedAtMs: 1_000,
    nowMs: 121_000,
    windowSeconds: 60,
    cushionMs: 250,
    requestCount: 1_200,
    restoredMaximum: 600
  }), 60_250);
});
