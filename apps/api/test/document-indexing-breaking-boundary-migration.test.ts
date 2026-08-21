import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/005_clean_document_indexing_boundary.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document indexing breaking boundary migration", () => {
  it("requires an empty application database", () => {
    expect(migration).toContain("perform a clean reset");
    expect(migration).toContain("from focowiki.knowledge_bases");
    expect(migration).toContain("from focowiki.document_processing_jobs");
    expect(migration).toContain("from focowiki.operations");
  });

  it("adds the current processing generation and durable upload summary schema", () => {
    expect(migration).toContain("add column processing_generation text");
    expect(migration).toContain("default 'document-indexing-v13'");
    expect(migration).toContain("document_processing_jobs_generation_reset_idx");
    expect(migration).toContain("create table focowiki.upload_operation_summaries");
    expect(migration).toContain("upload_operation_summaries_expiry_idx");
  });

  it("does not rewrite document, operation, upload, or projection state", () => {
    for (const statement of [
      "update focowiki.document_processing_jobs",
      "update focowiki.document_artifact_work",
      "update focowiki.operations",
      "delete from focowiki.operation_results",
      "delete from focowiki.document_artifact_receipts",
      "delete from focowiki.projection_scope_contributions",
      "delete from focowiki.upload_sessions",
      "create temp table"
    ]) expect(migration).not.toContain(statement);
  });

  it("advances only the runtime generation marker", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v13-clean-document-indexing'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v12-projection-object-lifecycle'"
    );
  });
});
