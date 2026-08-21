import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/005_active_projection_output_repair.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document processing generation reset migration", () => {
  it("resets every old nonterminal and failed job family", () => {
    expect(migration).toContain(
      "job.state in ('waiting', 'processing', 'error')"
    );
    expect(migration).toContain(
      "set processing_generation = 'document-indexing-v13', state = 'waiting'"
    );
    expect(migration).toContain("blocking_work_kind = 'prepare'");
  });

  it("preserves source revisions while clearing job-owned derived history", () => {
    expect(migration).not.toContain("delete from focowiki.source_revisions");
    expect(migration).not.toContain("delete from focowiki.source_files");
    expect(migration).toContain(
      "delete from focowiki.document_artifact_receipts"
    );
    expect(migration).toContain(
      "delete from focowiki.document_model_layer_executions"
    );
    expect(migration).toContain(
      "delete from focowiki.projection_scope_contributions"
    );
  });

  it("releases unowned generated objects asynchronously", () => {
    expect(migration).toContain("document_generation_released_objects");
    expect(migration).toContain("'zero_owner_object'");
    expect(migration).toContain("'object_storage'");
    expect(migration).toContain("'queued'");
  });

  it("advances the runtime generation compatibly", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v13-active-projection-output-repair'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v12-projection-object-lifecycle'"
    );
  });
});
