import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = resolve(
  import.meta.dirname,
  "../migrations/001_storage_vnext.sql"
);

describe("general-purpose semantic storage schema", () => {
  it("defines the current embedding, graph, ownership, projection, and work relations", () => {
    const migration = readFileSync(migrationPath, "utf8").toLowerCase();
    for (const relation of [
      "embedding_configurations",
      "embedding_configuration_revisions",
      "model_config_revisions",
      "semantic_generations",
      "semantic_entities",
      "semantic_entity_aliases",
      "semantic_entity_observations",
      "semantic_evidence",
      "semantic_mentions",
      "semantic_relationships",
      "semantic_relationship_evidence",
      "semantic_relationship_observations",
      "semantic_communities",
      "semantic_community_memberships",
      "semantic_community_reports",
      "semantic_entity_partitions",
      "semantic_dirty_partitions",
      "embedding_artifacts",
      "embedding_artifact_owners",
      "semantic_projection_contracts",
      "semantic_vector_documents",
      "document_processing_jobs",
      "document_model_layer_executions"
    ]) {
      expect(migration).toContain(`create table focowiki.${relation}`);
    }
  });

  it("enforces scope, generation, revision, evidence, ownership, and bounded work", () => {
    const migration = readFileSync(migrationPath, "utf8").toLowerCase();
    for (const fragment of [
      "knowledge_base_id text not null",
      "semantic_generation_public_id text not null",
      "source_revision_public_id text not null",
      "embedding_configuration_revision_public_id text",
      "evidence_public_id text not null",
      "artifact_public_id text not null",
      "lease_expires_at timestamp with time zone",
      "next_attempt_at timestamp with time zone",
      "checkpoint jsonb",
      "runtime_settings_revision_public_id text",
      "generation_model_configuration_public_id text",
      "embedding_configuration_revision_public_id text",
      "model_config_revisions_immutable_update",
      "on delete cascade"
    ]) expect(migration).toContain(fragment);
  });

  it("stores source-owned observations before deriving shared fact presentation", () => {
    const migration = readFileSync(migrationPath, "utf8").toLowerCase();
    for (const fragment of [
      "semantic_entity_observations_identity_key",
      "semantic_relationship_observations_identity_key",
      "aliases jsonb not null",
      "source_file_public_id text not null",
      "source_revision_public_id text not null"
    ]) expect(migration).toContain(fragment);
  });

  it("contains no legacy compatibility, vector backfill, or automatic adoption path", () => {
    const migration = readFileSync(migrationPath, "utf8").toLowerCase();
    for (const forbidden of [
      "legacy_vector",
      "old_embedding",
      "dual_read",
      "dual_write",
      "backfill",
      "automatic_adoption",
      "provider_task_uid",
      "semantic_stage_work_items",
      "wave_ordinal",
      "settings_snapshot"
    ]) expect(migration).not.toContain(forbidden);
  });

  it("uses one fixed receipt-driven work graph and contains no configurable stage graph", () => {
    const migration = readFileSync(migrationPath, "utf8").toLowerCase();
    for (const fragment of [
      "document_artifact_work_claim_idx",
      "document_artifact_work_lease_idx",
      "document_artifact_work_kind_check",
      "document_artifact_receipts_identity_key"
    ]) expect(migration).toContain(fragment);
    for (const removed of [
      "processing_stage_dependencies",
      "processing_stage_work_items",
      "processing_stage_fairness"
    ]) expect(migration).not.toContain(`create table focowiki.${removed}`);
    expect(migration).not.toContain("document_processing_jobs_phase_check");
    expect(migration).not.toContain("document_processing_jobs_checkpoint_check");
  });
});
