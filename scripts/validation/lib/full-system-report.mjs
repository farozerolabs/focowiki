import fs from "node:fs";
import path from "node:path";
import { redactReportText } from "./redaction.mjs";

export function createFullSystemReport(config, plan, runId) {
  return {
    kind: "focowiki-full-system-e2e",
    change: config.changeId,
    runId,
    command: config.command,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ok: false,
    config: {
      includeBrowser: config.includeBrowser,
      includeDocker: config.includeDocker,
      includeSecurityAudit: config.includeSecurityAudit,
      allowConfiguredExternals: config.allowConfiguredExternals,
      requireModel: config.requireModel,
      sampleCount: config.sampleCount,
      contentSampleCount: config.contentSampleCount
    },
    steps: plan.map((step) => ({
      id: step.id,
      command: step.safeCommand,
      touchesConfiguredExternals: step.touchesConfiguredExternals,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      durationMs: null
    })),
    coverage: null,
    manualReview: {
      adminUi: "pending",
      generatedContent: "pending",
      durableResidue: "pending"
    },
    defects: [],
    blockers: [],
    cleanup: { status: "pending", unresolved: [] },
    remainingRisks: []
  };
}

export function writeFullSystemReport(reportDir, report) {
  fs.mkdirSync(reportDir, { recursive: true });
  const safe = JSON.parse(redactReportText(JSON.stringify(report)));
  fs.writeFileSync(
    path.join(reportDir, "full-system-e2e-report.json"),
    `${JSON.stringify(safe, null, 2)}\n`
  );
  fs.writeFileSync(
    path.join(reportDir, "full-system-e2e-report.md"),
    renderMarkdown(safe)
  );
}

function renderMarkdown(report) {
  return [
    "# Focowiki 全系统 E2E 验证报告",
    "",
    `- Change: ${report.change}`,
    `- Run ID: ${report.runId}`,
    `- Command: ${report.command}`,
    `- Started: ${report.startedAt}`,
    `- Finished: ${report.finishedAt ?? "pending"}`,
    `- Result: ${report.ok ? "pass" : "pending-or-failed"}`,
    "",
    "## 执行步骤",
    "",
    ...report.steps.map(
      (step) =>
        `- ${step.status.toUpperCase()} ${step.id}: ${step.command}${
          step.durationMs === null ? "" : ` (${step.durationMs}ms)`
        }`
    ),
    "",
    "## 人工检查",
    "",
    `- Admin UI: ${report.manualReview.adminUi}`,
    `- 生成内容: ${report.manualReview.generatedContent}`,
    `- 删除残留: ${report.manualReview.durableResidue}`,
    "",
    "## 缺陷",
    "",
    ...(report.defects.length ? report.defects.map((item) => `- ${item}`) : ["- 暂无记录。"]),
    "",
    "## 阻塞",
    "",
    ...(report.blockers.length ? report.blockers.map((item) => `- ${item}`) : ["- 暂无记录。"]),
    "",
    "## 残余风险",
    "",
    ...(report.remainingRisks.length
      ? report.remainingRisks.map((item) => `- ${item}`)
      : ["- 暂无记录。"]),
    ""
  ].join("\n");
}
