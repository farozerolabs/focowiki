import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentPublicationItem,
  DocumentPublicationItemInput
} from "../application/document-publication-job-ports.js";
import {
  assertRepositoryIdentity,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

const MAXIMUM_ITEM_EVIDENCE_BYTES = 65_536;
const MAXIMUM_PATH_BYTES = 4_096;

export type DocumentPublicationItemRow = {
  public_id: string;
  mutation_public_id: string;
  knowledge_base_id: string;
  document_job_public_id: string | null;
  source_file_public_id: string;
  source_revision_public_id: string;
  operation: DocumentPublicationItemInput["operation"];
  prior_logical_path: string | null;
  next_logical_path: string | null;
  affected_evidence: Readonly<Record<string, unknown>>;
  readiness_sequence: number | string;
  outcome: DocumentPublicationItem["outcome"];
  created_at: Date | string;
};

export async function createPostgresDocumentPublicationItem(
  sql: DatabaseClient,
  input: DocumentPublicationItemInput
): Promise<DocumentPublicationItem> {
  const value = validateItem(input);
  const rows = await sql<DocumentPublicationItemRow[]>`
    WITH inserted AS (
      INSERT INTO focowiki.publication_items (
        public_id, mutation_public_id, knowledge_base_id,
        document_job_public_id, source_file_public_id,
        source_revision_public_id, operation, prior_logical_path,
        next_logical_path, affected_evidence, readiness_sequence,
        created_at, updated_at
      ) VALUES (
        ${value.publicId}, ${value.mutationPublicId}, ${value.knowledgeBaseId},
        ${value.documentJobPublicId}, ${value.sourceFilePublicId},
        ${value.sourceRevisionPublicId}, ${value.operation},
        ${value.priorLogicalPath}, ${value.nextLogicalPath},
        ${sql.json(value.affectedEvidence as never)},
        ${value.readinessSequence}, ${value.createdAt}, ${value.createdAt}
      )
      ON CONFLICT (knowledge_base_id, mutation_public_id) DO NOTHING
      RETURNING public_id, mutation_public_id, knowledge_base_id,
                document_job_public_id, source_file_public_id,
                source_revision_public_id, operation, prior_logical_path,
                next_logical_path, affected_evidence, readiness_sequence,
                outcome, created_at
    ), head_updated AS (
      INSERT INTO focowiki.knowledge_base_publication_heads (
        knowledge_base_id, latest_readiness_sequence, pending_item_count,
        oldest_pending_at, latest_pending_at, updated_at
      )
      SELECT knowledge_base_id, readiness_sequence, 1,
             created_at, created_at, created_at
      FROM inserted
      ON CONFLICT (knowledge_base_id) DO UPDATE
      SET latest_readiness_sequence = greatest(
            focowiki.knowledge_base_publication_heads.latest_readiness_sequence,
            excluded.latest_readiness_sequence
          ),
          pending_item_count =
            focowiki.knowledge_base_publication_heads.pending_item_count + 1,
          oldest_pending_at = least(
            coalesce(focowiki.knowledge_base_publication_heads.oldest_pending_at,
                     excluded.oldest_pending_at),
            excluded.oldest_pending_at
          ),
          latest_pending_at = greatest(
            coalesce(focowiki.knowledge_base_publication_heads.latest_pending_at,
                     excluded.latest_pending_at),
            excluded.latest_pending_at
          ),
          updated_at = excluded.updated_at
      RETURNING knowledge_base_id
    ), selected AS (
      SELECT * FROM inserted
      UNION ALL
      SELECT existing.public_id, existing.mutation_public_id,
             existing.knowledge_base_id, existing.document_job_public_id,
             existing.source_file_public_id,
             existing.source_revision_public_id, existing.operation,
             existing.prior_logical_path, existing.next_logical_path,
             existing.affected_evidence, existing.readiness_sequence,
             existing.outcome, existing.created_at
      FROM focowiki.publication_items existing
      WHERE existing.knowledge_base_id = ${value.knowledgeBaseId}
        AND existing.mutation_public_id = ${value.mutationPublicId}
        AND existing.public_id = ${value.publicId}
        AND existing.document_job_public_id
              IS NOT DISTINCT FROM ${value.documentJobPublicId}
        AND existing.source_file_public_id = ${value.sourceFilePublicId}
        AND existing.source_revision_public_id = ${value.sourceRevisionPublicId}
        AND existing.operation = ${value.operation}
        AND existing.prior_logical_path
              IS NOT DISTINCT FROM ${value.priorLogicalPath}
        AND existing.next_logical_path
              IS NOT DISTINCT FROM ${value.nextLogicalPath}
        AND existing.affected_evidence
              = ${sql.json(value.affectedEvidence as never)}::jsonb
        AND existing.readiness_sequence = ${value.readinessSequence}
        AND NOT EXISTS (SELECT 1 FROM inserted)
    )
    SELECT selected.*
    FROM selected
    LEFT JOIN head_updated
      ON head_updated.knowledge_base_id = selected.knowledge_base_id
  `;
  if (!rows[0]) throw repositoryContractError("publication_item_conflict");
  return mapDocumentPublicationItem(rows[0]);
}

export async function createPostgresReadyDocumentPublicationItem(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  mutationPublicId: string;
  documentJobPublicId: string | null;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  operation: DocumentPublicationItemInput["operation"];
  affectedEvidence: Readonly<Record<string, unknown>>;
  createdAt: string;
}): Promise<DocumentPublicationItem> {
  const sql = input.transaction;
  await sql`
    INSERT INTO focowiki.knowledge_base_publication_heads (
      knowledge_base_id, updated_at
    ) VALUES (${input.knowledgeBaseId}, ${input.createdAt})
    ON CONFLICT (knowledge_base_id) DO NOTHING
  `;
  await sql`
    SELECT knowledge_base_id
    FROM focowiki.knowledge_base_publication_heads
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
    FOR UPDATE
  `;
  const existing = await sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.publication_items
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND mutation_public_id = ${input.mutationPublicId}
  `;
  if (existing[0]) {
    return createPostgresDocumentPublicationItem(
      sql, await readExistingItemInput(sql, existing[0].public_id)
    );
  }
  const paths = await sql<Array<{
    prior_logical_path: string | null;
    next_logical_path: string | null;
  }>>`
    SELECT prior.logical_path AS prior_logical_path,
           CASE WHEN ${input.operation} = 'delete'
             THEN NULL ELSE successor.logical_path END AS next_logical_path
    FROM focowiki.source_file_active_revisions active
    LEFT JOIN focowiki.document_projection_records prior
      ON prior.knowledge_base_id = active.knowledge_base_id
     AND prior.source_revision_public_id
           = active.active_source_revision_public_id
    LEFT JOIN focowiki.document_projection_records successor
      ON successor.knowledge_base_id = active.knowledge_base_id
     AND successor.source_revision_public_id = ${input.sourceRevisionPublicId}
    WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
      AND active.source_file_public_id = ${input.sourceFilePublicId}
      AND active.current_source_revision_public_id
            = ${input.sourceRevisionPublicId}
  `;
  const path = paths[0];
  if (!path || (!path.prior_logical_path && !path.next_logical_path)) {
    throw repositoryContractError("publication_item_path_missing");
  }
  const sequences = await sql<Array<{ readiness_sequence: number | string }>>`
    UPDATE focowiki.knowledge_base_publication_heads
    SET latest_readiness_sequence = greatest(
          latest_readiness_sequence, active_readiness_sequence
        ) + 1,
        updated_at = ${input.createdAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
    RETURNING latest_readiness_sequence AS readiness_sequence
  `;
  return createPostgresDocumentPublicationItem(sql, {
    publicId: `publication-item-${randomUUID()}`,
    mutationPublicId: input.mutationPublicId,
    knowledgeBaseId: input.knowledgeBaseId,
    documentJobPublicId: input.documentJobPublicId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    operation: normalizePublicationOperation(input.operation, path),
    priorLogicalPath: path.prior_logical_path,
    nextLogicalPath: path.next_logical_path,
    affectedEvidence: input.affectedEvidence,
    readinessSequence: Number(sequences[0]!.readiness_sequence),
    createdAt: input.createdAt
  });
}

function normalizePublicationOperation(
  operation: DocumentPublicationItemInput["operation"],
  path: Readonly<{
    prior_logical_path: string | null;
    next_logical_path: string | null;
  }>
): DocumentPublicationItemInput["operation"] {
  if (operation !== "move" || !path.prior_logical_path
    || !path.next_logical_path
    || path.prior_logical_path === path.next_logical_path) return operation;
  const priorDirectory = path.prior_logical_path.split("/").slice(0, -1)
    .join("/");
  const nextDirectory = path.next_logical_path.split("/").slice(0, -1)
    .join("/");
  return priorDirectory === nextDirectory ? "rename" : operation;
}

export async function supersedeOlderPostgresDocumentPublicationItems(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  now: string
): Promise<number> {
  const rows = await sql<Array<{ public_id: string }>>`
    WITH ranked AS (
      SELECT item.public_id,
             active.current_source_revision_public_id
               = item.source_revision_public_id AS is_current,
             row_number() OVER (
               PARTITION BY item.source_file_public_id
               ORDER BY
                 (active.current_source_revision_public_id
                    = item.source_revision_public_id) DESC,
                 item.readiness_sequence DESC,
                 item.public_id COLLATE "C" DESC
             ) AS source_rank
      FROM focowiki.publication_items item
      JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = item.knowledge_base_id
       AND active.source_file_public_id = item.source_file_public_id
      WHERE item.knowledge_base_id = ${knowledgeBaseId}
        AND item.outcome = 'pending'
    )
    UPDATE focowiki.publication_items item
    SET outcome = 'superseded', terminal_at = ${now}, updated_at = ${now}
    FROM ranked
    WHERE item.knowledge_base_id = ${knowledgeBaseId}
      AND item.outcome = 'pending'
      AND ranked.public_id = item.public_id
      AND (NOT ranked.is_current OR ranked.source_rank > 1)
    RETURNING item.public_id
  `;
  return rows.length;
}

export async function rebaseStalePendingPostgresDocumentPublicationItems(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    activeReadinessSequence: number;
    updatedAt: string;
  }>
): Promise<number> {
  const rows = await sql<Array<{ rebased_count: number | string }>>`
    WITH bounds AS (
      SELECT greatest(
        head.latest_readiness_sequence,
        head.active_readiness_sequence,
        coalesce((
          SELECT max(existing.readiness_sequence)
          FROM focowiki.publication_items existing
          WHERE existing.knowledge_base_id = ${input.knowledgeBaseId}
        ), 0)
      ) AS base_sequence
      FROM focowiki.knowledge_base_publication_heads head
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
    ), ranked AS (
      SELECT item.public_id,
             bounds.base_sequence + row_number() OVER (
               ORDER BY item.readiness_sequence, item.public_id COLLATE "C"
             ) AS next_sequence
      FROM focowiki.publication_items item
      CROSS JOIN bounds
      WHERE item.knowledge_base_id = ${input.knowledgeBaseId}
        AND item.outcome = 'pending'
        AND item.readiness_sequence <= ${input.activeReadinessSequence}
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.publication_job_items membership
          WHERE membership.item_public_id = item.public_id
        )
    ), rebased AS (
      UPDATE focowiki.publication_items item
      SET readiness_sequence = ranked.next_sequence,
          updated_at = ${input.updatedAt}
      FROM ranked
      WHERE item.public_id = ranked.public_id
      RETURNING item.readiness_sequence
    ), summary AS (
      SELECT count(*) AS rebased_count,
             max(readiness_sequence) AS maximum_sequence
      FROM rebased
    ), head_updated AS (
      UPDATE focowiki.knowledge_base_publication_heads head
      SET latest_readiness_sequence = greatest(
            head.latest_readiness_sequence,
            coalesce(summary.maximum_sequence,
                     head.latest_readiness_sequence)
          ),
          updated_at = CASE WHEN summary.rebased_count > 0
            THEN ${input.updatedAt} ELSE head.updated_at END
      FROM summary
      WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
      RETURNING summary.rebased_count
    )
    SELECT rebased_count FROM head_updated
  `;
  return Number(rows[0]?.rebased_count ?? 0);
}

export async function updatePostgresDocumentPublicationPendingHead(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  remainingCount: number;
  updatedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  await sql`
    UPDATE focowiki.knowledge_base_publication_heads head
    SET pending_item_count = ${input.remainingCount},
        oldest_pending_at = CASE WHEN ${input.remainingCount} = 0 THEN NULL
          ELSE (
            SELECT item.created_at FROM focowiki.publication_items item
            WHERE item.knowledge_base_id = ${input.knowledgeBaseId}
              AND item.outcome = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.publication_job_items membership
                WHERE membership.item_public_id = item.public_id
              )
            ORDER BY item.created_at, item.public_id COLLATE "C" LIMIT 1
          ) END,
        latest_pending_at = CASE WHEN ${input.remainingCount} = 0 THEN NULL
          ELSE (
            SELECT item.created_at FROM focowiki.publication_items item
            WHERE item.knowledge_base_id = ${input.knowledgeBaseId}
              AND item.outcome = 'pending'
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.publication_job_items membership
                WHERE membership.item_public_id = item.public_id
              )
            ORDER BY item.created_at DESC, item.public_id COLLATE "C" DESC
            LIMIT 1
          ) END,
        updated_at = ${input.updatedAt}
    WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
  `;
}

export function mapDocumentPublicationItem(
  row: DocumentPublicationItemRow
): DocumentPublicationItem {
  return Object.freeze({
    publicId: row.public_id,
    mutationPublicId: row.mutation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    documentJobPublicId: row.document_job_public_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    operation: row.operation,
    priorLogicalPath: row.prior_logical_path,
    nextLogicalPath: row.next_logical_path,
    affectedEvidence: row.affected_evidence,
    readinessSequence: Number(row.readiness_sequence),
    createdAt: new Date(row.created_at).toISOString(),
    outcome: row.outcome
  });
}

async function readExistingItemInput(
  sql: DatabaseClient,
  publicId: string
): Promise<DocumentPublicationItemInput> {
  const rows = await sql<DocumentPublicationItemRow[]>`
    SELECT public_id, mutation_public_id, knowledge_base_id,
           document_job_public_id, source_file_public_id,
           source_revision_public_id, operation, prior_logical_path,
           next_logical_path, affected_evidence, readiness_sequence,
           outcome, created_at
    FROM focowiki.publication_items
    WHERE public_id = ${publicId}
  `;
  const item = rows[0];
  if (!item) throw repositoryContractError("publication_item_missing");
  const mapped = mapDocumentPublicationItem(item);
  return { ...mapped };
}

function validateItem(input: DocumentPublicationItemInput) {
  assertJsonSize(input.affectedEvidence, MAXIMUM_ITEM_EVIDENCE_BYTES);
  if (!Number.isSafeInteger(input.readinessSequence)
    || input.readinessSequence < 1) {
    throw repositoryContractError("publication_readiness_sequence_invalid");
  }
  if (!input.priorLogicalPath && !input.nextLogicalPath) {
    throw repositoryContractError("publication_item_path_missing");
  }
  return {
    ...input,
    publicId: assertRepositoryIdentity(input.publicId, "item_public_id"),
    mutationPublicId: assertRepositoryIdentity(
      input.mutationPublicId, "mutation_public_id"),
    knowledgeBaseId: assertRepositoryIdentity(
      input.knowledgeBaseId, "knowledge_base_id"),
    documentJobPublicId: input.documentJobPublicId === null ? null
      : assertRepositoryIdentity(input.documentJobPublicId,
          "document_job_public_id"),
    sourceFilePublicId: assertRepositoryIdentity(
      input.sourceFilePublicId, "source_file_public_id"),
    sourceRevisionPublicId: assertRepositoryIdentity(
      input.sourceRevisionPublicId, "source_revision_public_id"),
    priorLogicalPath: validatePath(input.priorLogicalPath),
    nextLogicalPath: validatePath(input.nextLogicalPath),
    createdAt: assertRepositoryTimestamp(input.createdAt, "created_at")
  };
}

function validatePath(value: string | null): string | null {
  if (value === null) return null;
  const path = value.normalize("NFC").trim();
  if (!path || Buffer.byteLength(path, "utf8") > MAXIMUM_PATH_BYTES
    || path.startsWith("/") || path.split("/").includes("..")) {
    throw repositoryContractError("publication_path_invalid");
  }
  return path;
}

function assertJsonSize(value: unknown, maximumBytes: number): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined
    || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw repositoryContractError("publication_item_evidence_invalid");
  }
}
