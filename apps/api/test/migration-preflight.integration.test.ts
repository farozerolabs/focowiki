import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectMigrationWork } from "../src/db/migration-preflight.js";
import {
  applyMigrations,
  MIGRATION_FILES,
  readMigrationSql,
  RUNTIME_SCHEMA_GENERATION
} from "../src/db/migrations.js";

const databaseUrl = process.env.FOCOWIKI_TEST_DATABASE_URL;
const describeDatabase = databaseUrl ? describe : describe.skip;

describeDatabase("migration preflight integration", () => {
  const connectionUrl = databaseUrl ?? "postgres://unused:unused@127.0.0.1:5432/unused";
  const databaseName = `focowiki_preflight_${process.pid}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const legacyDatabaseName = `focowiki_preflight_legacy_${process.pid}_${
    randomUUID().replaceAll("-", "").slice(0, 12)
  }`;
  const admin = postgres(databaseConnectionUrl(connectionUrl, "postgres"), { max: 1 });
  const sql = postgres(databaseConnectionUrl(connectionUrl, databaseName), { max: 3 });
  const legacySql = postgres(databaseConnectionUrl(connectionUrl, legacyDatabaseName), { max: 1 });
  const knowledgeBaseId = "kb-migration-preflight";
  const sourceFileId = "source-file-migration-preflight";
  const revisionId = "source-revision-migration-preflight";
  const generationId = "generation-migration-preflight";

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
    await admin.unsafe(`CREATE DATABASE ${quoteIdentifier(legacyDatabaseName)}`);
    await applyMigrations(sql);
    await legacySql.unsafe(readMigrationSql(MIGRATION_FILES[0]!));
  });

  afterAll(async () => {
    await cleanup();
    await sql.end({ timeout: 5 });
    await legacySql.end({ timeout: 5 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`);
    await admin.unsafe(
      `DROP DATABASE IF EXISTS ${quoteIdentifier(legacyDatabaseName)} WITH (FORCE)`
    );
    await admin.end({ timeout: 5 });
  });

  it("reports every supported unfinished work class without record details", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedAllUnfinishedWork();
    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot).toMatchObject({
      sourceFiles: baseline.sourceFiles + 1,
      dispatchMarkers: baseline.dispatchMarkers + 1,
      roleJobs: baseline.roleJobs + 1,
      publicationImpacts: baseline.publicationImpacts + 1,
      frozenGenerations: baseline.frozenGenerations + 1,
      resourceOperations: baseline.resourceOperations + 1,
      deletionIntents: baseline.deletionIntents + 1,
      uploadSessions: baseline.uploadSessions + 1,
      cleanupObjects: baseline.cleanupObjects + 1
    });
  });

  it("allows a resumable projection repair to survive a compatible migration", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Migration preflight')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version, generation_kind
      ) VALUES (
        ${generationId}, ${knowledgeBaseId}, 'building', 2, 'projection_repair'
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.frozenGenerations).toBe(baseline.frozenGenerations);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 1);
  });

  it("allows a resumable lexical rebuild to survive a compatible migration", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Migration preflight')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version, generation_kind
      ) VALUES (
        ${generationId}, ${knowledgeBaseId}, 'building', 2, 'lexical_rebuild'
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.frozenGenerations).toBe(baseline.frozenGenerations);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 1);
  });

  it("counts an active knowledge-base maintenance request", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedKnowledgeBaseWithActiveGeneration();
    await sql`
      INSERT INTO focowiki.knowledge_base_index_maintenance_requests (
        id, knowledge_base_id, trigger_kind, state, retry_count,
        max_attempts, next_attempt_at
      ) VALUES (
        'maintenance-request-migration-preflight',
        ${knowledgeBaseId}, 'manual', 'queued', 2, 5, now()
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.knowledgeBaseMaintenanceRequests).toBe(
      baseline.knowledgeBaseMaintenanceRequests + 1
    );
    expect(snapshot.total).toBe(baseline.total + 1);
  });

  it("counts active projection repair coordinators and subtasks", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedKnowledgeBaseWithActiveGeneration();
    const repairGenerationId = "generation-migration-preflight-repair-work";
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind
      ) VALUES (
        ${repairGenerationId}, ${knowledgeBaseId}, ${generationId},
        'building', 2, 'projection_repair'
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_projection_repairs (
        knowledge_base_id, repair_version, base_generation_id,
        target_generation_id, state
      ) VALUES (
        ${knowledgeBaseId}, 10, ${generationId},
        ${repairGenerationId}, 'running'
      )
    `;
    await sql`
      INSERT INTO focowiki.projection_repair_subtasks (
        id, knowledge_base_id, repair_version, target_generation_id,
        base_generation_id, task_kind, partition_key, phase_order, state
      ) VALUES (
        'projection-repair-subtask-migration-preflight',
        ${knowledgeBaseId}, 10, ${repairGenerationId}, ${generationId},
        'tree_partition', '00', 1, 'pending'
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.projectionRepairs).toBe(baseline.projectionRepairs + 2);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 3);
  });

  it("counts active lexical rebuild coordinators and work items", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedKnowledgeBaseWithActiveGeneration();
    await seedCompletedSource();
    const lexicalGenerationId = "generation-migration-preflight-lexical-work";
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, predecessor_generation_id, state,
        format_version, generation_kind
      ) VALUES (
        ${lexicalGenerationId}, ${knowledgeBaseId}, ${generationId},
        'building', 2, 'lexical_rebuild'
      )
    `;
    await sql`
      INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
        knowledge_base_id, target_search_schema_version,
        target_tokenizer_contract_version, target_segmentation_version,
        target_content_profile_version,
        target_graph_lexical_projection_version,
        base_generation_id, target_generation_id, state
      ) VALUES (
        ${knowledgeBaseId}, 'search-v1', 'tokenizer-v1', 'segment-v1',
        'content-v1', 'graph-v1', ${generationId},
        ${lexicalGenerationId}, 'running'
      )
    `;
    await sql`
      INSERT INTO focowiki.lexical_rebuild_work_items (
        knowledge_base_id, target_generation_id, source_file_id,
        source_revision_id, logical_path, target_search_schema_version,
        target_tokenizer_contract_version, target_segmentation_version,
        target_content_profile_version,
        target_graph_lexical_projection_version, state
      ) VALUES (
        ${knowledgeBaseId}, ${lexicalGenerationId}, ${sourceFileId},
        ${revisionId}, 'preflight.md', 'search-v1', 'tokenizer-v1',
        'segment-v1', 'content-v1', 'graph-v1', 'pending'
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.lexicalRebuilds).toBe(baseline.lexicalRebuilds + 2);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 3);
  });

  it("counts a retryable failed lexical rebuild as unfinished work", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedKnowledgeBaseWithActiveGeneration();
    await sql`
      INSERT INTO focowiki.knowledge_base_lexical_rebuilds (
        knowledge_base_id, target_search_schema_version,
        target_tokenizer_contract_version, target_segmentation_version,
        target_content_profile_version,
        target_graph_lexical_projection_version,
        base_generation_id, state, attempt_count, max_attempts
      ) VALUES (
        ${knowledgeBaseId}, 'search-v1', 'tokenizer-v1', 'segment-v1',
        'content-v1', 'graph-v1', ${generationId}, 'failed', 2, 5
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.lexicalRebuilds).toBe(baseline.lexicalRebuilds + 1);
    expect(snapshot.total).toBe(baseline.total + 1);
  });

  it("counts pending projection compaction work", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedKnowledgeBaseWithActiveGeneration();
    await sql`
      INSERT INTO focowiki.projection_compaction_jobs (
        id, knowledge_base_id, projection_kind, logical_partition,
        active_generation_id, expected_segment_ids, reason_codes, state
      ) VALUES (
        'projection-compaction-migration-preflight', ${knowledgeBaseId},
        'search', '00', ${generationId}, ARRAY['segment-1'],
        ARRAY['segment_count'], 'pending'
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.projectionCompactions).toBe(
      baseline.projectionCompactions + 1
    );
    expect(snapshot.total).toBe(baseline.total + 1);
  });

  it("does not block migration for an upload session whose lease has expired", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Migration preflight')
    `;
    await sql`
      INSERT INTO focowiki.upload_sessions (
        id, knowledge_base_id, state, idempotency_key,
        declared_file_count, declared_byte_count, expires_at
      ) VALUES (
        'upload-session-expired-preflight', ${knowledgeBaseId}, 'manifest_sealed',
        'expired-preflight', 1, 12, now() - interval '1 hour'
      )
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.uploadSessions).toBe(baseline.uploadSessions);
    expect(snapshot.total).toBe(baseline.total);
  });

  it("runs against the first released schema before later columns exist", async () => {
    await expect(inspectMigrationWork(legacySql)).resolves.toMatchObject({
      total: 0,
      capped: false
    });
  });

  it("excludes recoverable deletion rows while counting active repair work", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedRepairDependentDeletion({
      failureMessage: "DIRECTORY_NAVIGATION_COUNT_MISMATCH:pages/example"
    });

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.roleJobs).toBe(baseline.roleJobs);
    expect(snapshot.resourceOperations).toBe(baseline.resourceOperations);
    expect(snapshot.deletionIntents).toBe(baseline.deletionIntents);
    expect(snapshot.projectionRepairs).toBe(baseline.projectionRepairs + 1);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 2);
  });

  it("blocks a deletion that projection repair cannot recover", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedRepairDependentDeletion({
      failureMessage: "UNRELATED_PUBLICATION_FAILURE"
    });

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.roleJobs).toBe(baseline.roleJobs + 1);
    expect(snapshot.resourceOperations).toBe(baseline.resourceOperations + 1);
    expect(snapshot.deletionIntents).toBe(baseline.deletionIntents + 1);
    expect(snapshot.total).toBe(baseline.total + 5);
  });

  it("excludes recoverable directory deletion rows while counting repair work", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedRepairDependentDeletion({
      failureMessage: "DIRECTORY_STATISTICS_MISMATCH:pages/example",
      targetKind: "source_directory"
    });

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.roleJobs).toBe(baseline.roleJobs);
    expect(snapshot.resourceOperations).toBe(baseline.resourceOperations);
    expect(snapshot.deletionIntents).toBe(baseline.deletionIntents);
    expect(snapshot.projectionRepairs).toBe(baseline.projectionRepairs + 1);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 2);
  });

  it("allows a frozen recoverable deletion publication to survive migration", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedRepairDependentDeletion({
      failureMessage: "DIRECTORY_NAVIGATION_COUNT_MISMATCH:pages/example"
    });
    await freezeDeleteGeneration();

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.roleJobs).toBe(baseline.roleJobs);
    expect(snapshot.frozenGenerations).toBe(baseline.frozenGenerations);
    expect(snapshot.resourceOperations).toBe(baseline.resourceOperations);
    expect(snapshot.deletionIntents).toBe(baseline.deletionIntents);
    expect(snapshot.projectionRepairs).toBe(baseline.projectionRepairs + 1);
    expect(snapshot.maintenanceCandidateGenerations).toBe(
      baseline.maintenanceCandidateGenerations + 1
    );
    expect(snapshot.total).toBe(baseline.total + 2);
  });

  it("blocks a frozen deletion publication without resumable planning data", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedRepairDependentDeletion({
      failureMessage: "DIRECTORY_NAVIGATION_COUNT_MISMATCH:pages/example"
    });
    await freezeDeleteGeneration();
    await sql`
      UPDATE focowiki.publication_change_facts
      SET planning_payload_json = '{}'::jsonb
      WHERE generation_id = 'generation-migration-preflight-failed'
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.roleJobs).toBe(baseline.roleJobs + 1);
    expect(snapshot.frozenGenerations).toBe(baseline.frozenGenerations + 1);
    expect(snapshot.resourceOperations).toBe(baseline.resourceOperations + 1);
    expect(snapshot.deletionIntents).toBe(baseline.deletionIntents + 1);
    expect(snapshot.total).toBe(baseline.total + 6);
  });

  it("preserves non-drained deletion work after compatible migrations", async () => {
    await cleanup();
    await seedRepairDependentDeletion({
      failureMessage: "DIRECTORY_NAVIGATION_COUNT_MISMATCH:pages/example"
    });
    await freezeDeleteGeneration();
    await sql`
      UPDATE focowiki.publication_change_facts
      SET planning_payload_json = '{}'::jsonb
      WHERE generation_id = 'generation-migration-preflight-failed'
    `;
    expect(await inspectMigrationWork(sql)).toMatchObject({
      roleJobs: 1,
      frozenGenerations: 1,
      resourceOperations: 1,
      deletionIntents: 1,
      projectionRepairs: 1,
      maintenanceCandidateGenerations: 1,
      total: 6
    });
    expect((await sql<Array<{ generation: string }>>`
      SELECT generation
      FROM focowiki.runtime_generation
      WHERE singleton = true
    `)[0]?.generation).toBe(RUNTIME_SCHEMA_GENERATION);
    expect(await sql<Array<{
      job_status: string;
      generation_state: string;
      operation_state: string;
      intent_state: string;
    }>>`
      SELECT job.status AS job_status,
             generation.state AS generation_state,
             operation.state AS operation_state,
             intent.state AS intent_state
      FROM focowiki.role_jobs job
      JOIN focowiki.deletion_intents intent
        ON intent.id = job.payload_json->>'deletionIntentId'
      JOIN focowiki.publication_change_facts fact
        ON fact.deletion_intent_id = intent.id
      JOIN focowiki.publication_generations generation
        ON generation.id = fact.generation_id
      JOIN focowiki.resource_operations operation
        ON operation.id = fact.operation_id
      WHERE job.id = 'role-job-migration-preflight-hard-delete'
    `).toEqual([{
      job_status: "queued",
      generation_state: "frozen",
      operation_state: "publishing",
      intent_state: "accepted"
    }]);
    expect(await inspectMigrationWork(sql)).toMatchObject({
      roleJobs: 1,
      frozenGenerations: 1,
      resourceOperations: 1,
      deletionIntents: 1,
      projectionRepairs: 1,
      maintenanceCandidateGenerations: 1,
      total: 6
    });
  });

  it("blocks a deletion whose target was not logically deleted", async () => {
    await cleanup();
    const baseline = await inspectMigrationWork(sql);
    await seedRepairDependentDeletion({
      failureMessage: "DIRECTORY_NAVIGATION_COUNT_MISMATCH:pages/example"
    });
    await sql`
      UPDATE focowiki.source_files
      SET deleted_at = NULL
      WHERE id = ${sourceFileId}
    `;

    const snapshot = await inspectMigrationWork(sql);

    expect(snapshot.roleJobs).toBe(baseline.roleJobs + 1);
    expect(snapshot.resourceOperations).toBe(baseline.resourceOperations + 1);
    expect(snapshot.deletionIntents).toBe(baseline.deletionIntents + 1);
    expect(snapshot.total).toBe(baseline.total + 5);
  });

  async function seedAllUnfinishedWork(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name)
        VALUES (${knowledgeBaseId}, 'Migration preflight')
      `;
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'sources/preflight.md',
          'text/markdown; charset=utf-8', 12, ${"c".repeat(64)},
          'queued', 'upload_storage', 'pending', 'preflight.md',
          'preflight.md', 'preflight.md', ${revisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/preflight.md', 'text/markdown; charset=utf-8', 12,
          ${"c".repeat(64)}, 'queued'
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_dispatch_markers (
          id, knowledge_base_id, source_file_id, source_revision_id, status
        ) VALUES (
          'dispatch-migration-preflight', ${knowledgeBaseId}, ${sourceFileId},
          ${revisionId}, 'pending'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version
        ) VALUES (${generationId}, ${knowledgeBaseId}, 'frozen', 2)
      `;
      await transaction`
        INSERT INTO focowiki.role_jobs (
          id, role, kind, knowledge_base_id, source_file_id,
          source_revision_id, status
        ) VALUES (
          'role-job-migration-preflight', 'source', 'source_processing',
          ${knowledgeBaseId}, ${sourceFileId}, ${revisionId}, 'queued'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_change_facts (
          id, knowledge_base_id, source_file_id, source_revision_id,
          generation_id, kind, resource_revision, path
        ) VALUES (
          'fact-migration-preflight', ${knowledgeBaseId}, ${sourceFileId},
          ${revisionId}, ${generationId}, 'source_created', 1, 'preflight.md'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impacts (
          id, knowledge_base_id, generation_id, projection_kind,
          projection_key, record_identity, action, status
        ) VALUES (
          'impact-migration-preflight', ${knowledgeBaseId}, ${generationId},
          'search', 'search/v2/preflight', ${sourceFileId}, 'upsert', 'pending'
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_impact_causes (impact_id, change_fact_id)
        VALUES ('impact-migration-preflight', 'fact-migration-preflight')
      `;
      await transaction`
        INSERT INTO focowiki.resource_operations (
          id, knowledge_base_id, operation_kind, state, idempotency_key,
          request_fingerprint, candidate_catalog_generation
        ) VALUES (
          'operation-migration-preflight', ${knowledgeBaseId},
          'source_file_move', 'processing', 'migration-preflight',
          ${"d".repeat(64)}, 1
        )
      `;
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id,
          catalog_generation, state
        ) VALUES (
          'deletion-migration-preflight', ${knowledgeBaseId}, 'source_file',
          ${sourceFileId}, 1, 'accepted'
        )
      `;
      await transaction`
        INSERT INTO focowiki.upload_sessions (
          id, knowledge_base_id, state, idempotency_key,
          declared_file_count, declared_byte_count, expires_at
        ) VALUES (
          'upload-session-migration-preflight', ${knowledgeBaseId}, 'draft',
          'migration-preflight', 1, 12, now() + interval '1 hour'
        )
      `;
      await transaction`
        INSERT INTO focowiki.cleanup_object_deletions (
          job_id, knowledge_base_id, object_key, status
        ) VALUES (
          'cleanup-migration-preflight', ${knowledgeBaseId},
          'generated/preflight.json', 'pending'
        )
      `;
    });
  }

  async function seedKnowledgeBaseWithActiveGeneration(): Promise<void> {
    await sql`
      INSERT INTO focowiki.knowledge_bases (id, name)
      VALUES (${knowledgeBaseId}, 'Migration preflight')
    `;
    await sql`
      INSERT INTO focowiki.publication_generations (
        id, knowledge_base_id, state, format_version,
        generation_kind, activated_at
      ) VALUES (
        ${generationId}, ${knowledgeBaseId}, 'active', 2, 'normal', now()
      )
    `;
    await sql`
      UPDATE focowiki.knowledge_bases
      SET active_generation_id = ${generationId}
      WHERE id = ${knowledgeBaseId}
    `;
  }

  async function seedCompletedSource(): Promise<void> {
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.source_files (
          id, knowledge_base_id, object_key, content_type, size_bytes,
          checksum_sha256, processing_status, processing_stage,
          generated_output_status, name, relative_path, path_key,
          active_revision_id
        ) VALUES (
          ${sourceFileId}, ${knowledgeBaseId}, 'sources/preflight.md',
          'text/markdown; charset=utf-8', 12, ${"c".repeat(64)},
          'completed', 'generation_activation', 'visible', 'preflight.md',
          'preflight.md', 'preflight.md', ${revisionId}
        )
      `;
      await transaction`
        INSERT INTO focowiki.source_revisions (
          id, knowledge_base_id, source_file_id, revision, object_key,
          content_type, size_bytes, checksum_sha256, processing_status
        ) VALUES (
          ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
          'sources/preflight.md', 'text/markdown; charset=utf-8', 12,
          ${"c".repeat(64)}, 'completed'
        )
      `;
    });
  }

  async function freezeDeleteGeneration(): Promise<void> {
    await sql`
      UPDATE focowiki.publication_generations
      SET state = 'frozen',
          frozen_at = now(),
          failed_at = NULL,
          safe_error_code = NULL,
          safe_error_message = NULL
      WHERE id = 'generation-migration-preflight-failed'
    `;
  }

  async function seedRepairDependentDeletion(input: {
    failureMessage: string;
    targetKind?: "source_file" | "source_directory";
  }): Promise<void> {
    const baseGenerationId = "generation-migration-preflight-base";
    const failedGenerationId = "generation-migration-preflight-failed";
    const repairGenerationId = "generation-migration-preflight-repair";
    const operationId = "operation-migration-preflight-delete";
    const deletionIntentId = "deletion-migration-preflight-repair";
    const directoryId = "source-directory-migration-preflight";
    const targetKind = input.targetKind ?? "source_file";
    const targetId = targetKind === "source_file" ? sourceFileId : directoryId;
    const operationKind = targetKind === "source_file"
      ? "source_file_delete"
      : "source_directory_delete";
    const changeKind = targetKind === "source_file"
      ? "source_deleted"
      : "directory_deleted";
    await sql.begin(async (transaction) => {
      await transaction`
        INSERT INTO focowiki.knowledge_bases (id, name, resource_revision)
        VALUES (${knowledgeBaseId}, 'Migration preflight', 2)
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, state, format_version, generation_kind,
          activated_at
        ) VALUES (
          ${baseGenerationId}, ${knowledgeBaseId}, 'active', 2, 'normal', now()
        )
      `;
      await transaction`
        UPDATE focowiki.knowledge_bases
        SET active_generation_id = ${baseGenerationId}
        WHERE id = ${knowledgeBaseId}
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          format_version, generation_kind, failed_at,
          safe_error_code, safe_error_message
        ) VALUES (
          ${failedGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
          'failed', 2, 'normal', now(), 'PUBLICATION_RETRIES_EXHAUSTED',
          ${input.failureMessage}
        )
      `;
      await transaction`
        INSERT INTO focowiki.publication_generations (
          id, knowledge_base_id, predecessor_generation_id, state,
          format_version, generation_kind, frozen_at
        ) VALUES (
          ${repairGenerationId}, ${knowledgeBaseId}, ${baseGenerationId},
          'building', 2, 'projection_repair', now()
        )
      `;
      await transaction`
        INSERT INTO focowiki.knowledge_base_projection_repairs (
          knowledge_base_id, repair_version, base_generation_id,
          target_generation_id, state
        ) VALUES (
          ${knowledgeBaseId}, 3, ${baseGenerationId},
          ${repairGenerationId}, 'running'
        )
      `;
      if (targetKind === "source_file") {
        await transaction`
          INSERT INTO focowiki.source_files (
            id, knowledge_base_id, object_key, content_type, size_bytes,
            checksum_sha256, processing_status, processing_stage,
            generated_output_status, name, relative_path, path_key,
            active_revision_id
          ) VALUES (
            ${sourceFileId}, ${knowledgeBaseId}, 'sources/preflight.md',
            'text/markdown; charset=utf-8', 12, ${"c".repeat(64)},
            'completed', 'generation_activation', 'visible', 'preflight.md',
            'preflight.md', 'preflight.md', ${revisionId}
          )
        `;
        await transaction`
          INSERT INTO focowiki.source_revisions (
            id, knowledge_base_id, source_file_id, revision, object_key,
            content_type, size_bytes, checksum_sha256, processing_status
          ) VALUES (
            ${revisionId}, ${knowledgeBaseId}, ${sourceFileId}, 1,
            'sources/preflight.md', 'text/markdown; charset=utf-8', 12,
            ${"c".repeat(64)}, 'completed'
          )
        `;
      } else {
        await transaction`
          INSERT INTO focowiki.source_directories (
            id, knowledge_base_id, name, relative_path, path_key, depth
          ) VALUES (
            ${directoryId}, ${knowledgeBaseId}, 'example',
            'example', 'example', 1
          )
        `;
      }
      await transaction`
        INSERT INTO focowiki.deletion_intents (
          id, knowledge_base_id, target_kind, target_id,
          catalog_generation, state
        ) VALUES (
          ${deletionIntentId}, ${knowledgeBaseId}, ${targetKind},
          ${targetId}, 2, 'accepted'
        )
      `;
      if (targetKind === "source_file") {
        await transaction`
          UPDATE focowiki.source_files
          SET deletion_intent_id = ${deletionIntentId}, deleted_at = now()
          WHERE id = ${sourceFileId}
        `;
      } else {
        await transaction`
          UPDATE focowiki.source_directories
          SET deletion_intent_id = ${deletionIntentId}, deleted_at = now()
          WHERE id = ${directoryId}
        `;
      }
      await transaction`
        INSERT INTO focowiki.resource_operations (
          id, knowledge_base_id, operation_kind, state, idempotency_key,
          request_fingerprint, candidate_catalog_generation
        ) VALUES (
          ${operationId}, ${knowledgeBaseId}, ${operationKind},
          'publishing', 'migration-preflight-delete', ${"d".repeat(64)}, 2
        )
      `;
      await transaction`
        INSERT INTO focowiki.resource_operation_targets (
          operation_id, target_kind, target_id, expected_resource_revision
        ) VALUES (${operationId}, ${targetKind}, ${targetId}, 1)
      `;
      if (targetKind === "source_file") {
        await transaction`
          INSERT INTO focowiki.publication_change_facts (
            id, knowledge_base_id, source_file_id, source_revision_id,
            operation_id, deletion_intent_id, generation_id, kind,
            resource_revision, previous_path, assembly_state,
            planning_payload_json
          ) VALUES (
            'fact-migration-preflight-delete', ${knowledgeBaseId},
            ${sourceFileId}, ${revisionId}, ${operationId}, ${deletionIntentId},
            ${failedGenerationId}, ${changeKind}, 1, 'preflight.md',
            'assembled', '{"preplannedImpacts":[]}'::jsonb
          )
        `;
      } else {
        await transaction`
          INSERT INTO focowiki.publication_change_facts (
            id, knowledge_base_id, operation_id, deletion_intent_id,
            generation_id, kind, resource_revision, previous_path,
            assembly_state, planning_payload_json
          ) VALUES (
            'fact-migration-preflight-delete', ${knowledgeBaseId},
            ${operationId}, ${deletionIntentId}, ${failedGenerationId},
            ${changeKind}, 1, 'example', 'assembled',
            '{"preplannedImpacts":[]}'::jsonb
          )
        `;
      }
      await transaction`
        INSERT INTO focowiki.role_jobs (
          id, role, kind, knowledge_base_id, payload_json, status
        ) VALUES (
          'role-job-migration-preflight-hard-delete', 'maintenance',
          'hard_delete', ${knowledgeBaseId}, ${transaction.json(
            targetKind === "source_file"
              ? {
                  targetKind,
                  sourceFileId,
                  deletionIntentId
                }
              : {
                  targetKind,
                  sourceDirectoryId: directoryId,
                  deletionIntentId
                }
          )},
          'queued'
        )
      `;
    });
  }

  async function cleanup(): Promise<void> {
    await sql`
      DELETE FROM focowiki.cleanup_object_deletions
      WHERE knowledge_base_id = ${knowledgeBaseId}
    `;
    await sql`DELETE FROM focowiki.knowledge_bases WHERE id = ${knowledgeBaseId}`;
  }
});

function databaseConnectionUrl(connectionUrl: string, databaseName: string): string {
  const url = new URL(connectionUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
