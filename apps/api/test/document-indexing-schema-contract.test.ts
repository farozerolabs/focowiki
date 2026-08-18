import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migration = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

const requiredTables = [
  "knowledge_base_sequences",
  "scoped_activation_owners",
  "relationship_evaluations",
  "document_model_analysis_results",
  "document_model_layer_executions",
  "source_file_active_revisions",
  "source_revision_presentations",
  "document_processing_jobs",
  "document_artifact_work",
  "document_artifact_receipts",
  "document_graphrag_chunks",
  "relation_candidate_pairs",
  "relation_directed_evidence",
  "canonical_file_relations",
  "search_family_receipts",
  "generated_page_bases",
  "projection_dirty_scopes",
  "projection_scope_outputs",
  "projection_scope_storage_metrics",
  "document_projection_waiting_completions",
  "generated_page_candidates",
  "generated_page_heads",
  "generated_directory_leaves",
  "generated_directory_leaf_entries",
  "source_file_identity_keys",
  "unresolved_file_references",
  "search_projections",
  "search_document_owners",
  "object_owners",
  "cleanup_actions"
] as const;

const requiredConstraints = [
  "document_processing_jobs_source_revision_key",
  "document_processing_jobs_state_check",
  "document_processing_jobs_attempt_check",
  "document_processing_jobs_terminal_check",
  "document_processing_jobs_error_check",
  "document_processing_jobs_model_check",
  "document_artifact_work_identity_key",
  "document_artifact_work_kind_check",
  "document_artifact_work_state_check",
  "document_artifact_work_lease_check",
  "document_artifact_receipts_identity_key",
  "document_artifact_receipts_kind_check",
  "document_graphrag_chunks_identity_key",
  "relation_candidate_pairs_identity_key",
  "relation_directed_evidence_identity_key",
  "canonical_file_relations_identity_key",
  "search_family_receipts_identity_key",
  "generated_page_bases_source_revision_key",
  "projection_dirty_scopes_identity_key",
  "projection_scope_outputs_value_check",
  "projection_scope_storage_metrics_value_check",
  "scoped_activation_owners_identity_key",
  "knowledge_base_sequences_value_check",
  "generated_page_heads_path_key",
  "generated_directory_leaves_identity_key",
  "generated_directory_leaf_entries_identity_key",
  "source_file_identity_keys_identity_key",
  "source_file_identity_keys_value_check",
  "unresolved_file_references_identity_key",
  "search_projections_value_check",
  "search_document_owners_value_check",
  "source_file_active_revisions_value_check",
  "relationship_evaluations_identity_key",
  "relationship_evaluations_value_check",
  "document_model_analysis_results_identity_key",
  "document_model_analysis_results_value_check",
  "document_model_layer_executions_identity_key",
  "document_model_layer_executions_value_check"
] as const;

const requiredIndexes = [
  "document_processing_jobs_current_idx",
  "document_processing_jobs_retry_idx",
  "document_processing_jobs_source_list_idx",
  "document_processing_jobs_knowledge_base_list_idx",
  "document_processing_jobs_operation_list_idx",
  "document_processing_jobs_retention_idx",
  "document_artifact_work_claim_idx",
  "document_artifact_work_lease_idx",
  "document_artifact_work_job_idx",
  "document_artifact_receipts_source_revision_idx",
  "document_graphrag_chunks_claim_idx",
  "relation_candidate_pairs_claim_idx",
  "relation_directed_evidence_source_idx",
  "canonical_file_relations_first_active_idx",
  "canonical_file_relations_second_active_idx",
  "search_family_receipts_flush_idx",
  "generated_page_bases_source_revision_idx",
  "projection_dirty_scopes_claim_idx",
  "projection_scope_receipts_scope_output_idx",
  "projection_scope_outputs_created_idx",
  "document_projection_waiting_ready_idx",
  "scoped_activation_owners_scope_idx",
  "generated_page_heads_path_idx",
  "generated_page_heads_semantic_scope_idx",
  "generated_directory_leaves_order_idx",
  "generated_directory_leaf_entries_leaf_idx",
  "source_file_identity_keys_active_lookup_idx",
  "source_file_identity_keys_source_revision_idx",
  "unresolved_file_references_reverse_idx",
  "unresolved_file_references_source_idx",
  "unresolved_file_references_resolved_target_idx",
  "relationship_evaluations_source_idx",
  "relationship_evaluations_target_idx",
  "document_model_analysis_results_source_idx",
  "document_model_layer_executions_job_idx",
  "source_file_active_revisions_active_idx",
  "source_file_active_revisions_current_idx",
  "source_revision_presentations_current_path_idx",
  "semantic_vector_documents_source_revision_idx",
  "search_document_owners_source_revision_idx",
  "search_document_owners_active_idx",
  "search_projections_one_active_idx",
  "cleanup_actions_claim_idx",
  "cleanup_actions_lease_idx",
  "cleanup_actions_obsolete_artifact_idx"
] as const;

const removedTables = [
  "file_relations",
  "file_relation_evidence",
  "document_revision_artifacts",
  "knowledge_base_activation_revisions",
  "knowledge_base_activation_changes",
  "source_artifact_bundles",
  "processing_stage_work_items",
  "processing_stage_dependencies",
  "processing_stage_fairness",
  "processing_source_summaries",
  "processing_operation_summaries",
  "release_candidates",
  "release_candidate_changed_facts",
  "release_candidate_dependencies",
  "release_candidate_graph_edges",
  "release_candidate_graph_evidence",
  "release_candidate_graph_nodes",
  "release_candidate_validations",
  "release_roots",
  "release_root_shards",
  "release_shards",
  "release_catalog_entries",
  "release_catalog_tombstones",
  "release_event_summaries",
  "active_snapshots"
] as const;

describe("document indexing destructive schema contract", () => {
  it("creates every document-owned authority", () => {
    for (const table of requiredTables) {
      expect(migration, table).toContain(`create table focowiki.${table}`);
    }
  });

  it("does not create a duplicate candidate-card projection", () => {
    expect(migration).not.toContain("candidate_identity_cards");
  });

  it("enforces every required ownership and bounded-lifecycle constraint", () => {
    for (const constraint of requiredConstraints) {
      expect(migration, constraint).toContain(`constraint ${constraint}`);
    }
    for (const state of [
      "'waiting'::text", "'processing'::text", "'available'::text",
      "'error'::text", "'deleting'::text", "'cancelled'::text",
      "'superseded'::text"
    ]) expect(migration).toContain(state);
    for (const kind of [
      "'prepare'::text", "'first_layer'::text", "'content_projection'::text",
      "'graphrag'::text", "'relation_reconcile'::text",
      "'knowledge_projection'::text", "'activate'::text", "'cleanup'::text"
    ]) expect(migration).toContain(kind);
    expect(migration).not.toContain("document_processing_jobs_checkpoint_check");
    expect(migration).not.toContain("document_processing_jobs_phase_check");
    expect(migration).toContain("document_processing_jobs_immutable_contract");
    expect(migration).toContain("source_file_active_revisions_validate");
    expect(migration).toContain("page_source_file_public_id text");
    expect(migration).toContain("page_source_revision_public_id text");
    expect(migration).toContain("source_work_public_id text");
    expect(migration).toContain("generated_page_candidates_work_fkey");
    expect(migration).not.toContain("generated_page_candidates_receipt_fkey");
    expect(migration).toContain("generated_page_candidates_page_owner_check");
    expect(migration).toContain("owner_operation_public_id text");
    expect(migration).toContain("generated_page_candidates_owner_check");
    expect(migration).toContain("generated_page_candidates_operation_path_key");
    expect(migration).toContain(
      "source_revision_public_id, base_activation_revision, normalized_path, checksum_sha256"
    );
    expect(migration).toContain(
      "owner_operation_public_id, base_activation_revision, normalized_path, checksum_sha256"
    );
  });

  it("creates every current, claim, list, relation, owner, and cleanup index", () => {
    for (const index of requiredIndexes) {
      expect(migration, index).toContain(`index ${index}`);
    }
  });

  it("omits every stage, publication, release-root, and search-epoch authority", () => {
    for (const table of removedTables) {
      expect(migration, table).not.toContain(`create table focowiki.${table}`);
    }
    expect(migration).not.toContain("drop table if exists");
    expect(migration).not.toContain("drop column");
    expect(migration).not.toContain("projection_role text");
  });

  it("terminates at the document-indexing runtime generation", () => {
    expect(migration).toContain(
      "values (true, 'storage-vnext-v9-document-indexing-hybrid')"
    );
  });
});
