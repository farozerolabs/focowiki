import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const workflowRepositoryPath =
  "apps/api/src/storage-vnext/workflow/postgres-repository.ts";
const auditRepositoryPath =
  "apps/api/src/storage-vnext/audit/postgres-repository.ts";

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}

describe("storage vNext product-result and security-audit boundaries", () => {
  it("keeps live work and bounded product results in one PostgreSQL workflow repository", () => {
    expect(existsSync(resolve(workspaceRoot, workflowRepositoryPath))).toBe(true);
    if (!existsSync(resolve(workspaceRoot, workflowRepositoryPath))) return;

    const source = read(workflowRepositoryPath);
    for (const relation of [
      "focowiki.operations",
      "focowiki.operation_work_items",
      "focowiki.operation_idempotency",
      "focowiki.operation_results"
    ]) {
      expect(source, relation).toContain(relation);
    }
    expect(source).not.toMatch(/security_audit_events|diagnostic_events/u);
    expect(source).not.toMatch(/new\s+(?:Map|Set)\b|from\s+["'][^"']*redis/u);
  });

  it("keeps immutable partitioned security audit in its own PostgreSQL repository", () => {
    expect(existsSync(resolve(workspaceRoot, auditRepositoryPath))).toBe(true);
    if (!existsSync(resolve(workspaceRoot, auditRepositoryPath))) return;

    const source = read(auditRepositoryPath);
    expect(source).toContain("focowiki.security_audit_events");
    expect(source).toContain("async append(event)");
    expect(source).toContain("async list(input)");
    expect(source).not.toMatch(
      /operation_work_items|operation_idempotency|operation_results|diagnostic_events/u
    );
    expect(source).not.toMatch(/\b(?:UPDATE|DELETE)\s+focowiki\.security_audit_events\b/iu);
  });

  it("does not create a PostgreSQL repository for detailed diagnostics", () => {
    expect(existsSync(resolve(
      workspaceRoot,
      "apps/api/src/storage-vnext/audit/postgres-diagnostic-repository.ts"
    ))).toBe(false);
  });
});
