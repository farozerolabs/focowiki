#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  buildComprehensiveSearchSpecialCasePlan
} from "./lib/comprehensive-search-special-cases.mjs";

const reportDirectory = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_REPORT_DIR"));
const providerReportPath = path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_PROVIDER_REPORT")
);
const outputPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_SPECIAL_CASE_PLAN?.trim()
    || path.join(reportDirectory, "search-special-case-plan.json")
);

const plan = buildComprehensiveSearchSpecialCasePlan({
  providerReport: readJson(providerReportPath),
  manifestRows: readJson(path.join(reportDirectory, "corpus-manifest.json")).rows
});

writePrivateReport(outputPath, plan);
process.stdout.write(`${JSON.stringify({
  ok: true,
  outputPath,
  provider: plan.provider,
  counts: plan.counts
})}\n`);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
