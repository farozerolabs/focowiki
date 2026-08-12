#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

import { reconcileComprehensiveWorkerRuntime } from
  "./lib/comprehensive-worker-runtime-ledger.mjs";

const databaseUrl = requiredEnv("FOCOWIKI_COMPREHENSIVE_DATABASE_URL");
const reportPath = path.resolve(requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_WORKER_REPORT"
));
const inventoryPath = path.resolve(
  process.env.FOCOWIKI_COMPREHENSIVE_SOURCE_INVENTORY?.trim()
    || "ReferenceDocs/validation/comprehensive-large-scale-release/source-inventory.json"
);
const knowledgeBaseIds = requiredEnv(
  "FOCOWIKI_COMPREHENSIVE_KNOWLEDGE_BASE_IDS"
).split(",").map((value) => value.trim()).filter(Boolean);
if (knowledgeBaseIds.length !== 2 || new Set(knowledgeBaseIds).size !== 2) {
  throw new Error("Comprehensive worker ledger requires exactly two knowledge bases");
}

const apiRequire = createRequire(path.join(process.cwd(), "apps/api/package.json"));
const postgres = apiRequire("postgres");
const sql = postgres(databaseUrl, {
  max: 2,
  connect_timeout: 10,
  idle_timeout: 5,
  prepare: false
});

try {
  const inventory = readJson(inventoryPath);
  const deletionEvidencePath = path.resolve(
    process.env.FOCOWIKI_COMPREHENSIVE_SEMANTIC_DELETION_REPORT?.trim()
      || path.join(path.dirname(reportPath), "semantic-deletion-race.json")
  );
  const deletionEvidence = readJson(deletionEvidencePath);
  if (
    deletionEvidence.ok !== true
    || deletionEvidence.observations?.drainingContinuationObserved !== true
    || deletionEvidence.observations?.sourceReadStatusAfterDeletion !== 404
  ) {
    throw new Error("Comprehensive worker cleanup-stage evidence is incomplete");
  }
  const workerValues = new Set((inventory.inventory?.workers ?? [])
    .filter((item) => item.kind === "worker-value")
    .map((item) => item.name));
  const expectedStages = [
    "cleanup",
    "community",
    "embedding",
    "extraction",
    "publication",
    "reconciliation",
    "validation",
    "vector"
  ];
  for (const stageKind of expectedStages) {
    if (!workerValues.has(stageKind)) {
      throw new Error(`Comprehensive worker inventory is missing ${stageKind}`);
    }
  }
  const [sourceCountRows, stageRows, operationRows, dirtyRows, cleanupRows, webhookRows] =
    await Promise.all([
      sql`
        SELECT count(*)::integer AS source_count
        FROM focowiki.source_files
        WHERE knowledge_base_id IN ${sql(knowledgeBaseIds)}
          AND status = 'ready' AND deleted_at IS NULL
      `,
      sql`
        SELECT public_id, stage_kind, state, attempt_count, maximum_attempts,
               lease_owner, lease_expires_at, safe_error_code, completed_at
        FROM focowiki.semantic_stage_work_items
        WHERE knowledge_base_id IN ${sql(knowledgeBaseIds)}
        ORDER BY public_id COLLATE "C"
      `,
      sql`
        SELECT operation_public_id, work_kind, state, attempt_count,
               lease_owner, lease_expires_at, safe_error_code, updated_at
        FROM focowiki.operation_work_items
        WHERE knowledge_base_id IN ${sql(knowledgeBaseIds)}
        ORDER BY operation_public_id COLLATE "C"
      `,
      sql`
        SELECT public_id, reason_kind, state, attempt_count,
               lease_owner, lease_expires_at, safe_error_code, updated_at
        FROM focowiki.semantic_dirty_partitions
        WHERE knowledge_base_id IN ${sql(knowledgeBaseIds)}
        ORDER BY public_id COLLATE "C"
      `,
      sql`
        SELECT public_id, action_kind, state, attempt_count, required,
               not_before, lease_owner, lease_expires_at, safe_error_code, updated_at
        FROM focowiki.cleanup_actions
        WHERE knowledge_base_id IN ${sql(knowledgeBaseIds)}
        ORDER BY sequence_number, public_id COLLATE "C"
      `,
      sql`
        SELECT public_id, event_type, state, attempt_count,
               lease_owner, lease_expires_at, safe_error_code, completed_at
        FROM focowiki.webhook_deliveries
        WHERE knowledge_base_id IN ${sql(knowledgeBaseIds)}
        ORDER BY public_id COLLATE "C"
      `
    ]);
  if (Number(sourceCountRows[0]?.source_count) !== 200) {
    throw new Error("Comprehensive worker ledger requires the exact 200-source corpus");
  }
  const observedAt = new Date().toISOString();
  const reconciliation = reconcileComprehensiveWorkerRuntime({
    observedAt,
    expectedStages,
    stageEvidence: [{ stageKind: "cleanup", pass: true }],
    stageItems: stageRows.map((row) => ({
      identity: hashIdentity(row.public_id),
      stageKind: row.stage_kind,
      state: row.state,
      attemptCount: row.attempt_count,
      maximumAttempts: row.maximum_attempts,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: timestamp(row.lease_expires_at),
      safeErrorCode: row.safe_error_code,
      completedAt: timestamp(row.completed_at)
    })),
    operationItems: operationRows.map((row) => ({
      identity: hashIdentity(row.operation_public_id),
      workKind: row.work_kind,
      state: row.state,
      attemptCount: row.attempt_count,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: timestamp(row.lease_expires_at),
      safeErrorCode: row.safe_error_code,
      completedAt: timestamp(row.updated_at)
    })),
    dirtyItems: dirtyRows.map((row) => ({
      identity: hashIdentity(row.public_id),
      reasonKind: row.reason_kind,
      state: row.state,
      attemptCount: row.attempt_count,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: timestamp(row.lease_expires_at),
      safeErrorCode: row.safe_error_code,
      completedAt: timestamp(row.updated_at)
    })),
    cleanupItems: cleanupRows.map((row) => ({
      identity: hashIdentity(row.public_id),
      actionKind: row.action_kind,
      state: row.state,
      attemptCount: row.attempt_count,
      required: row.required,
      notBefore: timestamp(row.not_before),
      leaseOwner: row.lease_owner,
      leaseExpiresAt: timestamp(row.lease_expires_at),
      safeErrorCode: row.safe_error_code,
      completedAt: timestamp(row.updated_at)
    })),
    webhookItems: webhookRows.map((row) => ({
      identity: hashIdentity(row.public_id),
      eventType: row.event_type,
      state: row.state,
      attemptCount: row.attempt_count,
      leaseOwner: row.lease_owner,
      leaseExpiresAt: timestamp(row.lease_expires_at),
      safeErrorCode: row.safe_error_code,
      completedAt: timestamp(row.completed_at)
    }))
  });
  const report = {
    format: "focowiki-comprehensive-worker-runtime-ledger-v1",
    generatedAt: observedAt,
    sourceCount: 200,
    evidence: {
      cleanupStageReportSha256: createHash("sha256")
        .update(fs.readFileSync(deletionEvidencePath))
        .digest("hex")
    },
    ...reconciliation
  };
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(reportPath, 0o600);
  process.stdout.write(`${JSON.stringify({
    ok: report.ok,
    reportPath,
    sourceCount: report.sourceCount,
    counts: report.counts
  })}\n`);
} finally {
  await sql.end({ timeout: 5 });
}

function hashIdentity(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

function timestamp(value) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
