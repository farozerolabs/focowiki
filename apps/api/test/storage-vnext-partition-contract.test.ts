import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  STORAGE_VNEXT_TIME_PARTITION_FAMILIES,
  planStorageVnextPartitionRetention,
  storageVnextPartitionWindows
} from "../src/storage-vnext/retention/postgres-partitions.js";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const bootstrap = readFileSync(
  resolve(workspaceRoot, "apps/api/migrations/001_storage_vnext.sql"),
  "utf8"
).replace(/\s+/gu, " ").toLowerCase();

describe("storage vNext measured time partition contract", () => {
  it("partitions only security audit and high-volume diagnostics", () => {
    expect(STORAGE_VNEXT_TIME_PARTITION_FAMILIES).toEqual([
      "security_audit_events",
      "diagnostic_events"
    ]);
    expect(bootstrap).toMatch(
      /create table focowiki\.security_audit_events [^;]+ partition by range \(created_at\)/u
    );
    expect(bootstrap).toMatch(
      /create table focowiki\.diagnostic_events [^;]+ partition by range \(created_at\)/u
    );
    expect(bootstrap).not.toMatch(
      /create table focowiki\.operation_results [^;]+ partition by/u
    );
    expect(bootstrap).not.toMatch(
      /create table focowiki\.(operations|operation_work_items|cleanup_actions) [^;]+ partition by/u
    );
  });

  it("uses partition-compatible identities without a catch-all partition", () => {
    expect(bootstrap).toContain(
      "security_audit_events_pkey primary key (created_at, public_id)"
    );
    expect(bootstrap).toContain(
      "diagnostic_events_pkey primary key (created_at, public_id)"
    );
    expect(bootstrap).not.toContain("default partition");
    expect(bootstrap).not.toMatch(/partition of [^;]+ default/u);
  });

  it("plans current and next UTC month deterministically", () => {
    expect(storageVnextPartitionWindows(new Date("2026-08-17T12:30:00Z"))).toEqual([
      {
        family: "security_audit_events",
        tableName: "security_audit_events_2026_08",
        from: "2026-08-01",
        to: "2026-09-01"
      },
      {
        family: "security_audit_events",
        tableName: "security_audit_events_2026_09",
        from: "2026-09-01",
        to: "2026-10-01"
      },
      {
        family: "diagnostic_events",
        tableName: "diagnostic_events_2026_08",
        from: "2026-08-01",
        to: "2026-09-01"
      },
      {
        family: "diagnostic_events",
        tableName: "diagnostic_events_2026_09",
        from: "2026-09-01",
        to: "2026-10-01"
      }
    ]);
  });

  it("prunes only complete recognized partitions before the cutoff", () => {
    expect(planStorageVnextPartitionRetention({
      family: "security_audit_events",
      before: new Date("2026-09-01T00:00:00Z"),
      installedTableNames: [
        "security_audit_events_2026_06",
        "security_audit_events_2026_08",
        "security_audit_events_2026_09",
        "diagnostic_events_2026_07",
        "diagnostic_events_2026_08",
        "operation_results_2026_01",
        "security_audit_events_default",
        "security_audit_events_2026_13"
      ]
    })).toEqual([
      "security_audit_events_2026_06",
      "security_audit_events_2026_08"
    ]);
  });

  it("rejects invalid anchors and non-month retention boundaries", () => {
    expect(() => storageVnextPartitionWindows(new Date("invalid"))).toThrow(
      "valid UTC date"
    );
    expect(() => planStorageVnextPartitionRetention({
      family: "security_audit_events",
      before: new Date("2026-09-02T00:00:00Z"),
      installedTableNames: []
    })).toThrow("UTC month boundary");
  });
});
