#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  assertComprehensiveCrudPlan,
  buildComprehensiveCrudPlan
} from "./lib/comprehensive-crud-matrix.mjs";

const reportDirectory = requireReportDirectory();
const manifest = readJson(path.join(reportDirectory, "corpus-manifest.json"));
const plan = buildComprehensiveCrudPlan(manifest.rows);
assertComprehensiveCrudPlan(plan, { expectedFileCount: 200 });
const output = path.join(reportDirectory, "comprehensive-crud-plan.json");
fs.writeFileSync(output, `${JSON.stringify(plan, null, 2)}\n`, { mode: 0o600 });

process.stdout.write(`${JSON.stringify({
  ok: true,
  output,
  counts: plan.counts
})}\n`);

function requireReportDirectory() {
  const value = process.env.FOCOWIKI_COMPREHENSIVE_REPORT_DIR?.trim();
  if (
    !value
    || !/^ReferenceDocs\/validation\/comprehensive-large-scale-release\/validation-\d{14}-[a-f0-9]{8}$/u.test(value)
  ) {
    throw new Error("FOCOWIKI_COMPREHENSIVE_REPORT_DIR must be an exact ignored run-owned directory");
  }
  return path.resolve(value);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}
