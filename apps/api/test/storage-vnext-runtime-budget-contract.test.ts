import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const evidencePath = resolve(
  import.meta.dirname,
  "storage-vnext-runtime-budget.integration.test.ts"
);
const evidenceSource = existsSync(evidencePath)
  ? readFileSync(evidencePath, "utf8")
  : "";

describe("storage vNext runtime budget evidence contract", () => {
  it("measures Redis bytes, TTLs, and age convergence", () => {
    expect(evidenceSource).toContain("MEMORY");
    expect(evidenceSource).toContain("USAGE");
    expect(evidenceSource).toContain("client.ttl");
    expect(evidenceSource).toContain("REDIS_MAX_BYTES");
    expect(evidenceSource).toContain("await delay");
  });

  it("measures PostgreSQL result and audit logical plus relation bytes", () => {
    expect(evidenceSource).toContain("pg_column_size");
    expect(evidenceSource).toContain("pg_total_relation_size");
    expect(evidenceSource).toContain("RESULT_MAX_BYTES");
    expect(evidenceSource).toContain("SECURITY_AUDIT_MAX_BYTES");
    expect(evidenceSource).toContain("runStorageVnextRetentionSlice");
  });

  it("measures bounded log disk, idle CPU, and active resources", () => {
    expect(evidenceSource).toContain("statSync");
    expect(evidenceSource).toContain("process.cpuUsage");
    expect(evidenceSource).toContain("process.getActiveResourcesInfo");
    expect(evidenceSource).toContain("LOG_MAX_TOTAL_BYTES");
    expect(evidenceSource).toContain(".log.gz");
  });
});
