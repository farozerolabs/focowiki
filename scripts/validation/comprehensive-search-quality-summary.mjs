#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  buildComprehensiveSearchQualitySummary
} from "./lib/comprehensive-search-quality.mjs";

const evidenceDirectory = process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY;
if (
  !evidenceDirectory
  || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(
    evidenceDirectory
  )
) {
  throw new Error(
    "FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY must identify one ignored run directory"
  );
}
const root = path.resolve(evidenceDirectory);
const providerReportName = safeName(requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_PROVIDER_REPORT"));
const specialCaseReportName = safeName(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_SPECIAL_CASE_REPORT")
);
const vectorOracleReportName = safeName(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_VECTOR_ORACLE_REPORT")
);
const outputName = safeName(
  process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_QUALITY_REPORT
    || "search-quality-summary-current.json"
);
const providerReportBytes = fs.readFileSync(path.join(root, providerReportName));
const report = buildComprehensiveSearchQualitySummary({
  providerReport: JSON.parse(providerReportBytes),
  providerReportSha256: sha256(providerReportBytes),
  specialCaseReport: readJson(specialCaseReportName),
  vectorOracleReport: readJson(vectorOracleReportName)
});
const reportPath = path.join(root, outputName);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportPath, 0o600);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  counts: report.counts,
  metrics: report.metrics,
  noResultFalsePositiveRate: report.noResultFalsePositiveRate,
  annRecall: report.annRecall,
  latencyMs: report.latencyMs,
  successfulQueriesPerSecond: report.successfulQueriesPerSecond,
  reportPath
}, null, 2)}\n`);
if (!report.ok) {
  throw new Error(`Comprehensive search quality failed: ${report.failures.length}`);
}

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

function safeName(value) {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(value)) {
    throw new Error("Comprehensive search quality evidence filename is invalid");
  }
  return value;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
