import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const retentionPath = resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/retention/postgres-retention.ts"
);
const retentionSource = existsSync(retentionPath)
  ? readFileSync(retentionPath, "utf8")
  : "";
const partitionSource = readFileSync(resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/retention/postgres-partitions.ts"
), "utf8");
const maintenanceSource = readFileSync(resolve(
  workspaceRoot,
  "apps/api/src/storage-vnext/maintenance/production-runtime.ts"
), "utf8");
const logSinkSource = readFileSync(resolve(
  workspaceRoot,
  "apps/api/src/file-log-sink.ts"
), "utf8");

describe("storage vNext retention authority contract", () => {
  it("bounds product results without deleting business or live recovery state", () => {
    expect(retentionSource).toContain("pruneStorageVnextOperationResults");
    expect(retentionSource).toContain("DELETE FROM focowiki.operation_results");
    expect(retentionSource).toContain("FOR UPDATE OF result SKIP LOCKED");
    expect(retentionSource).toContain("expires_at");
    expect(retentionSource).toContain("replay.expires_at > ${input.now.toISOString()}");
    expect(retentionSource).toContain("192 * 1024 * 1024");
    expect(retentionSource).toContain("maxRows");
    expect(retentionSource).not.toMatch(
      /DELETE FROM focowiki\.(?:operations|operation_work_items|operation_idempotency)/u
    );
  });

  it("bounds product-visible source event summaries independently", () => {
    expect(retentionSource).toContain("pruneStorageVnextSourceEventSummaries");
    expect(retentionSource).toContain("DELETE FROM focowiki.source_event_summaries");
    expect(retentionSource).toContain("STORAGE_VNEXT_SOURCE_EVENT_MAX_ROWS");
    expect(retentionSource).toContain("STORAGE_VNEXT_SOURCE_EVENT_MAX_BYTES");
  });

  it("uses an independent bounded security-audit policy and exact-family partition pruning", () => {
    expect(retentionSource).toContain("pruneStorageVnextSecurityAudit");
    expect(retentionSource).toContain("DELETE FROM focowiki.security_audit_events");
    expect(retentionSource).toContain("128 * 1024 * 1024");
    expect(retentionSource).toContain("securityAuditRetentionDays");
    expect(partitionSource).toContain("family: StorageVnextTimePartitionFamily");
    expect(partitionSource).toContain("parent.relname = ${input.family}");
    expect(partitionSource).not.toContain(
      "parent.relname IN ('security_audit_events', 'diagnostic_events')"
    );
  });

  it("runs from maintenance while log deletion remains storage-authority independent", () => {
    expect(maintenanceSource).toContain("runStorageVnextRetentionSlice");
    expect(retentionSource).toContain("ensureStorageVnextTimePartitions");
    expect(logSinkSource).not.toMatch(/storage-vnext|DatabaseClient|operation_results|security_audit/u);
    expect(retentionSource).not.toMatch(/file-log-sink|RuntimeFileLogSink|rmSync|unlinkSync/u);
  });
});
