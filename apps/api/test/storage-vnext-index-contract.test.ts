import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const bootstrap = readFileSync(
  resolve(import.meta.dirname, "../migrations/001_storage_vnext.sql"),
  "utf8"
).replace(/\s+/gu, " ").toLowerCase();

const INDEX_EVIDENCE = {
  source_directories_active_parent_path_idx: "catalog:listDirectories",
  source_files_active_directory_path_idx: "catalog:listSourceFiles",
  source_files_active_model_invocation_idx: "admin:listSourceFiles by LLM status",
  source_file_current_revisions_revision_idx: "catalog:revision replacement cleanup",
  source_revisions_object_idx: "ownership:object registration inverse",
  source_event_summaries_scope_time_idx: "source-events:list",
  source_event_summaries_expiry_idx: "retention:source event summaries",
  graph_nodes_source_revision_idx: "graph:listBySourceFile and revision cleanup",
  graph_edges_from_node_idx: "graph:forward neighborhood",
  graph_edges_to_node_idx: "graph:reverse neighborhood",
  graph_evidence_refs_node_idx: "graph:node evidence cleanup",
  graph_evidence_refs_edge_idx: "graph:edge evidence cleanup",
  graph_evidence_refs_source_file_idx: "graph:source evidence cleanup",
  release_shards_object_idx: "release:object registration inverse",
  release_root_shards_shard_idx: "release:shared shard inverse",
  release_catalog_entries_source_file_idx: "release:source deletion inverse",
  release_catalog_entries_object_idx: "release:object registration inverse",
  directory_summaries_directory_idx: "release:directory deletion inverse",
  active_snapshots_release_root_idx: "release:active-root owner",
  active_snapshots_search_projection_idx: "search:active projection owner",
  active_snapshots_operation_idx: "workflow:activation operation inverse",
  search_projections_active_role_uniq_idx:
    "search:single active projection cardinality",
  search_projections_live_candidate_uniq_idx:
    "search:single live candidate projection cardinality",
  search_projections_failed_cleanup_idx: "search:list failed candidate cleanup",
  meilisearch_projection_maintenance_compaction_idx:
    "search:Meilisearch optional compaction scheduling",
  release_candidates_operation_idx: "workflow:candidate operation inverse",
  release_candidates_candidate_root_idx: "release:candidate-root owner",
  release_candidates_expected_root_idx: "release:expected-root inverse",
  release_event_summaries_scope_time_idx: "release:listReleaseEvents",
  release_event_summaries_expiry_idx: "release:deleteExpiredReleaseEvents",
  object_owners_source_revision_idx: "ownership:source revision owner",
  object_owners_release_root_idx: "ownership:active/candidate/rollback owner",
  object_owners_release_shard_idx: "ownership:shared shard owner",
  object_owners_operation_idx: "ownership:live reservation owner",
  object_registrations_zero_owner_idx: "ownership:listZeroOwnerObjects",
  object_registrations_stale_reservation_idx: "ownership:listStaleReservations",
  operation_work_items_settings_idx: "settings:referenced revision inverse",
  operation_idempotency_operation_idx: "workflow:operation expiry inverse",
  operation_dependencies_dependency_idx: "workflow:dependency completion inverse",
  operations_live_maintenance_owner_idx: "maintenance:single live knowledge-base owner",
  upload_entries_object_idx: "upload:object registration inverse",
  upload_sessions_expiry_idx: "upload:listExpiredSessions",
  upload_path_reservations_expiry_idx: "upload:reservation expiry cleanup",
  webhook_deliveries_subscription_idx: "webhook:subscription deletion inverse",
  webhook_deliveries_operation_idx: "workflow:webhook operation inverse",
  webhook_deliveries_original_event_idx: "webhook:idempotent event fanout",
  operation_work_items_claim_idx: "workflow:claim",
  operation_work_items_lease_idx: "workflow:lease recovery",
  operation_results_scope_time_idx: "workflow:listResults",
  cleanup_actions_claim_idx: "cleanup:listEligible",
  cleanup_actions_lease_idx: "cleanup:lease recovery",
  webhook_deliveries_claim_idx: "webhook:claim",
  webhook_deliveries_lease_idx: "webhook:lease recovery",
  webhook_deliveries_expiry_idx: "webhook:terminal retention",
  security_audit_events_scope_time_idx: "audit:knowledge-base timeline",
  security_audit_events_type_time_idx: "audit:filtered timeline"
} as const;

const EXPECTED_INDEXES = Object.keys(INDEX_EVIDENCE).sort();

function explicitIndexNames(): string[] {
  return [...bootstrap.matchAll(/create (?:unique )?index ([a-z0-9_]+) on /gu)]
    .map((match) => match[1]!)
    .sort();
}

describe("storage vNext minimal index contract", () => {
  it("creates exactly the reader-backed secondary index allowlist", () => {
    expect(explicitIndexNames()).toEqual(EXPECTED_INDEXES);
    expect(Object.values(INDEX_EVIDENCE).every((reader) => reader.includes(":"))).toBe(true);
  });

  it("matches active path and current revision query shapes", () => {
    expect(bootstrap).toContain(
      "source_directories_active_parent_path_idx on focowiki.source_directories (knowledge_base_id, parent_public_id, normalized_path, public_id) where deleted_at is null"
    );
    expect(bootstrap).toContain(
      "source_files_active_directory_path_idx on focowiki.source_files (knowledge_base_id, directory_public_id, normalized_path, public_id) where deleted_at is null"
    );
    expect(bootstrap).toContain(
      "source_files_active_model_invocation_idx on focowiki.source_files (knowledge_base_id, model_invocation_status, logical_path, public_id) where deleted_at is null"
    );
    expect(bootstrap).toContain(
      "source_file_current_revisions_revision_idx on focowiki.source_file_current_revisions (knowledge_base_id, source_revision_public_id, source_file_public_id)"
    );
  });

  it("matches bounded graph traversal and typed owner cleanup shapes", () => {
    for (const fragment of [
      "graph_edges_from_node_idx on focowiki.graph_edges (knowledge_base_id, from_node_public_id, weight desc, public_id)",
      "graph_edges_to_node_idx on focowiki.graph_edges (knowledge_base_id, to_node_public_id, weight desc, public_id)",
      "object_owners_source_revision_idx on focowiki.object_owners (knowledge_base_id, source_revision_public_id, object_id) where source_revision_public_id is not null",
      "object_owners_release_root_idx on focowiki.object_owners (knowledge_base_id, release_root_public_id, object_id) where release_root_public_id is not null",
      "object_registrations_zero_owner_idx on focowiki.object_registrations (zero_owner_since, object_id) where state = 'verified' and zero_owner_since is not null",
      "object_registrations_stale_reservation_idx on focowiki.object_registrations (created_at, object_id) where state = 'reserved'"
    ]) {
      expect(bootstrap, fragment).toContain(fragment);
    }
  });

  it("uses literal partial predicates for claim and lease recovery", () => {
    for (const fragment of [
      "search_projections_failed_cleanup_idx on focowiki.search_projections (provider_kind, updated_at, public_id) where projection_role = 'candidate' and state = 'failed'",
      "operation_work_items_claim_idx on focowiki.operation_work_items (work_kind, next_attempt_at, updated_at, operation_public_id) where state in ('queued', 'retry')",
      "operation_work_items_lease_idx on focowiki.operation_work_items (lease_expires_at, operation_public_id) where state = 'running'",
      "operation_results_scope_time_idx on focowiki.operation_results (knowledge_base_id, completed_at desc, public_id desc)",
      "cleanup_actions_claim_idx on focowiki.cleanup_actions (not_before, sequence_number, updated_at, public_id) where state in ('queued', 'retry')",
      "cleanup_actions_lease_idx on focowiki.cleanup_actions (lease_expires_at, public_id) where state = 'running'",
      "webhook_deliveries_claim_idx on focowiki.webhook_deliveries (next_attempt_at, updated_at, public_id) where state in ('queued', 'retry')",
      "webhook_deliveries_lease_idx on focowiki.webhook_deliveries (lease_expires_at, public_id) where state = 'running'",
      "webhook_deliveries_expiry_idx on focowiki.webhook_deliveries (expires_at, public_id) where state in ('completed', 'failed')"
    ]) {
      expect(bootstrap, fragment).toContain(fragment);
    }
  });

  it("contains no speculative full-text, trigram, JSON, or duplicate constraint index", () => {
    expect(bootstrap).not.toMatch(/using\s+(gin|gist|brin|hash)/u);
    expect(bootstrap).not.toContain("gin_trgm_ops");
    expect(bootstrap).not.toContain("jsonb_path_ops");
    expect(explicitIndexNames().some((name) => /_(pkey|key)$/u.test(name))).toBe(false);
  });
});
