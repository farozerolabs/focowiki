#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import {
  summarizeComprehensiveOpenApiPerformance
} from "./lib/comprehensive-openapi-performance.mjs";

const document = readJson(
  process.env.FOCOWIKI_COMPREHENSIVE_OPENAPI_DOCUMENT
    ?? "docs/public/openapi/focowiki-openapi.json"
);
const coldReport = readJson(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_OPENAPI_COLD_REPORT"
));
const warmReport = readJson(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_OPENAPI_WARM_REPORT"
));
const concurrentReports = requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_OPENAPI_CONCURRENT_REPORTS"
).split(",").map((value) => readJson(value.trim()));
const output = path.resolve(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_OPENAPI_PERFORMANCE_REPORT"
));
const summary = summarizeComprehensiveOpenApiPerformance({
  document,
  coldReport,
  warmReport,
  concurrentReports
});
const report = {
  generatedAt: new Date().toISOString(),
  ...summary
};
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(output, 0o600);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  output,
  operationCount: report.operationCount,
  concurrentClientCount: report.concurrentClientCount,
  failures: report.failures
})}\n`);
if (!report.ok) process.exitCode = 1;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(path.resolve(filePath), "utf8"));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
