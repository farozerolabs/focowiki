import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
)
  .replace(/\s+/gu, " ")
  .replace(/\(\s+/gu, "(")
  .replace(/\s+\)/gu, ")")
  .toLowerCase();

describe("storage vNext schema constraints", () => {
  it("persists source-directory timestamps required by the released API", () => {
    expect(bootstrap).toMatch(
      /create table focowiki\.source_directories \([^;]*created_at timestamp with time zone not null default now\(\), updated_at timestamp with time zone not null default now\(\), deleted_at timestamp with time zone/u
    );
  });

  it("uses scoped keys and foreign keys for catalog ownership", () => {
    for (const constraint of [
      "source_directories_scope_key unique (knowledge_base_id, public_id)",
      "source_directories_path_key unique (knowledge_base_id, normalized_path)",
      "source_directories_parent_fkey foreign key (knowledge_base_id, parent_public_id)",
      "source_files_scope_key unique (knowledge_base_id, public_id)",
      "source_files_path_key unique (knowledge_base_id, normalized_path)",
      "source_files_directory_fkey foreign key (knowledge_base_id, directory_public_id)",
      "source_revisions_scope_key unique (knowledge_base_id, public_id)",
      "source_revisions_content_key unique (knowledge_base_id, source_file_public_id, checksum_sha256)",
      "source_revisions_file_fkey foreign key (knowledge_base_id, source_file_public_id)",
      "source_file_current_revisions_file_fkey foreign key (knowledge_base_id, source_file_public_id)",
      "source_file_current_revisions_revision_fkey foreign key (knowledge_base_id, source_file_public_id, source_revision_public_id)"
    ]) {
      expect(bootstrap, constraint).toContain(constraint);
    }
  });

  it("rejects cross-scope graph, release, search, and object ownership", () => {
    for (const constraint of [
      "graph_nodes_scope_key unique (knowledge_base_id, public_id)",
      "graph_nodes_source_revision_fkey foreign key (knowledge_base_id, source_file_public_id, source_revision_public_id)",
      "graph_edges_from_node_fkey foreign key (knowledge_base_id, from_node_public_id)",
      "graph_edges_to_node_fkey foreign key (knowledge_base_id, to_node_public_id)",
      "release_roots_scope_key unique (knowledge_base_id, public_id)",
      "search_projections_scope_key unique (knowledge_base_id, public_id)",
      "search_projections_role_key unique (knowledge_base_id, projection_role)",
      "active_snapshots_release_root_fkey foreign key (knowledge_base_id, release_root_public_id)",
      "active_snapshots_search_projection_fkey foreign key (knowledge_base_id, search_projection_public_id)",
      "object_owners_source_revision_fkey foreign key (knowledge_base_id, source_revision_public_id)",
      "object_owners_release_root_fkey foreign key (knowledge_base_id, release_root_public_id)",
      "object_owners_release_shard_fkey foreign key (knowledge_base_id, release_shard_public_id)",
      "object_owners_operation_fkey foreign key (knowledge_base_id, operation_public_id)"
    ]) {
      expect(bootstrap, constraint).toContain(constraint);
    }
  });

  it("constrains root cardinality, paths, idempotency, and owner identity", () => {
    for (const constraint of [
      "release_roots_role_check check (root_role in ('active', 'candidate', 'rollback', 'base'))",
      "release_roots_role_key unique (knowledge_base_id, root_slot)",
      "release_roots_base_fkey foreign key (knowledge_base_id, base_root_public_id)",
      "operation_idempotency_key unique (knowledge_base_id, idempotency_key)",
      "object_owners_identity_key unique (object_id, owner_kind, owner_public_id)",
      "object_owners_target_check check",
      "runtime_setting_current_singleton_check check (singleton)",
      "runtime_generation_singleton_check check (singleton)",
      "runtime_generation_value_check check (generation = 'storage-vnext-v1')"
    ]) {
      expect(bootstrap, constraint).toContain(constraint);
    }
  });

  it("bounds every JSON payload and all persisted byte/count facts", () => {
    for (const payload of [
      ["source_files_metadata_check", "octet_length(metadata::text) <= 8192"],
      ["runtime_setting_revisions_values_check", "octet_length(settings_values::text) <= 65536"],
      ["model_configs_config_check", "octet_length(config::text) <= 32768"],
      ["webhook_subscriptions_event_types_check", "octet_length(event_types::text) <= 8192"],
      ["graph_nodes_metadata_check", "octet_length(metadata::text) <= 8192"],
      ["operation_work_items_checkpoint_check", "octet_length(checkpoint::text) <= 32768"],
      ["cleanup_actions_checkpoint_check", "octet_length(checkpoint::text) <= 32768"],
      ["operation_results_summary_check", "octet_length(result_summary::text) <= 32768"],
      ["security_audit_events_metadata_check", "octet_length(metadata::text) <= 16384"],
      ["rebuild_checkpoints_payload_check", "octet_length(checkpoint::text) <= 32768"]
    ] as const) {
      expect(bootstrap, payload[0]).toContain(`constraint ${payload[0]} check`);
      expect(bootstrap, payload[0]).toContain(payload[1]);
    }

    expect(bootstrap).toContain("byte_count_nonnegative_check check (byte_count >= 0)");
    expect(bootstrap).toContain("count_nonnegative_check check");
    expect(bootstrap).toContain("offset_range_check check (start_offset >= 0 and end_offset >= start_offset)");
  });

  it("types all live and terminal states with explicit checks", () => {
    for (const constraint of [
      "source_files_status_check",
      "object_registrations_state_check",
      "source_revisions_role_check",
      "search_projections_role_check",
      "search_projections_provider_kind_check",
      "search_projections_provider_operation_check",
      "search_projections_state_check",
      "search_projections_validation_check",
      "meilisearch_projection_maintenance_compaction_check",
      "release_candidates_state_check",
      "operations_state_check",
      "operation_work_items_search_provider_check",
      "operation_work_items_attempt_check",
      "operation_work_items_error_check",
      "cleanup_actions_state_check",
      "cleanup_actions_search_provider_check",
      "cleanup_actions_lease_check",
      "upload_sessions_state_check",
      "upload_entries_state_check",
      "webhook_deliveries_state_check",
      "webhook_deliveries_lease_check",
      "webhook_deliveries_terminal_check",
      "webhook_deliveries_expiry_check",
      "operation_results_state_check",
      "security_audit_events_result_check",
      "deployment_states_phase_check"
    ]) {
      expect(bootstrap, constraint).toContain(`constraint ${constraint} check`);
    }
  });
});
