import assert from "node:assert/strict";
import test from "node:test";

import {
  buildAdminResponseSideEffectReconciliation
} from "../lib/comprehensive-admin-response-reconciliation.mjs";

const routes = [{
  id: "admin-api:route:POST:/admin/api/login",
  kind: "route",
  source: "apps/api/src/admin/routes.ts",
  method: "POST",
  path: "/admin/api/login"
}, {
  id: "admin-api:route:POST:/admin/api/knowledge-bases",
  kind: "route",
  source: "apps/api/src/admin/knowledge-base-routes.ts",
  method: "POST",
  path: "/admin/api/knowledge-bases"
}, {
  id: "ui-consumer:login",
  kind: "ui-consumer",
  source: "apps/admin/src/lib/admin-api.ts",
  name: "/admin/api/login",
  method: "POST"
}, {
  id: "admin-api:route:POST:/admin/api/settings/widgets/:widgetId/test",
  kind: "route",
  source: "apps/api/src/admin/widget-routes.ts",
  method: "POST",
  path: "/admin/api/settings/widgets/:widgetId/test"
}, {
  id: "admin-api:route:POST:/admin/api/settings/widgets/:widgetId/:action",
  kind: "route",
  source: "apps/api/src/admin/widget-routes.ts",
  method: "POST",
  path: "/admin/api/settings/widgets/:widgetId/:action"
}, {
  id: "ui-consumer:widget-test",
  kind: "ui-consumer",
  source: "apps/admin/src/lib/admin-api.ts",
  name: "/admin/api/settings/widgets/:dynamic/test",
  method: "POST"
}];

const positiveReport = {
  ok: true,
  routeCount: 4,
  pendingPositive: [],
  cleanup: {
    keyDeleted: true,
    knowledgeBaseDeleted: true,
    generationModelDeleted: true,
    embeddingConfigurationDeleted: true,
    rerankerConfigurationDeleted: true,
    generationModelRestored: true,
    embeddingConfigurationRestored: true,
    rerankerConfigurationRestored: true,
    loggedOut: true
  },
  rows: [{
    sequence: 1,
    routeId: "POST:/admin/api/login",
    method: "POST",
    path: "/admin/api/login",
    case: "positive",
    status: 200,
    positive: true,
    responseFields: ["$.authenticated"],
    responseHeaders: ["content-type"],
    identityEvidence: [],
    pass: true
  }, {
    sequence: 2,
    routeId: "POST:/admin/api/knowledge-bases",
    method: "POST",
    path: "/admin/api/knowledge-bases",
    case: "positive",
    status: 201,
    positive: true,
    responseFields: ["$.knowledgeBase.id", "$.knowledgeBase.name"],
    responseHeaders: ["content-type"],
    identityEvidence: [{ field: "$.knowledgeBase.id", valueHash: "a".repeat(64) }],
    pass: true
  }, {
    sequence: 3,
    routeId: "POST:/admin/api/settings/widgets/:widgetId/test",
    method: "POST",
    path: "/admin/api/settings/widgets/widget-1/test",
    case: "positive",
    status: 200,
    positive: true,
    responseFields: ["$.tested"],
    responseHeaders: ["content-type"],
    identityEvidence: [],
    pass: true
  }, {
    sequence: 4,
    routeId: "POST:/admin/api/settings/widgets/:widgetId/:action",
    method: "POST",
    path: "/admin/api/settings/widgets/widget-1/activate",
    case: "positive",
    status: 200,
    positive: true,
    responseFields: ["$.activated"],
    responseHeaders: ["content-type"],
    identityEvidence: [],
    pass: true
  }]
};

const boundaryReport = {
  ok: true,
  rows: [{
    sequence: 1,
    id: "login-invalid",
    routeId: null,
    method: "POST",
    path: "/admin/api/login",
    status: 401,
    errorCode: "UNAUTHORIZED",
    responseFields: ["$.error.code", "$.error.message"],
    responseHeaders: ["content-type"],
    pass: true
  }]
};

test("reconciles every positive and rejected Admin response field and side effect", () => {
  const report = buildAdminResponseSideEffectReconciliation({
    adminApiInventory: routes,
    positiveReport,
    boundaryReport
  });

  assert.equal(report.ok, true);
  assert.equal(report.summary.routeCount, 4);
  assert.equal(report.summary.responseFieldCount, 7);
  assert.equal(report.summary.sideEffectCaseCount, 5);
  assert.equal(report.summary.unmatchedCaseCount, 0);
  assert.equal(report.summary.cleanupFailureCount, 0);
  assert.equal(report.routes.find((route) => route.routeId.endsWith("/login"))
    .dimensions.uiConsumer.status, "pass");
  assert.equal(report.routes.find((route) => route.routeId.endsWith("/knowledge-bases"))
    .dimensions.uiConsumer.status, "not_applicable");
  assert.equal(report.routes.find((route) => route.routeId.endsWith("/:action"))
    .dimensions.uiConsumer.status, "not_applicable");
  assert.equal(report.routes.find((route) => route.routeId.endsWith("/test"))
    .dimensions.uiConsumer.status, "pass");
  assert.ok(report.responseFields.every((field) => field.productionSource));
  assert.ok(report.sideEffectCases.every((item) => item.disposition !== "unknown"));
});

test("fails closed when a current route has no positive execution", () => {
  assert.throws(() => buildAdminResponseSideEffectReconciliation({
    adminApiInventory: routes,
    positiveReport: {
      ...positiveReport,
      rows: positiveReport.rows.slice(0, 1)
    },
    boundaryReport
  }), /positive route coverage mismatch/u);
});
