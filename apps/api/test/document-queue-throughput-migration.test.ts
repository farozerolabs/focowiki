import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/002_document_queue_throughput.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document queue throughput migration", () => {
  it("replaces the waiting claim index with the work-kind access path", () => {
    expect(migration).toContain(
      "drop index focowiki.document_artifact_work_claim_idx"
    );
    expect(migration).toContain(
      "document_artifact_work_claim_idx on focowiki.document_artifact_work ( work_kind, next_eligible_at, created_at, public_id )"
    );
    expect(migration).toContain("where state = 'waiting'");
    expect(migration).toContain(
      "document_artifact_receipts_work_idx on focowiki.document_artifact_receipts (work_public_id)"
    );
  });

  it("advances only the deployed v9 generation", () => {
    expect(migration).toContain(
      "drop constraint runtime_generation_value_check"
    );
    expect(migration).toContain(
      "set generation = 'storage-vnext-v10-document-indexing-throughput'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v9-document-indexing-hybrid'"
    );
    expect(migration).toContain(
      "add constraint runtime_generation_value_check check ( generation = 'storage-vnext-v10-document-indexing-throughput' )"
    );
  });
});
