#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { loadEnvFile } from "node:process";

import { classifyComprehensiveMeilisearchTasks } from
  "./lib/comprehensive-provider-state.mjs";

const envPath = path.resolve(process.env.ENV_FILE || ".env");
if (fs.existsSync(envPath)) loadEnvFile(envPath);

const baseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_PROVIDER_BASE_URL")
  .replace(/\/$/u, "");
const authorization = process.env.FOCOWIKI_COMPREHENSIVE_PROVIDER_API_KEY?.trim()
  || process.env.MEILI_API_KEY?.trim()
  || requiredEnv("MEILI_MASTER_KEY");
const indexPrefix = process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_INDEX_PREFIX?.trim()
  || "focowiki_dev";
const ownedIndexPrefixes = process.env.FOCOWIKI_COMPREHENSIVE_OWNED_INDEX_PREFIXES
  ?.split(",").map((value) => value.trim()).filter(Boolean) ?? [indexPrefix];
const reportPath = path.resolve(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_MEILI_TASK_REPORT"
));

const tasks = [];
const seen = new Set();
let from = null;
let expectedTotal = null;
let pageCount = 0;
while (true) {
  const url = new URL("/tasks", `${baseUrl}/`);
  url.searchParams.set("limit", "1000");
  if (from !== null) url.searchParams.set("from", String(from));
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${authorization}` }
  });
  if (!response.ok) {
    throw new Error(`Comprehensive Meilisearch task ledger returned HTTP ${response.status}`);
  }
  const page = await response.json();
  if (expectedTotal === null) expectedTotal = Number(page.total);
  const results = page.results ?? [];
  pageCount += 1;
  for (const task of results) {
    if (seen.has(task.uid)) {
      throw new Error("Comprehensive Meilisearch task ledger contains a duplicate task");
    }
    seen.add(task.uid);
    tasks.push(task);
  }
  if (tasks.length >= expectedTotal || results.length === 0) break;
  const lastUid = results.at(-1)?.uid;
  if (!Number.isSafeInteger(lastUid) || lastUid < 1) {
    throw new Error("Comprehensive Meilisearch task ledger continuation is invalid");
  }
  from = lastUid - 1;
}
if (tasks.length !== expectedTotal) {
  throw new Error("Comprehensive Meilisearch task ledger cardinality is incomplete");
}

const classification = classifyComprehensiveMeilisearchTasks({
  indexPrefix,
  ownedIndexPrefixes,
  tasks
});
const sourceByUid = new Map(tasks.map((task) => [task.uid, task]));
const report = {
  format: "focowiki-comprehensive-meilisearch-task-ledger-v1",
  generatedAt: new Date().toISOString(),
  ok: classification.ok,
  indexPrefix,
  ownedIndexPrefixes,
  pageCount,
  expectedTotal,
  counts: classification.counts,
  items: classification.items.map((item) => {
    const source = sourceByUid.get(item.uid);
    return {
      ...item,
      duration: typeof source?.duration === "string" ? source.duration : null,
      enqueuedAt: source?.enqueuedAt ?? null,
      startedAt: source?.startedAt ?? null,
      finishedAt: source?.finishedAt ?? null,
      details: safeDetails(source?.details)
    };
  })
};
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
fs.chmodSync(reportPath, 0o600);
process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  reportPath,
  pageCount,
  counts: report.counts
})}\n`);

function safeDetails(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value)
    .filter(([, item]) => item === null || typeof item === "number"
      || typeof item === "boolean" || typeof item === "string")
    .sort(([left], [right]) => left.localeCompare(right, "en")));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
