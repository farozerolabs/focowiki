import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document indexing schema constraints", () => {
  it("enforces scoped source and active-revision ownership", () => {
    for (const name of [
      "source_directories_scope_key",
      "source_files_scope_key",
      "source_revisions_scope_key",
      "source_file_active_revisions_file_fkey",
      "source_file_active_revisions_current_fkey",
      "source_file_active_revisions_active_fkey"
    ]) expect(bootstrap, name).toContain(`constraint ${name}`);
  });

  it("enforces one revision-owned job and a bounded fixed work graph", () => {
    for (const name of [
      "document_processing_jobs_source_revision_key",
      "document_processing_jobs_state_check",
      "document_processing_jobs_work_summary_check",
      "document_processing_jobs_model_check",
      "document_artifact_work_identity_key",
      "document_artifact_work_kind_check",
      "document_artifact_work_lease_check",
      "document_artifact_receipts_identity_key"
    ]) expect(bootstrap, name).toContain(`constraint ${name}`);
    expect(bootstrap).toContain("'prepare'::text");
    expect(bootstrap).toContain("'cleanup'::text");
    expect(bootstrap).toContain("octet_length(receipt::text) <= 131072");
  });

  it("enforces immutable model, artifact, relationship, page, and search ownership", () => {
    for (const name of [
      "document_model_analysis_results_identity_key",
      "document_model_layer_executions_identity_key",
      "source_file_identity_keys_identity_key",
      "relation_candidate_pairs_identity_key",
      "relation_directed_evidence_identity_key",
      "canonical_file_relations_identity_key",
      "search_family_receipts_identity_key",
      "generated_page_heads_path_key",
      "search_document_owners_value_check",
      "object_owners_identity_key"
    ]) expect(bootstrap, name).toContain(`constraint ${name}`);
  });

  it("indexes claims, active hydration, reverse references, and cleanup", () => {
    for (const name of [
      "document_artifact_work_claim_idx",
      "document_artifact_work_lease_idx",
      "document_processing_jobs_retry_idx",
      "source_file_active_revisions_current_idx",
      "unresolved_file_references_reverse_idx",
      "canonical_file_relations_first_active_idx",
      "canonical_file_relations_second_active_idx",
      "search_document_owners_active_idx",
      "cleanup_actions_claim_idx",
      "projection_dirty_scopes_claim_idx",
      "projection_scope_receipts_scope_output_idx",
      "scoped_activation_owners_scope_idx"
    ]) expect(bootstrap, name).toContain(`index ${name}`);
  });
});
