#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  buildComprehensiveAdminManualReview
} from "./lib/comprehensive-admin-manual-review.mjs";
import { buildAdminApiInventory } from "./lib/comprehensive-code-inventory.mjs";

const repositoryRoot = process.cwd();
const evidenceDirectory = process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY;
if (
  !evidenceDirectory
  || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(evidenceDirectory)
) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY must identify one ignored run directory");
}
const reportDirectory = path.join(repositoryRoot, evidenceDirectory);
const readReport = (name) => JSON.parse(
  fs.readFileSync(path.join(reportDirectory, name), "utf8")
);
const runtimeReportNames = [
  "admin-api-positive-response-side-effects.json",
  "admin-api-field-boundaries-expanded.json",
  "admin-api-security-expanded-after-proxy-fix.json",
  "admin-api-security-expanded-oversized-injection.json",
  "admin-api-cancellation-sweep.json",
  "admin-api-rate-limit-sweep.json"
];
const runtimeReports = runtimeReportNames.map((name) => ({
  name,
  report: readReport(name)
}));
if (runtimeReports.some((item) => item.report.ok !== true)) {
  throw new Error("Admin manual review requires every runtime evidence report to be green");
}
const report = buildComprehensiveAdminManualReview({
  repositoryRoot,
  adminApiInventory: buildAdminApiInventory(repositoryRoot),
  responseReconciliation: readReport("admin-api-response-side-effect-reconciliation.json"),
  fieldReconciliation: readReport("admin-api-field-occurrence-reconciliation.json"),
  runtimeReports
});
const reportPath = path.join(reportDirectory, "admin-api-manual-ledger.json");
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  ...report.summary,
  reportPath
}, null, 2)}\n`);
