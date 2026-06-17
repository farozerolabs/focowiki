import fs from "node:fs";
import path from "node:path";
import { redactReportText } from "./redaction.mjs";

export function createDemoAgentReport(config, samples, safeConfig) {
  return {
    kind: "demo-agent-e2e",
    change: config.changeId,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    config: safeConfig,
    source: {
      env: "FOCOWIKI_VALIDATION_MARKDOWN_DIR",
      redactedRoot: "<FOCOWIKI_VALIDATION_MARKDOWN_DIR>"
    },
    samples: samples.map(redactSample),
    checks: [],
    commandsRun: [],
    bugFixes: [],
    failures: [],
    validationRun: null
  };
}

export function okCheck(name, message, details = {}, layer = "black-box") {
  return { layer, name, ok: true, message, details };
}

export function failCheck(name, message, details = {}, layer = "black-box") {
  return { layer, name, ok: false, message, details };
}

export function writeDemoAgentReport(config, report) {
  const safeReport = JSON.parse(redactReportText(JSON.stringify(report, null, 2)));
  fs.mkdirSync(config.reportDir, { recursive: true });
  fs.writeFileSync(
    path.join(config.reportDir, "demo-agent-e2e-report.json"),
    `${JSON.stringify(safeReport, null, 2)}\n`
  );
  fs.writeFileSync(path.join(config.reportDir, "demo-agent-e2e-report.md"), renderMarkdown(safeReport));
}

function redactSample(sample) {
  return {
    basename: sample.basename,
    title: sample.title,
    type: sample.type,
    status: sample.status,
    category: sample.category,
    publicationDate: sample.publicationDate || "unknown-date",
    sizeBytes: sample.sizeBytes
  };
}

function renderMarkdown(report) {
  return [
    "# Demo Agent E2E Validation Report",
    "",
    `- Change: ${report.change}`,
    `- Kind: ${report.kind}`,
    `- Started at: ${report.startedAt}`,
    `- Finished at: ${report.finishedAt || "not-finished"}`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    `- Sample count: ${report.samples.length}`,
    "",
    "## Runtime",
    "",
    ...Object.entries(report.config).map(([key, value]) => `- ${key}: ${String(value)}`),
    "",
    "## Commands Run",
    "",
    ...(report.commandsRun.length ? report.commandsRun.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Selected Files",
    "",
    ...report.samples.map(
      (sample) =>
        `- ${sample.basename}: type=${sample.type || "none"}, status=${sample.status || "none"}, date=${sample.publicationDate}`
    ),
    "",
    "## Checks",
    "",
    ...report.checks.map(
      (check) => `- ${check.ok ? "PASS" : "FAIL"} [${check.layer}] ${check.name}: ${check.message}`
    ),
    "",
    "## Validation Run",
    "",
    report.validationRun ? `\`\`\`json\n${JSON.stringify(report.validationRun, null, 2)}\n\`\`\`` : "- Not recorded.",
    "",
    "## Bug Fixes",
    "",
    ...(report.bugFixes.length ? report.bugFixes.map((item) => `- ${item}`) : ["- None recorded."]),
    "",
    "## Failures",
    "",
    ...(report.failures.length ? report.failures.map((item) => `- ${item}`) : ["- None recorded."]),
    ""
  ].join("\n");
}
