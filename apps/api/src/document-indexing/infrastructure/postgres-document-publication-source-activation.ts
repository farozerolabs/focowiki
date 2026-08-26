import type { DatabaseClient } from "../../db/client.js";
import { activateSemanticSourceRevision } from
  "../../semantic/infrastructure/postgres-source-revision-activation.js";
import { applyPostgresDocumentRelationActivation } from
  "./postgres-document-relation-activation.js";
import { ensurePostgresDocumentCleanupIntent } from
  "./postgres-document-cleanup-intent.js";
import { enqueuePostgresReplacedDocumentRevisionPurge } from
  "./postgres-document-revision-purge.js";
import {
  activateDocumentRelationshipSearchOwners,
  activateDocumentSearchOwners
} from "./postgres-document-search-owner-repository.js";

export type PublicationDocument = {
  mutation_public_id: string;
  document_job_public_id: string | null;
  operation_public_id: string | null;
  source_file_public_id: string;
  source_revision_public_id: string;
  fact_kind: "create" | "replace" | "move" | "rename" | "delete" | "repair";
  prior_source_revision_public_id: string | null;
  semantic_generation_public_id: string | null;
};

export async function activatePostgresDocumentPublicationSources(input: {
  transaction: DatabaseClient;
  jobPublicId: string;
  knowledgeBaseId: string;
  targetReadinessSequence: number;
  activatedAt: string;
}): Promise<readonly PublicationDocument[]> {
  const sql = input.transaction;
  const documents = await sql<PublicationDocument[]>`
    SELECT item.mutation_public_id, item.document_job_public_id,
           job.operation_public_id, item.source_file_public_id,
           item.source_revision_public_id, item.operation AS fact_kind,
           active.active_source_revision_public_id
             AS prior_source_revision_public_id,
           job.semantic_generation_public_id
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    LEFT JOIN focowiki.document_processing_jobs job
      ON job.public_id = item.document_job_public_id
    JOIN focowiki.source_file_active_revisions active
      ON active.knowledge_base_id = ${input.knowledgeBaseId}
     AND active.source_file_public_id = item.source_file_public_id
    WHERE membership.job_public_id = ${input.jobPublicId}
      AND (item.operation = 'delete'
        OR (job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.source_file_public_id = item.source_file_public_id
          AND job.source_revision_public_id = item.source_revision_public_id
          AND active.current_source_revision_public_id
                = item.source_revision_public_id
          AND (job.state = 'processing'
            OR (job.state = 'available'
              AND active.active_source_revision_public_id
                    = item.source_revision_public_id))))
    ORDER BY membership.membership_order
    FOR UPDATE OF active
  `;
  const expected = await sql<Array<{ count: number | string }>>`
    SELECT count(*) AS count
    FROM focowiki.publication_job_items
    WHERE job_public_id = ${input.jobPublicId}
  `;
  if (documents.length !== Number(expected[0]?.count ?? -1)) {
    throw activationError("publication_source_precondition_failed");
  }
  const relationshipSearchActivation =
    await readDocumentRelationshipSearchActivation({
      transaction: sql,
      knowledgeBaseId: input.knowledgeBaseId,
      documents
    });
  const live = documents.filter((document) => document.fact_kind !== "delete");
  const deleted = documents.filter((document) => document.fact_kind === "delete");
  if (live.length > 0) {
    await sql`
      UPDATE focowiki.source_files source
      SET directory_public_id = presentation.directory_public_id,
          logical_path = presentation.logical_path,
          normalized_path = presentation.normalized_path,
          title = presentation.title, metadata = presentation.metadata,
          updated_at = ${input.activatedAt}
      FROM focowiki.source_revision_presentations presentation,
           jsonb_to_recordset(${sql.json(live as never)}::jsonb) desired(
             source_file_public_id text, source_revision_public_id text
           )
      WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
        AND source.public_id = desired.source_file_public_id
        AND presentation.knowledge_base_id = source.knowledge_base_id
        AND presentation.source_file_public_id = source.public_id
        AND presentation.source_revision_public_id
              = desired.source_revision_public_id
    `;
    await sql`
      UPDATE focowiki.source_file_active_revisions active
      SET active_source_revision_public_id = desired.source_revision_public_id,
          activation_sequence = ${input.targetReadinessSequence},
          updated_at = ${input.activatedAt}
      FROM jsonb_to_recordset(${sql.json(live as never)}::jsonb) desired(
        source_file_public_id text, source_revision_public_id text
      )
      WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
        AND active.source_file_public_id = desired.source_file_public_id
        AND active.current_source_revision_public_id
              = desired.source_revision_public_id
    `;
  }
  if (deleted.length > 0) {
    await sql`
      UPDATE focowiki.source_file_active_revisions active
      SET active_source_revision_public_id = NULL,
          activation_sequence = ${input.targetReadinessSequence},
          updated_at = ${input.activatedAt}
      FROM jsonb_to_recordset(${sql.json(deleted as never)}::jsonb) desired(
        source_file_public_id text
      )
      WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
        AND active.source_file_public_id = desired.source_file_public_id
    `;
  }
  await activateProjectionRecords(sql, input, documents);
  await activateIdentityKeys(sql, input, documents);
  await activateSearchFamilies(sql, input, documents);
  for (const document of documents) {
    if (document.fact_kind !== "delete") {
      await activateDocumentSearchOwners({
        transaction: sql,
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFilePublicId: document.source_file_public_id,
        sourceRevisionPublicId: document.source_revision_public_id,
        activatedAt: input.activatedAt
      });
    }
    await applyPostgresDocumentRelationActivation({
      transaction: sql,
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: document.source_file_public_id,
      sourceRevisionPublicId: document.source_revision_public_id,
      readinessSequence: input.targetReadinessSequence,
      relationPublicIds: [],
      activatedAt: input.activatedAt
    });
    if (document.fact_kind === "delete") {
      await sql`
        UPDATE focowiki.semantic_vector_documents
        SET state = 'deleted', deleted_at = ${input.activatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${document.source_file_public_id}
          AND state <> 'deleted'
      `;
    } else if (document.prior_source_revision_public_id
      !== document.source_revision_public_id) {
      if (!document.semantic_generation_public_id) {
        throw activationError("publication_semantic_generation_missing");
      }
      await activateSemanticSourceRevision(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        semanticGenerationPublicId: document.semantic_generation_public_id,
        sourceFilePublicId: document.source_file_public_id,
        priorSourceRevisionPublicId:
          document.prior_source_revision_public_id,
        currentSourceRevisionPublicId: document.source_revision_public_id,
        activatedAt: input.activatedAt
      });
    }
  }
  await activateDocumentRelationshipSearchOwners({
    transaction: sql,
    knowledgeBaseId: input.knowledgeBaseId,
    ...relationshipSearchActivation,
    activatedAt: input.activatedAt
  });
  const affected = relationshipSearchActivation.affectedSourceFilePublicIds;
  for (const document of documents) {
    if (document.fact_kind === "delete") continue;
    if (document.prior_source_revision_public_id
      && document.prior_source_revision_public_id
        !== document.source_revision_public_id) {
      await sql`
        UPDATE focowiki.source_revisions
        SET retired_at = ${input.activatedAt}
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${document.source_file_public_id}
          AND public_id = ${document.prior_source_revision_public_id}
          AND retired_at IS NULL
      `;
      await enqueuePostgresReplacedDocumentRevisionPurge({
        transaction: sql,
        knowledgeBaseId: input.knowledgeBaseId,
        operationPublicId: requireLiveIdentity(
          document.operation_public_id, "operation_public_id"),
        documentJobPublicId: requireLiveIdentity(
          document.document_job_public_id, "document_job_public_id"),
        sourceRevisionPublicId: document.prior_source_revision_public_id,
        createdAt: input.activatedAt
      });
    }
    await ensurePostgresDocumentCleanupIntent({
      transaction: sql,
      knowledgeBaseId: input.knowledgeBaseId,
      operationPublicId: requireLiveIdentity(
        document.operation_public_id, "operation_public_id"),
      documentJobPublicId: requireLiveIdentity(
        document.document_job_public_id, "document_job_public_id"),
      sourceFilePublicId: document.source_file_public_id,
      sourceRevisionPublicId: document.source_revision_public_id,
      affectedSourceFilePublicIds: affected,
      createdAt: input.activatedAt
    });
  }
  return documents;
}

export async function readDocumentRelationshipSearchActivation(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  documents: readonly Pick<PublicationDocument,
    "source_file_public_id" | "source_revision_public_id">[];
}): Promise<Readonly<{
  affectedSourceFilePublicIds: readonly string[];
  providerDocumentIds: readonly string[];
}>> {
  const sql = input.transaction;
  const sourceFilePublicIds = [...new Set(input.documents.map(
    (document) => document.source_file_public_id
  ))];
  const sourceRevisionPublicIds = [...new Set(input.documents.map(
    (document) => document.source_revision_public_id
  ))];
  if (sourceFilePublicIds.length === 0) {
    return { affectedSourceFilePublicIds: [], providerDocumentIds: [] };
  }
  const receiptRows = await sql<Array<{ provider_document_id: string }>>`
    SELECT DISTINCT provider_document_id COLLATE "C" AS provider_document_id
    FROM focowiki.search_family_receipts receipt
    CROSS JOIN LATERAL unnest(receipt.provider_document_ids)
      provider(provider_document_id)
    WHERE receipt.knowledge_base_id = ${input.knowledgeBaseId}
      AND receipt.source_revision_public_id IN ${sql(sourceRevisionPublicIds)}
      AND receipt.family = 'relation_evidence'
      AND receipt.state = 'acknowledged'
    ORDER BY provider_document_id COLLATE "C"
  `;
  const providerDocumentIds = receiptRows.map((row) =>
    row.provider_document_id);
  const ownerRows = providerDocumentIds.length === 0 ? []
    : await sql<Array<{ source_file_public_id: string }>>`
      SELECT DISTINCT source_file_public_id COLLATE "C"
        AS source_file_public_id
      FROM focowiki.search_document_owners
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND provider_document_id IN ${sql(providerDocumentIds)}
        AND document_kind = 'file_relationship'
      ORDER BY source_file_public_id COLLATE "C"
    `;
  const relationRows = await sql<Array<{
    first_source_file_public_id: string;
    second_source_file_public_id: string;
  }>>`
    SELECT DISTINCT first_source_file_public_id,
                    second_source_file_public_id
    FROM focowiki.canonical_file_relations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (active OR retired_at IS NULL)
      AND (first_source_file_public_id IN ${sql(sourceFilePublicIds)}
        OR second_source_file_public_id IN ${sql(sourceFilePublicIds)}
        OR first_source_revision_public_id IN ${sql(sourceRevisionPublicIds)}
        OR second_source_revision_public_id IN ${sql(sourceRevisionPublicIds)})
  `;
  return {
    affectedSourceFilePublicIds: [...new Set([
      ...sourceFilePublicIds,
      ...ownerRows.map((row) => row.source_file_public_id),
      ...relationRows.flatMap((row) => [
        row.first_source_file_public_id,
        row.second_source_file_public_id
      ])
    ])].sort((left, right) => left.localeCompare(right, "en")),
    providerDocumentIds
  };
}

function requireLiveIdentity(value: string | null, field: string): string {
  if (!value) throw activationError(`publication_${field}_missing`);
  return value;
}

async function activateProjectionRecords(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string; activatedAt: string },
  documents: readonly PublicationDocument[]
): Promise<void> {
  if (documents.length === 0) return;
  await sql`
    UPDATE focowiki.document_projection_records record
    SET active = record.source_revision_public_id
          = desired.source_revision_public_id
          AND desired.fact_kind <> 'delete',
        retired_at = CASE
          WHEN record.source_revision_public_id
                 = desired.source_revision_public_id
            AND desired.fact_kind <> 'delete' THEN NULL
          ELSE ${input.activatedAt}::timestamptz END
    FROM jsonb_to_recordset(${sql.json(documents as never)}::jsonb) desired(
      source_file_public_id text, source_revision_public_id text,
      fact_kind text
    )
    WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
      AND record.source_file_public_id = desired.source_file_public_id
  `;
}

async function activateIdentityKeys(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    targetReadinessSequence: number;
    activatedAt: string;
  },
  documents: readonly PublicationDocument[]
): Promise<void> {
  if (documents.length === 0) return;
  await sql`
    UPDATE focowiki.source_file_identity_keys identity
    SET state = CASE
          WHEN identity.source_revision_public_id
                 = desired.source_revision_public_id
            AND desired.fact_kind <> 'delete' THEN 'active'
          ELSE 'obsolete' END,
        activation_revision = ${input.targetReadinessSequence},
        updated_at = ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(documents as never)}::jsonb) desired(
      source_file_public_id text, source_revision_public_id text,
      fact_kind text
    )
    WHERE identity.knowledge_base_id = ${input.knowledgeBaseId}
      AND identity.source_file_public_id = desired.source_file_public_id
  `;
}

async function activateSearchFamilies(
  sql: DatabaseClient,
  input: { knowledgeBaseId: string },
  documents: readonly PublicationDocument[]
): Promise<void> {
  if (documents.length === 0) return;
  await sql`
    UPDATE focowiki.search_family_receipts receipt
    SET active = receipt.source_revision_public_id
          = desired.source_revision_public_id
          AND desired.fact_kind <> 'delete'
          AND receipt.state = 'acknowledged'
    FROM jsonb_to_recordset(${sql.json(documents as never)}::jsonb) desired(
      source_file_public_id text, source_revision_public_id text,
      fact_kind text
    )
    WHERE receipt.knowledge_base_id = ${input.knowledgeBaseId}
      AND receipt.source_file_public_id = desired.source_file_public_id
  `;
}

function activationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication source activation error: ${code}`), {
    code
  });
}
