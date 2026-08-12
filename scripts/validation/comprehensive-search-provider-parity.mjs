#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  buildComprehensiveSearchProviderParity
} from "./lib/comprehensive-search-provider-parity.mjs";

const evidenceDirectory = process.env.FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY;
if (
  !evidenceDirectory
  || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(
    evidenceDirectory
  )
) {
  throw new Error("FOCOWIKI_COMPREHENSIVE_EVIDENCE_DIRECTORY must identify one ignored run directory");
}
const root = path.resolve(evidenceDirectory);
const openSearchReportName = safeName(
  process.env.FOCOWIKI_COMPREHENSIVE_OPENSEARCH_REPORT
    || "search-provider-opensearch-expanded-sequential-current.json"
);
const meilisearchReportName = safeName(
  process.env.FOCOWIKI_COMPREHENSIVE_MEILISEARCH_REPORT
    || "search-provider-meilisearch-expanded-final.json"
);
const openSearchStateName = optionalSafeName(
  process.env.FOCOWIKI_COMPREHENSIVE_OPENSEARCH_STATE_REPORT
);
const meilisearchStateName = optionalSafeName(
  process.env.FOCOWIKI_COMPREHENSIVE_MEILISEARCH_STATE_REPORT
);
const outputName = safeName(
  process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_PARITY_REPORT
    || "search-provider-parity-current.json"
);
const report = buildComprehensiveSearchProviderParity({
  opensearch: readJson(openSearchReportName),
  meilisearch: readJson(meilisearchReportName),
  providerStates: {
    ...(openSearchStateName ? { opensearch: readJson(openSearchStateName) } : {}),
    ...(meilisearchStateName ? { meilisearch: readJson(meilisearchStateName) } : {})
  }
});
const reportPath = path.join(root, outputName);
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportPath, 0o600);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  ...report.summary,
  providerSpecificOperations: report.providerSpecificOperations,
  reportPath
}, null, 2)}\n`);

function readJson(name) {
  return JSON.parse(fs.readFileSync(path.join(root, name), "utf8"));
}

function safeName(value) {
  if (!/^[a-z0-9][a-z0-9._-]*\.json$/u.test(value)) {
    throw new Error("Search parity evidence filename is invalid");
  }
  return value;
}

function optionalSafeName(value) {
  return value?.trim() ? safeName(value.trim()) : null;
}
