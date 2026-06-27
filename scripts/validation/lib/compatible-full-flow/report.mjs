import fs from "node:fs";
import path from "node:path";
import { redactReportText } from "../redaction.mjs";

export function createCompatibleReport(config) {
  return {
    kind: "compatible-full-flow",
    mode: config.mode,
    change: config.changeId,
    runId: config.runId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    source: {
      env: "FOCOWIKI_VALIDATION_MARKDOWN_DIR",
      redactedRoot: config.markdownDir ? "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>" : "not-configured"
    },
    services: {
      adminApi: redactServiceUrl(config.adminApiBaseUrl),
      adminUi: redactServiceUrl(config.adminUiBaseUrl),
      developerOpenApi: redactServiceUrl(config.publicOpenApiBaseUrl)
    },
    samples: {
      requested: config.sampleCount,
      batchRequested: config.batchSampleCount,
      selected: []
    },
    checks: [],
    cleanup: {
      currentRunOnly: true,
      dryRunLeftovers: []
    },
    failures: [],
    residualRisks: []
  };
}

export function addCheck(report, check) {
  report.checks.push({
    layer: check.layer ?? "preflight",
    name: check.name,
    ok: check.ok !== false,
    message: check.message,
    details: check.details ?? {}
  });
}

export function addFailure(report, error) {
  report.failures.push(redactReportText(error instanceof Error ? error.message : String(error)));
}

export function finishReport(report, ok) {
  report.finishedAt = new Date().toISOString();
  report.ok = ok;
}

export function writeCompatibleReport(config, report) {
  fs.mkdirSync(config.reportDir, { recursive: true });
  const safeReport = JSON.parse(redactReportText(JSON.stringify(report, null, 2)));
  fs.writeFileSync(config.reportPath, `${JSON.stringify(safeReport, null, 2)}\n`);
  fs.writeFileSync(config.reportMarkdownPath, renderMarkdown(safeReport));

  if (safeReport.mode === "compatible" && safeReport.ok) {
    fs.writeFileSync(
      config.evidencePath,
      `${JSON.stringify(
        {
          kind: safeReport.kind,
          mode: safeReport.mode,
          ok: true,
          runId: safeReport.runId,
          finishedAt: safeReport.finishedAt
        },
        null,
        2
      )}\n`
    );
  }
}

function renderMarkdown(report) {
  return [
    "# Compatible Full-Flow Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Run ID: ${report.runId}`,
    `- Mode: ${report.mode}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt ?? "not-finished"}`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    "",
    "## Services",
    "",
    `- Admin API: ${report.services.adminApi}`,
    `- Admin UI: ${report.services.adminUi}`,
    `- Developer OpenAPI: ${report.services.developerOpenApi}`,
    "",
    "## Samples",
    "",
    `- Requested: ${report.samples.requested}`,
    `- Selected: ${report.samples.selected.length}`,
    ...(report.samples.selected.length
      ? report.samples.selected.map((sample) => `- ${sample.basename} (${sample.sizeBytes} bytes)`)
      : ["- No selected samples recorded."]),
    "",
    "## Checks",
    "",
    ...(report.checks.length
      ? report.checks.map((check) => `- ${check.ok ? "PASS" : "FAIL"} [${check.layer}] ${check.name}: ${check.message}`)
      : ["- None recorded."]),
    "",
    "## Cleanup",
    "",
    `- Current-run only: ${report.cleanup.currentRunOnly ? "yes" : "no"}`,
    `- Dry-run leftovers: ${report.cleanup.dryRunLeftovers.length}`,
    "",
    "## Failures",
    "",
    ...(report.failures.length ? report.failures.map((failure) => `- ${failure}`) : ["- None recorded."]),
    "",
    "## Residual Risks",
    "",
    ...(report.residualRisks.length ? report.residualRisks.map((risk) => `- ${risk}`) : ["- None recorded."]),
    ""
  ].join("\n");
}

function redactServiceUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return "not-configured";
  }
}
