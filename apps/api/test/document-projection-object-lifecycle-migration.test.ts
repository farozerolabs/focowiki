import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/004_projection_output_object_lifecycle.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document projection object lifecycle migration", () => {
  it("records durable object references owned by exact scope outputs", () => {
    expect(migration).toContain("create table focowiki.projection_scope_object_refs");
    expect(migration).toContain(
      "foreign key (scope_public_id, rendered_sequence) references focowiki.projection_scope_outputs"
    );
    expect(migration).toContain(
      "foreign key (object_id) references focowiki.object_registrations"
    );
  });

  it("requeues the two internally repaired failure families only", () => {
    expect(migration).toContain("'invalid_input'");
    expect(migration).toContain("'page_object_unverified'");
    expect(migration).not.toContain("provider_request_rejected");
  });

  it("preserves valid repair outputs and rerenders invalid exact receipts", () => {
    expect(migration).toContain(
      "join projection_lifecycle_repair_jobs repair on repair.document_job_public_id = contribution.document_job_public_id"
    );
    expect(migration).toContain(
      "create temp table projection_lifecycle_invalid_repair_outputs"
    );
    expect(migration).toContain(
      "create temp table projection_lifecycle_repair_contributions"
    );
    expect(migration).toContain(
      "partition by contribution.scope_public_id order by contribution.public_id collate \"c\""
    );
  });

  it("advances the deployed projection throughput generation", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v12-projection-object-lifecycle'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v11-projection-throughput'"
    );
  });
});
