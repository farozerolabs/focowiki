import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/003_document_projection_throughput.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document projection throughput migration", () => {
  it("adds bounded waiter and contribution access paths", () => {
    expect(migration).toContain(
      "projection_scope_contributions_waiting_job_idx on focowiki.projection_scope_contributions ( document_job_public_id, scope_public_id, required_sequence )"
    );
    expect(migration).toContain(
      "projection_dirty_scopes_error_idx on focowiki.projection_dirty_scopes"
    );
    expect(migration).toContain(
      "document_artifact_work_projection_waiting_idx on focowiki.document_artifact_work"
    );
  });

  it("persists bounded scheduling pressure on each scope", () => {
    expect(migration).toContain("add column waiting_contribution_count integer");
    expect(migration).toContain("add column oldest_waiting_contribution_at");
    expect(migration).toContain("projection_dirty_scopes_waiting_pressure_idx");
  });

  it("retires legacy receipt-only projection gates during upgrade", () => {
    expect(migration).toContain(
      "scope.scope_kind in ('relation', 'graph') and contribution.state = 'waiting'"
    );
    expect(migration).toContain(
      "where scope_kind in ('relation', 'graph') and state <> 'running'"
    );
  });

  it("requeues only terminal failures fixed by this upgrade", () => {
    expect(migration).toContain(
      "work.safe_error_code in ( 'projection_scope_output_limit_exceeded', 'projection_scope_contributor_limit_exceeded' )"
    );
    expect(migration).toContain(
      "work.work_kind = 'activate' and work.safe_error_code = '23505'"
    );
    expect(migration).not.toContain("provider_request_rejected");
  });

  it("advances only the deployed v10 generation", () => {
    expect(migration).toContain(
      "set generation = 'storage-vnext-v11-projection-throughput'"
    );
    expect(migration).toContain(
      "and generation = 'storage-vnext-v10-document-indexing-throughput'"
    );
  });
});
