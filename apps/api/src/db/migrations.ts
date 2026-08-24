import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { DatabaseClient } from "./client.js";
import {
  MIGRATION_MANIFEST,
  UnsupportedMigrationGenerationError,
  createBootstrapPlan,
  validateMigrationManifest,
  type MigrationFile
} from "./migration-manifest.js";

export const MIGRATION_FILES = MIGRATION_MANIFEST.map(
  (migration) => migration.fileName
) as readonly MigrationFile[];
export const RUNTIME_SCHEMA_GENERATION =
  MIGRATION_MANIFEST.at(-1)!.targetGeneration;

export class RuntimeSchemaGenerationError extends Error {
  public constructor(public readonly foundGeneration: string | null) {
    super("Database schema is incompatible with this Focowiki release. Perform a clean reset of the Focowiki PostgreSQL database before starting services.");
    this.name = "RuntimeSchemaGenerationError";
  }
}

export class RuntimeSchemaSignatureError extends Error {
  public constructor() {
    super("Database schema is incompatible with this Focowiki release. Perform a clean reset of the Focowiki PostgreSQL database before starting services.");
    this.name = "RuntimeSchemaSignatureError";
  }
}

export type MigrationPreflightResult = {
  currentGeneration: string | "absent";
  pendingFiles: MigrationFile[];
};

export function readMigrationSql(fileName: MigrationFile): string {
  for (const migrationUrl of [
    new URL(`./migrations/${fileName}`, import.meta.url),
    new URL(`../../migrations/${fileName}`, import.meta.url)
  ]) {
    const migrationPath = fileURLToPath(migrationUrl);

    if (existsSync(migrationPath)) {
      return readFileSync(migrationPath, "utf8");
    }
  }

  throw new Error(`Migration file not found: ${fileName}`);
}

export async function applyMigrations(sql: DatabaseClient): Promise<void> {
  const plan = await preflightMigrations(sql);

  if (plan.pendingFiles.length > 0) {
    await sql.begin(async (transaction) => {
      for (const fileName of plan.pendingFiles) {
        await transaction.unsafe(readMigrationSql(fileName));
      }
    });
  }

  await assertRuntimeSchemaGeneration(sql);
}

export async function preflightMigrations(
  sql: DatabaseClient
): Promise<MigrationPreflightResult> {
  const state = await inspectRuntimeSchemaGeneration(sql);
  if (state !== "absent" && typeof state !== "string") {
    throw new RuntimeSchemaGenerationError(state);
  }
  let plan;
  try {
    plan = createBootstrapPlan(state);
  } catch (error) {
    if (error instanceof UnsupportedMigrationGenerationError) {
      throw new RuntimeSchemaGenerationError(state);
    }
    throw error;
  }
  if (state !== "absent") {
    if (plan.pendingFiles.length === 0) {
      await assertDocumentIndexingSchemaSignature(sql);
    } else {
      await assertDocumentIndexingUpgradeSourceSignature(sql);
    }
  }

  return {
    currentGeneration: state,
    pendingFiles: plan.pendingFiles
  };
}

async function assertDocumentIndexingUpgradeSourceSignature(
  sql: DatabaseClient
): Promise<void> {
  const rows = await sql<Array<{ upgrade_source_compatible: boolean }>>`
    SELECT (
      to_regclass('focowiki.document_processing_jobs') IS NOT NULL
      AND to_regclass('focowiki.document_artifact_work') IS NOT NULL
      AND to_regclass('focowiki.document_artifact_receipts') IS NOT NULL
      AND to_regclass('focowiki.document_artifact_work_claim_idx') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns actual
        WHERE actual.table_schema = 'focowiki'
          AND actual.table_name = 'document_artifact_work'
          AND actual.column_name = 'work_kind'
      )
      AND EXISTS (
        SELECT 1
        FROM information_schema.columns actual
        WHERE actual.table_schema = 'focowiki'
          AND actual.table_name = 'document_artifact_receipts'
          AND actual.column_name = 'work_public_id'
      )
    ) AS upgrade_source_compatible
  `;
  if (rows[0]?.upgrade_source_compatible !== true) {
    throw new RuntimeSchemaSignatureError();
  }
}

export async function assertRuntimeSchemaGeneration(sql: DatabaseClient): Promise<void> {
  const state = await inspectRuntimeSchemaGeneration(sql);

  if (state !== RUNTIME_SCHEMA_GENERATION) {
    throw new RuntimeSchemaGenerationError(state === "absent" ? null : state);
  }
  await assertDocumentIndexingSchemaSignature(sql);
}

async function assertDocumentIndexingSchemaSignature(
  sql: DatabaseClient
): Promise<void> {
  const rows = await sql<Array<{ runtime_schema_compatible: boolean }>>`
    SELECT (
      to_regclass('focowiki.candidate_identity_cards') IS NULL
      AND
      NOT EXISTS (
        SELECT required.name
        FROM unnest(ARRAY[
          'document_processing_jobs',
          'source_revision_presentations',
          'document_artifact_work',
          'document_artifact_receipts',
          'document_graphrag_chunks',
          'relation_candidate_pairs',
          'relation_directed_evidence',
          'canonical_file_relations',
          'search_family_receipts',
          'generated_page_bases',
          'document_projection_waiting_completions',
          'knowledge_base_sequences',
          'generated_page_heads',
          'source_file_identity_keys',
          'unresolved_file_references',
          'relationship_evaluations',
          'document_model_analysis_results',
          'document_model_layer_executions',
          'search_document_owners',
          'upload_operation_summaries',
          'operation_tombstones',
          'projection_cleanup_outbox',
          'projection_fact_epochs',
          'knowledge_base_projection_heads',
          'projection_publication_generations',
          'projection_generation_documents',
          'projection_activation_owner_reservations',
          'projection_artifact_owners',
          'projection_directory_owners',
          'projection_scope_generations',
          'projection_scope_generation_dependencies',
          'projection_scope_snapshot_members',
          'projection_scope_generation_pages',
          'projection_generation_directory_claims',
          'projection_scope_navigation_mutations',
          'projection_scope_generation_object_refs',
          'projection_generation_validation_results',
          'projection_invariant_diagnostics',
          'projection_cutover_states',
          'projection_shadow_parity_results',
          'projection_generation_retention'
          ,'projection_generation_graph_degrees'
          ,'projection_legacy_cleanup_state'
        ]) AS required(name)
        WHERE to_regclass('focowiki.' || required.name) IS NULL
      )
      AND NOT EXISTS (
        SELECT required.table_name, required.column_name
        FROM (VALUES
          ('document_processing_jobs', 'source_revision_public_id'),
          ('document_processing_jobs', 'state'),
          ('document_processing_jobs', 'processing_generation'),
          ('document_processing_jobs', 'required_work_count'),
          ('document_processing_jobs', 'completed_work_count'),
          ('document_processing_jobs', 'active_work_kinds'),
          ('document_processing_jobs', 'blocking_work_kind'),
          ('document_processing_jobs', 'total_attempt_count'),
          ('document_processing_jobs', 'manual_retry_count'),
          ('document_processing_jobs', 'runtime_settings_revision_public_id'),
          ('document_processing_jobs', 'generation_model_configuration_public_id'),
          ('document_processing_jobs', 'embedding_configuration_revision_public_id'),
          ('document_processing_jobs', 'safe_error_code'),
          ('source_revision_presentations', 'source_revision_public_id'),
          ('source_revision_presentations', 'normalized_path'),
          ('source_revision_presentations', 'metadata'),
          ('document_artifact_work', 'work_kind'),
          ('document_artifact_work', 'resource_lane'),
          ('document_artifact_work', 'input_fingerprint_sha256'),
          ('document_artifact_work', 'lease_expires_at'),
          ('document_artifact_receipts', 'receipt_kind'),
          ('document_artifact_receipts', 'receipt_key'),
          ('document_artifact_receipts', 'output_fingerprint_sha256'),
          ('relation_candidate_pairs', 'evidence_fingerprint_sha256'),
          ('search_family_receipts', 'family'),
          ('knowledge_base_sequences', 'current_sequence'),
          ('generated_page_candidates', 'owner_operation_public_id'),
          ('generated_page_heads', 'logical_path'),
          ('generated_page_heads', 'object_id'),
          ('generated_page_heads', 'activation_revision'),
          ('source_file_identity_keys', 'source_revision_public_id'),
          ('source_file_identity_keys', 'normalized_identity_key'),
          ('unresolved_file_references', 'source_revision_public_id'),
          ('unresolved_file_references', 'normalized_target_key'),
          ('relationship_evaluations', 'evidence_fingerprint_sha256'),
          ('document_model_analysis_results', 'model_input_sha256'),
          ('document_model_layer_executions', 'execution_identity_sha256'),
          ('document_model_layer_executions', 'provider_request_count')
          ,('document_model_layer_executions', 'provider_observations')
          ,('operation_tombstones', 'expires_at')
          ,('operation_tombstones', 'result_summary')
          ,('webhook_subscriptions', 'idempotency_key')
          ,('webhook_subscriptions', 'request_hash')
          ,('upload_operation_summaries', 'session_public_id')
          ,('upload_operation_summaries', 'received_entry_count')
          ,('upload_operation_summaries', 'expires_at')
          ,('knowledge_base_projection_heads', 'active_generation_public_id')
          ,('projection_publication_generations', 'target_fact_epoch')
          ,('projection_artifact_owners', 'ownership_epoch')
          ,('projection_scope_generations', 'lease_generation')
          ,('projection_scope_generations', 'validation_evidence')
          ,('projection_scope_generations', 'next_eligible_at')
          ,('projection_scope_generations', 'resource_failure_started_at')
          ,('projection_scope_generations', 'resource_failure_count')
          ,('projection_scope_generation_pages', 'normalized_path')
          ,('projection_scope_generation_pages', 'logical_path')
          ,('projection_scope_generation_pages', 'publication_generation_public_id')
          ,('projection_scope_generation_pages', 'owner_scope_identity')
          ,('projection_scope_navigation_mutations', 'publication_generation_public_id')
          ,('projection_scope_navigation_mutations', 'owner_scope_identity')
          ,('generated_page_heads', 'projection_generation_public_id')
          ,('projection_cleanup_outbox', 'write_attempt_public_id')
        ) AS required(table_name, column_name)
        WHERE NOT EXISTS (
          SELECT 1 FROM information_schema.columns actual
          WHERE actual.table_schema = 'focowiki'
            AND actual.table_name = required.table_name
            AND actual.column_name = required.column_name
        )
      )
      AND NOT EXISTS (
        SELECT required.name
        FROM unnest(ARRAY[
          'document_processing_jobs_current_idx',
          'document_processing_jobs_retry_idx',
          'document_processing_jobs_source_list_idx',
          'document_processing_jobs_knowledge_base_list_idx',
          'document_processing_jobs_operation_list_idx',
          'document_processing_jobs_generation_reset_idx',
          'document_processing_jobs_retention_idx',
          'document_artifact_work_claim_idx',
          'document_artifact_work_lease_idx',
          'document_artifact_work_job_idx',
          'document_artifact_receipts_source_revision_idx',
          'document_artifact_receipts_work_idx',
          'relation_candidate_pairs_claim_idx',
          'search_family_receipts_flush_idx',
          'document_projection_waiting_ready_idx',
          'source_file_active_revisions_current_idx',
          'source_file_active_revisions_active_idx',
          'source_revision_presentations_current_path_idx',
          'generated_page_heads_path_idx',
          'source_file_identity_keys_active_lookup_idx',
          'source_file_identity_keys_source_revision_idx',
          'unresolved_file_references_reverse_idx',
          'unresolved_file_references_source_idx',
          'unresolved_file_references_resolved_target_idx',
          'relationship_evaluations_source_idx',
          'document_model_analysis_results_source_idx',
          'document_model_layer_executions_job_idx',
          'semantic_vector_documents_source_revision_idx',
          'search_document_owners_source_revision_idx',
          'search_document_owners_active_idx',
          'search_projections_one_active_idx',
          'cleanup_actions_claim_idx',
          'cleanup_actions_obsolete_artifact_idx',
          'upload_operation_summaries_expiry_idx',
          'operation_tombstones_expiry_idx',
          'operation_tombstones_scope_time_idx',
          'webhook_subscriptions_public_idempotency_key'
          ,'projection_cleanup_outbox_claim_idx'
          ,'projection_cleanup_outbox_expired_lease_idx'
          ,'projection_publication_generations_one_candidate_idx'
          ,'projection_activation_owner_reservations_lock_idx'
          ,'projection_artifact_owners_scope_idx'
          ,'projection_directory_owners_scope_idx'
          ,'projection_scope_generations_claim_idx'
          ,'projection_scope_generations_expired_idx'
          ,'projection_scope_generation_dependencies_reverse_idx'
          ,'projection_scope_generation_pages_path_idx'
          ,'projection_scope_generation_object_refs_object_idx'
          ,'projection_invariant_diagnostics_open_idx'
          ,'projection_generation_graph_degrees_directory_idx'
          ,'document_projection_records_revision_visibility_idx'
          ,'document_semantic_memberships_directory_revision_idx'
          ,'canonical_file_relations_first_revision_visible_idx'
          ,'canonical_file_relations_second_revision_visible_idx'
          ,'canonical_file_relations_first_file_history_idx'
          ,'canonical_file_relations_second_file_history_idx'
          ,'relation_directed_evidence_pair_visible_idx'
        ]) AS required(name)
        WHERE NOT EXISTS (
          SELECT 1 FROM pg_indexes actual
          WHERE actual.schemaname = 'focowiki'
            AND actual.indexname = required.name
        )
      )
      AND NOT EXISTS (
        SELECT required.name
        FROM unnest(ARRAY[
          'document_processing_jobs_source_revision_key',
          'document_processing_jobs_state_check',
          'document_artifact_work_identity_key',
          'document_artifact_work_kind_check',
          'document_artifact_receipts_identity_key',
          'relation_candidate_pairs_identity_key',
          'search_family_receipts_identity_key',
          'generated_page_candidates_owner_check',
          'generated_page_candidates_operation_path_key',
          'generated_page_heads_path_key',
          'source_file_identity_keys_identity_key',
          'unresolved_file_references_identity_key',
          'relationship_evaluations_identity_key',
          'document_model_analysis_results_identity_key',
          'document_model_layer_executions_identity_key',
          'search_projections_value_check',
          'search_document_owners_value_check'
          ,'upload_operation_summaries_count_check'
        ]) AS required(name)
        WHERE NOT EXISTS (
          SELECT 1
          FROM pg_constraint actual
          JOIN pg_class relation ON relation.oid = actual.conrelid
          JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
          WHERE namespace.nspname = 'focowiki'
            AND actual.conname = required.name
        )
      )
      AND NOT EXISTS (
        SELECT removed.name
        FROM unnest(ARRAY[
          'processing_stage_work_items',
          'processing_stage_dependencies',
          'processing_stage_fairness',
          'processing_source_summaries',
          'processing_operation_summaries',
          'release_candidates',
          'release_candidate_changed_facts',
          'release_candidate_dependencies',
          'release_candidate_graph_edges',
          'release_candidate_graph_evidence',
          'release_candidate_graph_nodes',
          'release_candidate_validations',
          'release_roots',
          'release_root_shards',
          'release_shards',
          'release_catalog_entries',
          'release_catalog_tombstones',
          'release_event_summaries'
          ,'knowledge_base_activation_revisions'
          ,'knowledge_base_activation_changes'
          ,'source_artifact_bundles'
          ,'document_revision_artifacts'
          ,'file_relations'
          ,'file_relation_evidence'
        ]) AS removed(name)
        WHERE to_regclass('focowiki.' || removed.name) IS NOT NULL
      )
      AND NOT EXISTS (
        SELECT 1
        FROM information_schema.columns removed_column
        WHERE removed_column.table_schema = 'focowiki'
          AND (
            (removed_column.table_name = 'document_processing_jobs'
              AND removed_column.column_name IN ('phase', 'checkpoint', 'lease_owner', 'lease_expires_at'))
            OR removed_column.column_name = 'source_artifact_bundle_public_id'
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.runtime_setting_current current_setting
        JOIN focowiki.runtime_setting_revisions setting_revision
          ON setting_revision.public_id = current_setting.revision_public_id
        WHERE setting_revision.settings_values->'sections' ? 'publication'
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.operation_work_items work_item
        WHERE work_item.work_kind IN ('source', 'graph', 'publication')
          OR work_item.checkpoint ?| ARRAY[
            'stageKind',
            'stagePublicId',
            'publicationCandidatePublicId',
            'releaseRootPublicId',
            'successorOperationPublicId'
          ]
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.cleanup_actions cleanup
        WHERE cleanup.checkpoint ?| ARRAY[
          'stageKind',
          'stagePublicId',
          'publicationCandidatePublicId',
          'releaseRootPublicId',
          'successorOperationPublicId'
        ]
      )
    ) AS runtime_schema_compatible
  `;
  if (rows[0]?.runtime_schema_compatible !== true) {
    throw new RuntimeSchemaSignatureError();
  }
}

async function inspectRuntimeSchemaGeneration(
  sql: DatabaseClient
): Promise<string | "absent" | null> {
  const schemaRows = await sql<Array<{ schema_exists: boolean }>>`
    SELECT to_regnamespace('focowiki') IS NOT NULL AS schema_exists
  `;

  if (!schemaRows[0]?.schema_exists) {
    return "absent";
  }

  const markerRows = await sql<Array<{ marker_exists: boolean }>>`
    SELECT to_regclass('focowiki.runtime_generation') IS NOT NULL AS marker_exists
  `;

  if (!markerRows[0]?.marker_exists) {
    return null;
  }

  const generationRows = await sql<Array<{ generation: string }>>`
    SELECT generation
    FROM focowiki.runtime_generation
    WHERE singleton = true
    LIMIT 1
  `;

  return generationRows[0]?.generation ?? null;
}

validateMigrationManifest(MIGRATION_MANIFEST, {
  fileExists: (fileName) => [
    new URL(`./migrations/${fileName}`, import.meta.url),
    new URL(`../../migrations/${fileName}`, import.meta.url)
  ].some((migrationUrl) => existsSync(fileURLToPath(migrationUrl)))
});
