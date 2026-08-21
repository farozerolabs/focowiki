import type { DatabaseClient } from "../../db/client.js";
import type { DocumentKnowledgeProjectionManifest } from
  "../application/document-knowledge-projection-manifest.js";
import { applyPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";
import { activateSemanticSourceRevision } from
  "../../semantic/infrastructure/postgres-source-revision-activation.js";
import {
  activateDocumentRelationshipSearchOwners,
  activateDocumentSearchOwners
} from "./postgres-document-search-owner-repository.js";
import { ensurePostgresDocumentCleanupIntent } from
  "./postgres-document-cleanup-intent.js";
import { applyPostgresDocumentRelationActivation } from
  "./postgres-document-relation-activation.js";
import { createPostgresDocumentProjectionFacts } from
  "./postgres-document-projection-facts.js";
import { releasePostgresDocumentPageCandidates } from
  "./postgres-document-page-candidate-release.js";
import { rehomePostgresCurrentDocumentPageCandidates } from
  "./postgres-document-page-candidate-rehome.js";
import { enqueuePostgresReplacedDocumentRevisionPurge } from
  "./postgres-document-revision-purge.js";
import { lockAndAdvanceScopedOwners } from
  "./postgres-scoped-activation-advance.js";

export async function applyPostgresDocumentFixedActivation(input: {
  transaction: DatabaseClient;
  manifest: DocumentKnowledgeProjectionManifest;
  activatedAt: string;
}): Promise<{ previousSourceRevisionPublicId: string | null }> {
  const { transaction: sql, manifest } = input;
  validateManifest(manifest);
  await sql`SET LOCAL lock_timeout = '2s'`;
  await lockAndAdvanceScopedOwners(sql, manifest, input.activatedAt);
  const ownership = await sql<Array<{
    active_source_revision_public_id: string | null;
    semantic_generation_public_id: string | null;
  }>>`
    SELECT active.active_source_revision_public_id,
           job.semantic_generation_public_id
    FROM focowiki.source_file_active_revisions active
    JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = active.knowledge_base_id
     AND job.source_file_public_id = active.source_file_public_id
     AND job.source_revision_public_id
       = active.current_source_revision_public_id
    JOIN focowiki.knowledge_bases knowledge_base
      ON knowledge_base.public_id = active.knowledge_base_id
     AND knowledge_base.deleted_at IS NULL
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = active.knowledge_base_id
     AND source.public_id = active.source_file_public_id
     AND source.deleted_at IS NULL
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = active.knowledge_base_id
     AND revision.source_file_public_id = active.source_file_public_id
     AND revision.public_id = active.current_source_revision_public_id
     AND revision.deleted_at IS NULL
    WHERE active.knowledge_base_id = ${manifest.knowledgeBaseId}
      AND active.source_file_public_id = ${manifest.sourceFilePublicId}
      AND active.current_source_revision_public_id
        = ${manifest.sourceRevisionPublicId}
      AND job.public_id = ${manifest.documentJobPublicId}
      AND job.state = 'processing'
    FOR UPDATE OF active
  `;
  const current = ownership[0];
  if (!current) throw activationError("source_activation_precondition_failed");
  const jobs = await sql<Array<{ operation_public_id: string }>>`
    SELECT operation_public_id
    FROM focowiki.document_processing_jobs
    WHERE public_id = ${manifest.documentJobPublicId}
      AND knowledge_base_id = ${manifest.knowledgeBaseId}
  `;
  if (!jobs[0]) throw activationError("document_job_missing");
  await assertClosureReady(sql, manifest);
  await activatePages(sql, manifest, input.activatedAt);
  if (current.active_source_revision_public_id
    && current.active_source_revision_public_id !== manifest.sourceRevisionPublicId) {
    await rehomePostgresCurrentDocumentPageCandidates({
      transaction: sql,
      knowledgeBaseId: manifest.knowledgeBaseId,
      documentJobPublicId: manifest.documentJobPublicId,
      sourceFilePublicId: manifest.sourceFilePublicId,
      sourceRevisionPublicId: manifest.sourceRevisionPublicId,
      previousSourceRevisionPublicId: current.active_source_revision_public_id,
      activationRevision: manifest.readinessSequence,
      activatedAt: input.activatedAt
    });
  }
  await releasePostgresDocumentPageCandidates({
    transaction: sql,
    knowledgeBaseId: manifest.knowledgeBaseId,
    documentJobPublicId: manifest.documentJobPublicId,
    operationPublicId: jobs[0].operation_public_id,
    retainedCandidatePublicIds: manifest.pageCandidates.map(
      (page) => page.pageCandidatePublicId
    ),
    releasedAt: input.activatedAt
  });
  await applyPostgresDocumentDirectoryNavigation({
    transaction: sql,
    knowledgeBaseId: manifest.knowledgeBaseId,
    activationRevision: manifest.readinessSequence,
    mutations: manifest.navigationMutations,
    activatedAt: input.activatedAt
  });
  await activateSource(sql, manifest, input.activatedAt);
  await createPostgresDocumentProjectionFacts(sql).activateRevision({
    knowledgeBaseId: manifest.knowledgeBaseId,
    sourceFilePublicId: manifest.sourceFilePublicId,
    sourceRevisionPublicId: manifest.sourceRevisionPublicId,
    now: input.activatedAt
  });
  await activateDocumentSearchOwners({
    transaction: sql,
    knowledgeBaseId: manifest.knowledgeBaseId,
    sourceFilePublicId: manifest.sourceFilePublicId,
    sourceRevisionPublicId: manifest.sourceRevisionPublicId,
    activatedAt: input.activatedAt
  });
  await applyPostgresDocumentRelationActivation({
    transaction: sql,
    knowledgeBaseId: manifest.knowledgeBaseId,
    sourceFilePublicId: manifest.sourceFilePublicId,
    sourceRevisionPublicId: manifest.sourceRevisionPublicId,
    readinessSequence: manifest.readinessSequence,
    relationPublicIds: manifest.relationPublicIds,
    activatedAt: input.activatedAt
  });
  await activateDocumentRelationshipSearchOwners({
    transaction: sql,
    knowledgeBaseId: manifest.knowledgeBaseId,
    affectedSourceFilePublicIds: manifest.affectedSourceFilePublicIds,
    providerDocumentIds: manifest.relationshipSearchDocumentPublicIds,
    activatedAt: input.activatedAt
  });
  await activateSearchFamilies(sql, manifest);
  if (current.semantic_generation_public_id) {
    await activateSemanticSourceRevision(sql, {
      knowledgeBaseId: manifest.knowledgeBaseId,
      semanticGenerationPublicId: current.semantic_generation_public_id,
      sourceFilePublicId: manifest.sourceFilePublicId,
      priorSourceRevisionPublicId: current.active_source_revision_public_id,
      currentSourceRevisionPublicId: manifest.sourceRevisionPublicId,
      activatedAt: input.activatedAt
    });
  }
  if (current.active_source_revision_public_id
    && current.active_source_revision_public_id !== manifest.sourceRevisionPublicId) {
    await sql`
      UPDATE focowiki.source_revisions
      SET retired_at = ${input.activatedAt}
      WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
        AND source_file_public_id = ${manifest.sourceFilePublicId}
        AND public_id = ${current.active_source_revision_public_id}
        AND retired_at IS NULL
    `;
  }
  await ensurePostgresDocumentCleanupIntent({
    transaction: sql,
    knowledgeBaseId: manifest.knowledgeBaseId,
    documentJobPublicId: manifest.documentJobPublicId,
    operationPublicId: jobs[0].operation_public_id,
    sourceFilePublicId: manifest.sourceFilePublicId,
    sourceRevisionPublicId: manifest.sourceRevisionPublicId,
    affectedSourceFilePublicIds: manifest.affectedSourceFilePublicIds,
    createdAt: input.activatedAt
  });
  if (current.active_source_revision_public_id
    && current.active_source_revision_public_id !== manifest.sourceRevisionPublicId) {
    await enqueuePostgresReplacedDocumentRevisionPurge({
      transaction: sql,
      knowledgeBaseId: manifest.knowledgeBaseId,
      operationPublicId: jobs[0].operation_public_id,
      documentJobPublicId: manifest.documentJobPublicId,
      sourceRevisionPublicId: current.active_source_revision_public_id,
      createdAt: input.activatedAt
    });
  }
  return {
    previousSourceRevisionPublicId: current.active_source_revision_public_id
  };
}

async function assertClosureReady(
  sql: DatabaseClient,
  manifest: DocumentKnowledgeProjectionManifest
): Promise<void> {
  const rows = await sql<Array<{
    completed_work_count: number | string;
    page_count: number | string;
    family_count: number | string;
    uncovered_scope_count: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.document_artifact_work work
       JOIN focowiki.document_artifact_receipts receipt
         ON receipt.work_public_id = work.public_id
       WHERE work.document_job_public_id = ${manifest.documentJobPublicId}
         AND work.work_kind IN (
           'prepare', 'first_layer', 'content_projection', 'graphrag',
           'relation_reconcile', 'knowledge_projection'
         ) AND work.state = 'completed') AS completed_work_count,
      (SELECT count(*) FROM focowiki.generated_page_candidates candidate
       WHERE candidate.knowledge_base_id = ${manifest.knowledgeBaseId}
         AND candidate.public_id = ANY(${manifest.pageCandidates.map(
           (page) => page.pageCandidatePublicId
         )}::text[])
         AND candidate.source_revision_public_id
           = ${manifest.sourceRevisionPublicId}
         AND candidate.state = 'staged') AS page_count,
      (SELECT count(*) FROM focowiki.search_family_receipts family
       WHERE family.knowledge_base_id = ${manifest.knowledgeBaseId}
         AND family.public_id = ANY(${manifest.searchFamilyPublicIds}::text[])
         AND family.source_revision_public_id = ${manifest.sourceRevisionPublicId}
         AND family.state = 'acknowledged') AS family_count,
      (SELECT count(*)
       FROM jsonb_to_recordset(${sql.json(manifest.dirtyScopes as never)}::jsonb)
         AS desired(kind text, key text)
       LEFT JOIN focowiki.projection_dirty_scopes scope
         ON scope.knowledge_base_id = ${manifest.knowledgeBaseId}
        AND scope.scope_kind = desired.kind AND scope.scope_key = desired.key
       WHERE scope.public_id IS NULL
          OR scope.completed_sequence < ${manifest.readinessSequence})
        AS uncovered_scope_count
  `;
  const row = rows[0];
  if (!row || Number(row.completed_work_count) !== 6
    || Number(row.page_count) !== manifest.pageCandidates.length
    || Number(row.family_count) !== manifest.searchFamilyPublicIds.length
    || Number(row.uncovered_scope_count) !== 0) {
    throw activationError("document_activation_closure_incomplete");
  }
  const requiredFamilies = await sql<Array<{ family: string }>>`
    SELECT DISTINCT family
    FROM focowiki.search_family_receipts
    WHERE public_id = ANY(${manifest.searchFamilyPublicIds}::text[])
    ORDER BY family
  `;
  const actual = new Set(requiredFamilies.map((row) => row.family));
  const expected = [
    "content_metadata",
    "content_segments_vectors",
    "semantic_seed_vectors",
    "relation_evidence",
    "graph_seed"
  ];
  if (actual.size !== expected.length
    || expected.some((family) => !actual.has(family))) {
    throw activationError("document_search_family_closure_incomplete");
  }
}

async function activatePages(
  sql: DatabaseClient,
  manifest: DocumentKnowledgeProjectionManifest,
  activatedAt: string
): Promise<void> {
  if (manifest.pageCandidates.length > 0) {
    const desired = manifest.pageCandidates.map((page) => ({
      public_id: page.pageCandidatePublicId,
      logical_path: page.logicalPath,
      normalized_path: page.normalizedPath,
      entry_kind: page.entryKind,
      source_file_public_id: page.sourceFilePublicId,
      source_revision_public_id: page.sourceRevisionPublicId,
      object_id: page.objectId,
      checksum_sha256: page.checksumSha256,
      byte_count: page.byteCount
    }));
    const activated = await sql<Array<{ public_id: string }>>`
      WITH desired AS (
        SELECT *
        FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb) AS item(
          public_id text, logical_path text, normalized_path text,
          entry_kind text, source_file_public_id text,
          source_revision_public_id text, object_id text,
          checksum_sha256 text, byte_count bigint
        )
      )
      UPDATE focowiki.generated_page_candidates candidate
      SET state = 'active'
      FROM desired
      WHERE candidate.knowledge_base_id = ${manifest.knowledgeBaseId}
        AND candidate.public_id = desired.public_id
        AND candidate.source_revision_public_id = ${manifest.sourceRevisionPublicId}
        AND candidate.object_id = desired.object_id
        AND candidate.checksum_sha256 = desired.checksum_sha256
        AND candidate.state = 'staged'
      RETURNING candidate.public_id
    `;
    if (activated.length !== desired.length) {
      throw activationError("page_candidate_invalid");
    }
    await sql`
      INSERT INTO focowiki.generated_page_heads (
        knowledge_base_id, logical_path, normalized_path, entry_kind,
        source_file_public_id, source_revision_public_id,
        page_candidate_public_id, object_id, checksum_sha256, byte_count,
        activation_revision, updated_at
      )
      SELECT ${manifest.knowledgeBaseId}, item.logical_path,
             item.normalized_path, item.entry_kind, item.source_file_public_id,
             item.source_revision_public_id, item.public_id, item.object_id,
             item.checksum_sha256, item.byte_count,
             ${manifest.readinessSequence}, ${activatedAt}
      FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb) AS item(
        public_id text, logical_path text, normalized_path text,
        entry_kind text, source_file_public_id text,
        source_revision_public_id text, object_id text,
        checksum_sha256 text, byte_count bigint
      )
      ON CONFLICT (knowledge_base_id, normalized_path) DO UPDATE
      SET logical_path = excluded.logical_path,
          entry_kind = excluded.entry_kind,
          source_file_public_id = excluded.source_file_public_id,
          source_revision_public_id = excluded.source_revision_public_id,
          page_candidate_public_id = excluded.page_candidate_public_id,
          object_id = excluded.object_id,
          checksum_sha256 = excluded.checksum_sha256,
          byte_count = excluded.byte_count,
          activation_revision = excluded.activation_revision,
          updated_at = excluded.updated_at
      WHERE generated_page_heads.activation_revision <= excluded.activation_revision
    `;
  }
  if (manifest.removedPageNormalizedPaths.length > 0) {
    await sql`
      DELETE FROM focowiki.generated_page_heads
      WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
        AND normalized_path = ANY(${manifest.removedPageNormalizedPaths}::text[])
        AND activation_revision <= ${manifest.readinessSequence}
    `;
  }
}

async function activateSource(
  sql: DatabaseClient,
  manifest: DocumentKnowledgeProjectionManifest,
  activatedAt: string
): Promise<void> {
  const presentation = await sql<Array<{ source_file_public_id: string }>>`
    UPDATE focowiki.source_revision_presentations
    SET logical_path = ${manifest.presentation.logicalPath},
        normalized_path = ${manifest.presentation.normalizedPath},
        title = ${manifest.presentation.title},
        metadata = ${sql.json(manifest.presentation.metadata as never)},
        model_suggestions = ${manifest.presentation.modelSuggestions === null
          ? null : sql.json(manifest.presentation.modelSuggestions as never)}
    WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
      AND source_file_public_id = ${manifest.sourceFilePublicId}
      AND source_revision_public_id = ${manifest.sourceRevisionPublicId}
    RETURNING source_file_public_id
  `;
  if (presentation.length !== 1) {
    throw activationError("source_presentation_missing");
  }
  await sql`
    UPDATE focowiki.source_files source
    SET directory_public_id = candidate.directory_public_id,
        logical_path = candidate.logical_path,
        normalized_path = candidate.normalized_path,
        title = candidate.title, metadata = candidate.metadata,
        updated_at = ${activatedAt}
    FROM focowiki.source_revision_presentations candidate
    WHERE source.knowledge_base_id = ${manifest.knowledgeBaseId}
      AND source.public_id = ${manifest.sourceFilePublicId}
      AND candidate.knowledge_base_id = source.knowledge_base_id
      AND candidate.source_file_public_id = source.public_id
      AND candidate.source_revision_public_id = ${manifest.sourceRevisionPublicId}
  `;
  await sql`
    UPDATE focowiki.source_file_active_revisions
    SET active_source_revision_public_id = ${manifest.sourceRevisionPublicId},
        activation_sequence = ${manifest.readinessSequence},
        updated_at = ${activatedAt}
    WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
      AND source_file_public_id = ${manifest.sourceFilePublicId}
      AND current_source_revision_public_id = ${manifest.sourceRevisionPublicId}
  `;
  await sql`
    UPDATE focowiki.source_file_identity_keys
    SET state = 'obsolete', activation_revision = ${manifest.readinessSequence},
        updated_at = ${activatedAt}
    WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
      AND source_file_public_id = ${manifest.sourceFilePublicId}
      AND source_revision_public_id <> ${manifest.sourceRevisionPublicId}
      AND state <> 'obsolete'
  `;
  const identities = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.source_file_identity_keys
    SET state = 'active', activation_revision = ${manifest.readinessSequence},
        updated_at = ${activatedAt}
    WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
      AND source_revision_public_id = ${manifest.sourceRevisionPublicId}
      AND state IN ('staged', 'active')
    RETURNING public_id
  `;
  if (identities.length < 1) throw activationError("source_identity_missing");
}

async function activateSearchFamilies(
  sql: DatabaseClient,
  manifest: DocumentKnowledgeProjectionManifest
): Promise<void> {
  await sql`
    UPDATE focowiki.search_family_receipts
    SET active = false
    WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
      AND source_file_public_id = ${manifest.sourceFilePublicId}
      AND source_revision_public_id <> ${manifest.sourceRevisionPublicId}
      AND active
  `;
  const rows = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.search_family_receipts
    SET active = true
    WHERE knowledge_base_id = ${manifest.knowledgeBaseId}
      AND public_id = ANY(${manifest.searchFamilyPublicIds}::text[])
      AND source_revision_public_id = ${manifest.sourceRevisionPublicId}
      AND state = 'acknowledged'
    RETURNING public_id
  `;
  if (rows.length !== manifest.searchFamilyPublicIds.length) {
    throw activationError("search_family_activation_incomplete");
  }
}

function validateManifest(manifest: DocumentKnowledgeProjectionManifest): void {
  if (manifest.schemaVersion !== "document-knowledge-projection-manifest-v1"
    || !Number.isSafeInteger(manifest.readinessSequence)
    || manifest.readinessSequence < 1
    || !Number.isFinite(Date.parse(manifest.projectedAt))
    || manifest.pageCandidates.length > 10_000
    || manifest.activationOwners.length > 30_000
    || manifest.dirtyScopes.length > 10_000
    || manifest.relationshipSearchDocumentPublicIds.length > 20_000
    || manifest.relationshipSearchDocumentPublicIds.some((value) => !value)) {
    throw activationError("document_projection_manifest_invalid");
  }
}

function activationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document fixed activation error: ${code}`), {
    code
  });
}
