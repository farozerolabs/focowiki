#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  reconcileComprehensiveSearchProviderReport
} from "./lib/comprehensive-search-ledger.mjs";

const evidenceDirectory = process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY;
if (
  !evidenceDirectory
  || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(
    evidenceDirectory
  )
) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY must identify one ignored run directory");
}
const inputName = safeName(requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_INPUT_REPORT"));
const outputName = safeName(requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_OUTPUT_REPORT"));
if (inputName === outputName) {
  throw new Error("Comprehensive search reconciliation cannot overwrite its source report");
}
const root = path.resolve(evidenceDirectory);
const inputPath = path.join(root, inputName);
const outputPath = path.join(root, outputName);
const source = JSON.parse(fs.readFileSync(inputPath, "utf8"));
const report = reconcileComprehensiveSearchProviderReport(source);
if (
  report.rows.length !== 200
  || report.counts.expectedFiles !== 200
  || report.counts.completedFiles !== 200
  || report.counts.expectedQueries !== 2_061
  || report.counts.completedQueries !== 2_061
  || report.counts.expectedFilterDispositions !== 600
  || report.counts.completedFilterDispositions !== 600
  || report.counts.sourceReads !== 400
  || report.ok !== true
) {
  throw new Error("Comprehensive search reconciliation did not satisfy exact release cardinality");
}
fs.writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);
process.stdout.write(`${JSON.stringify({
  provider: report.provider,
  ok: report.ok,
  counts: report.counts,
  reconciliation: report.reconciliation,
  outputPath
}, null, 2)}\n`);

function safeName(value) {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(value)) {
    throw new Error("Comprehensive search report filename is invalid");
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
