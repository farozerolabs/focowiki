import assert from "node:assert/strict";
import test from "node:test";

import {
  ADMIN_UI_PERFORMANCE_ACTIONS,
  ADMIN_UI_PERFORMANCE_PROFILES,
  buildAdminUiPerformanceReport
} from "../lib/comprehensive-admin-ui-performance.mjs";

test("builds exact desktop and mobile English and Chinese UI performance evidence", () => {
  const report = buildAdminUiPerformanceReport(fixture());
  assert.equal(report.ok, true);
  assert.equal(report.summary.observedProfileCount, 4);
  assert.equal(report.summary.observedActionCount, 80);
  assert.match(report.evidenceSha256, /^[a-f0-9]{64}$/u);
});

test("rejects a missing individual UI action instead of accepting aggregate evidence", () => {
  const input = fixture();
  input.profiles[0].actions.pop();
  assert.throws(() => buildAdminUiPerformanceReport(input), /action evidence is incomplete/u);
});

test("keeps browser and runtime failures fail closed", () => {
  const input = fixture();
  input.profiles[0].page.consoleErrorCount = 1;
  const report = buildAdminUiPerformanceReport(input);
  assert.equal(report.ok, false);
  assert.deepEqual(report.summary.failures, ["desktop-en:console-errors"]);
});

function fixture() {
  return {
    identitySha256: "a".repeat(64),
    generatedAt: "2026-08-12T00:00:00.000Z",
    profiles: ADMIN_UI_PERFORMANCE_PROFILES.map((id) => ({
      id,
      actions: ADMIN_UI_PERFORMANCE_ACTIONS.map((actionId) => ({
        id: actionId,
        ok: true,
        durationMs: 1,
        transferredBytes: 1,
        resourceCount: 1,
        failedRequestCount: 0,
        horizontalOverflow: false
      })),
      page: {
        navigationDurationMs: 1,
        domContentLoadedMs: 1,
        loadEventMs: 1,
        firstContentfulPaintMs: 1,
        largestContentfulPaintMs: 1,
        interactionLatencyMs: 1,
        cumulativeLayoutShift: 0,
        longTaskCount: 0,
        longTaskDurationMs: 0,
        transferredBytes: 1,
        resourceCount: 1,
        failedRequestCount: 0,
        consoleErrorCount: 0,
        pageErrorCount: 0,
        memoryStartBytes: 1,
        memoryEndBytes: 1,
        memoryPeakBytes: 1,
        horizontalOverflow: false
      }
    }))
  };
}
