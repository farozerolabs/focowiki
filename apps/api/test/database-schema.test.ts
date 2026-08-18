import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
), "utf8").replace(/\s+/gu, " ").toLowerCase();

describe("document indexing database baseline", () => {
  it("creates the final source, document, model, semantic, and search authorities", () => {
    for (const table of [
      "knowledge_bases",
      "source_directories",
      "source_files",
      "source_revisions",
      "source_file_active_revisions",
      "source_revision_presentations",
      "document_processing_jobs",
      "document_model_analysis_results",
      "document_model_layer_executions",
      "document_artifact_work",
      "document_artifact_receipts",
      "relation_candidate_pairs",
      "search_family_receipts",
      "projection_dirty_scopes",
      "projection_scope_storage_metrics",
      "document_projection_waiting_completions",
      "scoped_activation_owners",
      "knowledge_base_sequences",
      "generated_page_candidates",
      "generated_page_heads",
      "canonical_file_relations",
      "relation_directed_evidence",
      "semantic_generations",
      "semantic_entities",
      "semantic_relationships",
      "semantic_vector_documents",
      "search_projections",
      "search_document_owners",
      "object_owners",
      "cleanup_actions",
      "operation_tombstones",
      "runtime_generation"
    ]) expect(bootstrap, table).toContain(`create table focowiki.${table}`);
  });

  it("retains only terminal knowledge-base deletion handoffs and idempotent webhook creates", () => {
    expect(bootstrap).toContain("create table focowiki.operation_tombstones");
    expect(bootstrap).toContain("operation_tombstones_expiry_idx");
    expect(bootstrap).toContain("idempotency_key text");
    expect(bootstrap).toContain("request_hash text");
    expect(bootstrap).toContain("webhook_subscriptions_public_idempotency_key");
  });

  it("contains no superseded stage, publication, release, or deployment authority", () => {
    for (const table of [
      "processing_stage_work_items",
      "processing_stage_dependencies",
      "processing_stage_fairness",
      "release_candidates",
      "release_roots",
      "active_snapshots",
      "operation_dependencies",
      "deployment_scopes",
      "deployment_states",
      "semantic_maintenance_checkpoints",
      "source_relation_path_bindings"
    ]) expect(bootstrap, table).not.toContain(`create table focowiki.${table}`);
    expect(bootstrap).not.toContain("create table focowiki.candidate_identity_cards");
    expect(bootstrap).not.toContain("drop table if exists");
    expect(bootstrap).not.toContain("drop column");
  });

  it("keeps source bodies and provider search documents outside PostgreSQL", () => {
    expect(bootstrap).not.toMatch(
      /\b(raw_body|raw_content|markdown_body|json_body|file_body|search_body)\b/u
    );
    expect(bootstrap).not.toContain("to_tsvector");
    expect(bootstrap).not.toContain("tsvector");
    expect(bootstrap).not.toContain("gin_trgm_ops");
    expect(bootstrap).toContain("object_id text not null");
    expect(bootstrap).toContain("checksum_sha256 text not null");
  });

  it("stores immutable first-layer and GraphRAG execution facts", () => {
    expect(bootstrap).toContain("layer text not null");
    expect(bootstrap).toContain("provider_request_count integer not null");
    expect(bootstrap).toContain("document_model_layer_executions_identity_key");
  });

  it("writes the final runtime generation only after the schema", () => {
    const markerTable = bootstrap.indexOf("create table focowiki.runtime_generation");
    const markerInsert = bootstrap.indexOf("insert into focowiki.runtime_generation");
    expect(markerTable).toBeGreaterThan(-1);
    expect(markerInsert).toBeGreaterThan(markerTable);
    expect(bootstrap).toContain(
      "values (true, 'storage-vnext-v9-document-indexing-hybrid')"
    );
  });
});
