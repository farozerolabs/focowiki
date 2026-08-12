#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  buildAdminApiInventory
} from "./lib/comprehensive-code-inventory.mjs";
import {
  buildAdminResponseSideEffectReconciliation
} from "./lib/comprehensive-admin-response-reconciliation.mjs";

const repositoryRoot = process.cwd();
const evidenceDirectory = process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY;
if (
  !evidenceDirectory
  || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(evidenceDirectory)
) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY must identify one ignored run directory");
}
const positivePath = path.join(
  repositoryRoot,
  evidenceDirectory,
  "admin-api-positive-response-side-effects.json"
);
const boundaryPath = path.join(
  repositoryRoot,
  evidenceDirectory,
  "admin-api-field-boundaries-expanded.json"
);
const reportPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_ADMIN_RESPONSE_REPORT
    || path.join(evidenceDirectory, "admin-api-response-side-effect-reconciliation.json")
);
const report = buildAdminResponseSideEffectReconciliation({
  adminApiInventory: buildAdminApiInventory(repositoryRoot),
  positiveReport: JSON.parse(fs.readFileSync(positivePath, "utf8")),
  boundaryReport: JSON.parse(fs.readFileSync(boundaryPath, "utf8"))
});
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  ...report.summary,
  reportPath
}, null, 2)}\n`);
if (!report.ok) process.exitCode = 1;
