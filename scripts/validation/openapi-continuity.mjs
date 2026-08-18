import fs from "node:fs";
import path from "node:path";
import { validateOpenApiContinuity } from "./lib/openapi-continuity.mjs";
import { validateReviewedOkfV02OpenApi } from "./lib/okf-v02-openapi-diff.mjs";

const contractPath = path.resolve("docs/public/openapi/focowiki-openapi.json");
const reportDir = path.resolve(
  process.env.FOCOWIKI_VALIDATION_REPORT_DIR ||
    "openspec/changes/align-google-okf-v0-2-trust-signals"
);
const document = JSON.parse(fs.readFileSync(contractPath, "utf8"));
const result = validateOpenApiContinuity(document);
const reviewed = validateReviewedOkfV02OpenApi(
  document,
  JSON.parse(fs.readFileSync(
    "scripts/validation/fixtures/okf-v02-openapi-continuity.json",
    "utf8"
  ))
);
if (!reviewed.ok) result.failures.push(...reviewed.failures);
result.reviewedSnapshot = reviewed.ok;
result.ok = result.failures.length === 0;

fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(
  path.join(reportDir, "openapi-continuity-report.json"),
  `${JSON.stringify(result, null, 2)}\n`
);
fs.writeFileSync(
  path.join(reportDir, "openapi-continuity-report.md"),
  renderReport(result)
);

if (!result.ok) {
  throw new Error(result.failures.join("; "));
}

function renderReport(report) {
  return [
    "# Developer OpenAPI Continuity Report",
    "",
    `- Operations: ${report.operationCount}`,
    `- Classified operations: ${report.classifiedOperationCount}`,
    `- Transitions: ${report.transitionCount}`,
    `- Terminal operations: ${report.terminalCount}`,
    `- Result: ${report.ok ? "pass" : "fail"}`,
    `- Reviewed snapshot: ${report.reviewedSnapshot ? "pass" : "fail"}`,
    "",
    "| From | Public field or context | To | Target parameter |",
    "| --- | --- | --- | --- |",
    ...report.transitions.map((item) =>
      item.terminal
        ? `| \`${item.from}\` | terminal | - | ${item.reason} |`
        : `| \`${item.from}\` | \`${item.sourceField ?? "contract navigation"}\` | \`${item.to}\` | \`${item.targetParameter ?? "none"}\` |`
    ),
    ""
  ].join("\n");
}
