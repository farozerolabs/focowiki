#!/usr/bin/env node

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import {
  assertPostgresQueryPathLedger,
  buildPostgresQueryPathLedger,
  selectPostgresQueryPathRuntimeCandidates
} from "./lib/comprehensive-postgres-query-path-ledger.mjs";
import {
  buildComprehensiveSourceInventory
} from "./lib/comprehensive-release-inventory.mjs";

const repositoryRoot = process.cwd();
const reportDirectory = requireReportDirectory();
const reportPath = path.resolve(
  process.env.FOCOWIKI_POSTGRES_QUERY_PATH_REPORT
    || path.join(reportDirectory, "postgres-query-path-ledger-current.json")
);
const databaseUrl = requireValidationDatabaseUrl();
const phase = process.env.FOCOWIKI_POSTGRES_QUERY_PATH_PHASE?.trim()
  || "current-runtime";
const apiRequire = createRequire(path.join(repositoryRoot, "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

try {
  const inventory = buildComprehensiveSourceInventory({ repositoryRoot }).postgres;
  const observedStatements = await readObservedStatements();
  const expectedFingerprints = new Set(inventory
    .filter((item) => item.kind === "critical-query-path")
    .map((item) => item.queryFingerprint));
  const exactStatements = observedStatements.filter((statement) =>
    expectedFingerprints.has(statement.fingerprint));
  const planCandidates = selectPostgresQueryPathRuntimeCandidates({
    inventory,
    observedStatements
  });
  const { plans, failures: planCaptureFailures } = await capturePlans(planCandidates);
  const runtime = await readRuntimeState();
  const report = buildPostgresQueryPathLedger({
    phase,
    inventory,
    observedStatements,
    planEvidence: plans,
    runtime
  });
  report.capture = {
    observedStatementCount: observedStatements.length,
    exactStatementCount: exactStatements.length,
    planCandidateCount: planCandidates.length,
    planCaptureCount: plans.length,
    planCaptureFailureCount: planCaptureFailures.length,
    planCaptureFailures
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });

  if (process.env.FOCOWIKI_POSTGRES_QUERY_ALLOW_INCOMPLETE !== "1") {
    assertPostgresQueryPathLedger(report);
  }
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    output: reportPath,
    counts: report.counts,
    capture: report.capture
  })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

async function readObservedStatements() {
  const rows = await sql`
    SELECT queryid::text AS query_id,
           query,
           plans::double precision AS plans,
           calls::double precision AS calls,
           rows::double precision AS rows,
           total_plan_time::double precision AS total_plan_time_ms,
           total_exec_time::double precision AS total_exec_time_ms,
           max_exec_time::double precision AS maximum_exec_time_ms,
           shared_blks_hit::double precision AS shared_blocks_hit,
           shared_blks_read::double precision AS shared_blocks_read,
           temp_blks_written::double precision AS temp_blocks_written,
           wal_records::double precision AS wal_records,
           wal_bytes::double precision AS wal_bytes
    FROM pg_stat_statements
    WHERE query ~* 'focowiki\\.'
      AND query NOT ILIKE '%pg_stat_statements%'
      AND btrim(query) !~* '^EXPLAIN\\s'
    ORDER BY queryid
  `;
  const { createPostgresQueryShape } = await import(
    "./lib/comprehensive-persistence-inventory.mjs"
  );
  return rows.map((row) => ({
    queryId: row.query_id,
    query: row.query,
    fingerprint: createPostgresQueryShape(row.query).fingerprint,
    calls: row.calls,
    plans: row.plans,
    rows: row.rows,
    totalPlanTimeMs: row.total_plan_time_ms,
    totalExecTimeMs: row.total_exec_time_ms,
    maximumExecTimeMs: row.maximum_exec_time_ms,
    sharedBlocksHit: row.shared_blocks_hit,
    sharedBlocksRead: row.shared_blocks_read,
    tempBlocksWritten: row.temp_blocks_written,
    walRecords: row.wal_records,
    walBytes: row.wal_bytes
  }));
}

async function capturePlans(statements) {
  const plans = [];
  const failures = [];
  await sql`SET statement_timeout = '5s'`;
  await sql`SET lock_timeout = '1s'`;
  for (const statement of statements) {
    try {
      const result = await sql
        .unsafe(`EXPLAIN (GENERIC_PLAN, FORMAT JSON) ${statement.query}`)
        .simple();
      plans.push({
        queryId: statement.queryId,
        plan: extractPlan(result)
      });
    } catch (error) {
      failures.push({
        queryIdHash: sha256(statement.queryId),
        code: safePlanFailureCode(error)
      });
    }
  }
  return { plans, failures };
}

function extractPlan(result) {
  const rows = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  const plan = rows?.[0]?.["QUERY PLAN"] ?? rows?.[0]?.query_plan;
  if (!plan) throw new Error("PLAN_RESULT_MISSING");
  return plan;
}

async function readRuntimeState() {
  const [database] = await sql`
    SELECT deadlocks::double precision AS database_deadlocks
    FROM pg_stat_database
    WHERE datname = current_database()
  `;
  const [sessions] = await sql`
    SELECT count(*) FILTER (
             WHERE cardinality(pg_blocking_pids(pid)) > 0
                OR wait_event_type = 'Lock'
           )::double precision AS blocked_sessions,
           coalesce(max(
             CASE WHEN xact_start IS NULL THEN 0
                  ELSE extract(epoch FROM (clock_timestamp() - xact_start)) * 1000
             END
           ), 0)::double precision AS longest_transaction_ms
    FROM pg_stat_activity
    WHERE datname = current_database()
      AND pid <> pg_backend_pid()
  `;
  return {
    databaseDeadlocks: database?.database_deadlocks ?? 0,
    blockedSessions: sessions?.blocked_sessions ?? 0,
    longestTransactionMs: sessions?.longest_transaction_ms ?? 0
  };
}

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

function requireValidationDatabaseUrl() {
  const value = process.env.FOCOWIKI_VALIDATION_DATABASE_URL?.trim();
  if (!value) throw new Error("FOCOWIKI_VALIDATION_DATABASE_URL is required");
  const parsed = new URL(value);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname)) {
    throw new Error("PostgreSQL query-path evidence requires a loopback database target");
  }
  if (parsed.pathname !== "/focowiki") {
    throw new Error("PostgreSQL query-path evidence requires the validation focowiki database");
  }
  return value;
}

function safePlanFailureCode(error) {
  const code = String(error?.code ?? "").trim();
  if (/^[A-Z0-9_]{2,32}$/u.test(code)) return code;
  const message = String(error?.message ?? "");
  if (message === "PLAN_RESULT_MISSING") return message;
  return "GENERIC_PLAN_FAILED";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}
