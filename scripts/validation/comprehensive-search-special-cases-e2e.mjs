#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import {
  evaluateComprehensiveExistingSpecialCase,
  evaluateComprehensiveLiveSpecialCase,
  validateComprehensiveSearchSpecialCaseInputs
} from "./lib/comprehensive-search-special-cases.mjs";
import {
  parseRetryAfterMilliseconds,
  retryComprehensiveSearchOperation
} from "./lib/comprehensive-search-ledger.mjs";

const planPath = path.resolve(requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_SPECIAL_CASE_PLAN"));
const providerReportPath = path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_PROVIDER_REPORT")
);
const outputPath = path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_SEARCH_SPECIAL_CASE_REPORT")
);
const openApiBaseUrl = process.env.FOCOWIKI_COMPREHENSIVE_OPENAPI_BASE_URL?.trim()
  || "http://127.0.0.1:43200";
const authorization = loadAuthorization(path.resolve(
  requiredEnv("FOCOWIKI_COMPREHENSIVE_AUTHORIZATION_FILE")
));
const concurrency = readInteger(
  process.env.FOCOWIKI_COMPREHENSIVE_SEARCH_CONCURRENCY,
  4,
  1,
  20
);
const plan = readJson(planPath);
const providerReport = readJson(providerReportPath);
validateComprehensiveSearchSpecialCaseInputs({ plan, providerReport });
const sourceReads = new Map(Object.values(providerReport.sourceReadEvidence ?? {}).map((item) => [
  item.id,
  item
]));
if (sourceReads.size !== plan.counts.sourceFiles) {
  throw new Error("Comprehensive search special cases require every source read evidence row");
}

const report = {
  format: "focowiki-comprehensive-search-special-case-e2e-v1",
  provider: plan.provider,
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ok: false,
  planSha256: sha256(fs.readFileSync(planPath)),
  providerReportSha256: sha256(fs.readFileSync(providerReportPath)),
  counts: {
    expectedCases: plan.cases.length,
    completedCases: 0,
    passedCases: 0,
    failedCases: 0,
    existingReportCases: plan.cases.filter((item) =>
      item.execution === "existing_report").length,
    liveHttpCases: plan.cases.filter((item) => item.execution === "live_http").length,
    liveHttpRequests: 0
  },
  categories: {},
  cases: [],
  failures: []
};
const firstPagePromiseByKey = new Map();
const MAXIMUM_CURSOR_PAGES = 1_000;
let completedLiveCases = 0;

for (const item of plan.cases.filter((value) => value.execution === "existing_report")) {
  recordResult(item, () => evaluateComprehensiveExistingSpecialCase({
    item,
    providerReport
  }));
}
writePrivateReport(outputPath, report);

const liveCases = plan.cases.filter((item) => item.execution === "live_http");
await mapWithConcurrency(liveCases, concurrency, async (item) => {
  await recordAsyncResult(item, async () => evaluateComprehensiveLiveSpecialCase({
    item,
    pages: await executeLivePages(item),
    sourceReads
  }));
  completedLiveCases += 1;
  if (completedLiveCases % 20 === 0 || completedLiveCases === liveCases.length) {
    process.stdout.write(`search-special ${plan.provider}: ${completedLiveCases}/${liveCases.length}\n`);
    writePrivateReport(outputPath, report);
  }
});

report.cases.sort((left, right) => left.caseId.localeCompare(right.caseId, "en"));
report.finishedAt = new Date().toISOString();
report.categories = Object.fromEntries(plan.cases.map((item) => item.category)
  .filter((category, index, categories) => categories.indexOf(category) === index)
  .sort()
  .map((category) => {
    const rows = report.cases.filter((item) => item.category === category);
    return [category, {
      expected: plan.cases.filter((item) => item.category === category).length,
      completed: rows.length,
      passed: rows.filter((item) => item.ok).length,
      failed: rows.filter((item) => !item.ok).length
    }];
  }));
report.ok = report.counts.completedCases === report.counts.expectedCases
  && report.counts.passedCases === report.counts.expectedCases
  && report.counts.failedCases === 0
  && report.failures.length === 0
  && Object.values(report.categories).every((value) =>
    value.completed === value.expected && value.passed === value.expected);
writePrivateReport(outputPath, report);
if (!report.ok) {
  throw new Error(`Comprehensive search special-case E2E failed: ${report.failures.length}`);
}

process.stdout.write(`${JSON.stringify({
  ok: report.ok,
  outputPath,
  counts: report.counts,
  categories: report.categories
})}\n`);

async function executeLivePages(item) {
  if (item.category !== "cursor") return [await firstPage(item)];
  const pages = [await firstPage(item)];
  const seenCursorHashes = new Set();
  for (let pageIndex = 1; pageIndex <= MAXIMUM_CURSOR_PAGES; pageIndex += 1) {
    const cursor = pages.at(-1).body.nextCursor;
    if (cursor === null) return pages;
    const cursorHash = sha256(cursor);
    if (seenCursorHashes.has(cursorHash)) {
      throw new Error("Comprehensive search cursor did not advance");
    }
    seenCursorHashes.add(cursorHash);
    pages.push(await requestSearch(item, cursor));
  }
  throw new Error("Comprehensive search cursor exceeded the bounded page limit");
}

function firstPage(item) {
  const key = sha256(JSON.stringify({
    knowledgeBaseId: item.knowledgeBaseId,
    querySha256: item.querySha256,
    parameters: item.parameters
  }));
  if (!firstPagePromiseByKey.has(key)) {
    firstPagePromiseByKey.set(key, requestSearch(item, null));
  }
  return firstPagePromiseByKey.get(key);
}

async function requestSearch(item, cursor) {
  return retryComprehensiveSearchOperation(async () => {
    const url = new URL(
      `/openapi/v2/knowledge-bases/${encodeURIComponent(item.knowledgeBaseId)}/files/search`,
      `${openApiBaseUrl}/`
    );
    url.search = new URLSearchParams({
      query: item.query,
      ...item.parameters,
      ...(cursor === null ? {} : { cursor })
    }).toString();
    const startedAt = performance.now();
    const response = await fetch(url, { headers: { authorization } });
    const text = await response.text();
    const latencyMs = round(performance.now() - startedAt);
    report.counts.liveHttpRequests += 1;
    if (!response.ok) {
      const error = new Error(`Comprehensive search special-case HTTP ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfterMilliseconds(response.headers.get("retry-after"));
      throw error;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("Comprehensive search special-case returned invalid JSON");
    }
    return { status: response.status, latencyMs, body };
  });
}

function recordResult(item, operation) {
  try {
    const result = operation();
    report.cases.push(result);
    report.counts.completedCases += 1;
    report.counts.passedCases += 1;
  } catch (error) {
    recordFailure(item, error);
  }
}

async function recordAsyncResult(item, operation) {
  try {
    const result = await operation();
    report.cases.push(result);
    report.counts.completedCases += 1;
    report.counts.passedCases += 1;
  } catch (error) {
    recordFailure(item, error);
  }
}

function recordFailure(item, error) {
  const failure = {
    caseId: item.id,
    category: item.category,
    code: "special_case_failed",
    detail: safeError(error)
  };
  report.failures.push(failure);
  report.cases.push({
    caseId: item.id,
    category: item.category,
    execution: item.execution,
    ok: false,
    failure
  });
  report.counts.completedCases += 1;
  report.counts.failedCases += 1;
}

async function mapWithConcurrency(values, limit, operation) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      await operation(values[index]);
    }
  });
  await Promise.all(workers);
}

function loadAuthorization(filePath) {
  const contents = fs.readFileSync(filePath, "utf8").trim();
  const authorizationHeader = contents.match(/^Authorization:\s+(Bearer\s+\S+)$/iu)?.[1]
    ?? (/^Bearer\s+\S+$/iu.test(contents) ? contents : `Bearer ${contents}`);
  if (!/^Bearer\s+\S+$/iu.test(authorizationHeader)) {
    throw new Error("Authorization file must contain one API key or Bearer header");
  }
  return authorizationHeader;
}

function writePrivateReport(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(filePath, 0o600);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function readInteger(value, fallback, minimum, maximum) {
  const parsed = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error("Comprehensive search special-case concurrency is invalid");
  }
  return parsed;
}

function safeError(error) {
  return error instanceof Error ? error.message : "Unknown validation error";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function round(value) {
  return Math.round(value * 100) / 100;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
