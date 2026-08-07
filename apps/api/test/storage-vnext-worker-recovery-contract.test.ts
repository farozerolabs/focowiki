import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const workspaceRoot = resolve(import.meta.dirname, "../../..");
const workflow = read("apps/api/src/storage-vnext/workflow/postgres-repository.ts");
const cleanup = read(
  "apps/api/src/storage-vnext/cleanup/postgres-cleanup-action-repository.ts"
);
const search = read("apps/api/src/storage-vnext/search/candidate-lifecycle.ts");
const release = read("apps/api/src/storage-vnext/release/postgres-repository.ts");

describe("storage vNext worker recovery contract", () => {
  it("requeues expired workflow and cleanup leases through bounded locked pages", () => {
    for (const [name, source] of [["workflow", workflow], ["cleanup", cleanup]] as const) {
      expect(source, name).toContain("async recoverStale(input)");
      expect(source, name).toMatch(/FOR UPDATE(?: OF work)? SKIP LOCKED/u);
      expect(source, name).toMatch(/lease_expires_at <= \$\{input\.expiredBefore\}/u);
      expect(source, name).toContain("SET state = 'retry'");
      expect(source, name).toContain("lease_owner = NULL, lease_expires_at = NULL");
    }
  });

  it("prevents duplicate claims with PostgreSQL row ownership", () => {
    expect(workflow).toContain("FOR UPDATE OF work SKIP LOCKED");
    expect(cleanup).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("preserves the durable checkpoint and attempt when recovering a worker restart", () => {
    const recovery = workflow.slice(
      workflow.indexOf("async recoverStale(input)"),
      workflow.indexOf("async renew(input)")
    );
    expect(recovery).not.toMatch(/checkpoint\s*=/u);
    expect(recovery).not.toMatch(/attempt_count\s*=\s*[^,]+\+/u);
    expect(recovery).toContain("safe_error_code = ${input.reasonCode}");
  });

  it("keeps API restart recovery in durable idempotency and result rows", () => {
    expect(workflow).toContain("async findIdempotent(input)");
    expect(workflow).toContain("focowiki.operation_idempotency");
    expect(workflow).toContain("focowiki.operation_results");
    expect(workflow).not.toMatch(/new Map|new Set/u);
  });

  it("resumes provider work by stable correlation after provider restart", () => {
    expect(search).toContain("findOperationByCorrelation");
    expect(search).toContain("correlationPublicId");
    expect(search).toContain("providerOperationRef");
  });

  it("uses one transaction so a crash before commit exposes no partial workflow", () => {
    const enqueue = workflow.slice(
      workflow.indexOf("async enqueue(work)"),
      workflow.indexOf("async claim(input)")
    );
    expect(enqueue).toContain("sql.begin");
    expect(enqueue).toContain("focowiki.operations");
    expect(enqueue).toContain("focowiki.operation_work_items");
    expect(enqueue).toContain("focowiki.operation_idempotency");
  });

  it("converges deterministic operation insertion across every unique arbiter", () => {
    const enqueue = workflow.slice(
      workflow.indexOf("async enqueue(work)"),
      workflow.indexOf("async claim(input)")
    );
    expect(enqueue).toContain("ON CONFLICT DO NOTHING");
    expect(enqueue).not.toContain("ON CONFLICT (public_id) DO NOTHING");
    expect(enqueue).toContain("operation.knowledge_base_id !== work.knowledgeBaseId");
    expect(enqueue).toContain("operation.operation_kind !== work.kind");
  });

  it("reconciles an accepted external write before issuing another write", () => {
    const acceptedWindow = search.slice(
      search.indexOf("async writeDocumentBatch(input)"),
      search.indexOf("async function ensureIndex")
    );
    expect(acceptedWindow.indexOf("findOperationByCorrelation"))
      .toBeLessThan(acceptedWindow.indexOf("writeDocuments"));
  });

  it("recognizes an operation-owned active snapshot after an activation crash", () => {
    const activation = release.slice(
      release.indexOf("async activateCandidate(input)"),
      release.indexOf("async terminateCandidate(input)")
    );
    expect(activation).toContain("readCandidateEvent");
    expect(activation).toContain("event.release_root_public_id === active.releaseRootPublicId");
    expect(activation).toContain('outcome: "activated" as const');
  });
});

function read(path: string): string {
  return readFileSync(resolve(workspaceRoot, path), "utf8");
}
