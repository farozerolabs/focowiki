#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { reconcileComprehensiveMeilisearchPhase } from
  "./lib/comprehensive-provider-state.mjs";

const reportDirectory = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT_DIR"));
const evidenceFiles = {
  search: process.env.FOCOWIKI_COMPREHENSIVE_MEILI_SEARCH_REPORT?.trim()
    || "search-provider-meilisearch-expanded-final.json",
  providerState: process.env.FOCOWIKI_COMPREHENSIVE_MEILI_STATE_REPORT?.trim()
    || "search-provider-meilisearch-state.json",
  vectorOracle: process.env.FOCOWIKI_COMPREHENSIVE_MEILI_VECTOR_REPORT?.trim()
    || "vector-oracle-meilisearch.json",
  taskLedger: process.env.FOCOWIKI_COMPREHENSIVE_MEILI_TASK_REPORT?.trim()
    || "meilisearch-task-ledger.json",
  switchReport: process.env.FOCOWIKI_COMPREHENSIVE_MEILI_SWITCH_REPORT?.trim()
    || "provider-switch-to-meilisearch-retry1.json"
};
const evidence = {
  search: readEvidence("search"),
  providerState: readEvidence("providerState"),
  vectorOracle: readEvidence("vectorOracle"),
  taskLedger: readEvidence("taskLedger"),
  switchReport: readEvidence("switchReport")
};
const reconciliation = reconcileComprehensiveMeilisearchPhase(evidence);
const report = {
  format: "focowiki-comprehensive-meilisearch-phase-reconciliation-v1",
  generatedAt: new Date().toISOString(),
  ...reconciliation,
  evidenceFiles: Object.values(evidenceFiles)
};
const reportPath = path.join(
  reportDirectory,
  process.env.FOCOWIKI_COMPREHENSIVE_MEILI_PHASE_REPORT?.trim()
    || "meilisearch-phase-reconciliation.json"
);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportPath, 0o600);
process.stdout.write(`${JSON.stringify({ reportPath, ...reconciliation })}\n`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readEvidence(name) {
  const fileName = evidenceFiles[name];
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/iu.test(fileName)) {
    throw new Error("Comprehensive Meilisearch evidence filename is invalid");
  }
  return readJson(path.join(reportDirectory, fileName));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
