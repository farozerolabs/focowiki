import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";

type CurrentHeadCandidate = {
  old_public_id: string;
  logical_path: string;
  normalized_path: string;
  entry_kind: string;
  page_source_file_public_id: string | null;
  page_source_revision_public_id: string | null;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
};

export async function rehomePostgresCurrentDocumentPageCandidates(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  documentJobPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  previousSourceRevisionPublicId: string;
  activationRevision: number;
  activatedAt: string;
}): Promise<number> {
  const sql = input.transaction;
  const work = await sql<Array<{ public_id: string }>>`
    SELECT public_id
    FROM focowiki.document_artifact_work
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND document_job_public_id = ${input.documentJobPublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND work_kind = 'knowledge_projection'
  `;
  if (!work[0]) throw rehomeError("knowledge_projection_work_missing");
  const oldHeads = await sql<CurrentHeadCandidate[]>`
    SELECT candidate.public_id AS old_public_id, candidate.logical_path,
           candidate.normalized_path, candidate.entry_kind,
           candidate.page_source_file_public_id,
           candidate.page_source_revision_public_id,
           candidate.object_id, candidate.checksum_sha256,
           candidate.byte_count
    FROM focowiki.generated_page_heads head
    JOIN focowiki.generated_page_candidates candidate
      ON candidate.knowledge_base_id = head.knowledge_base_id
     AND candidate.public_id = head.page_candidate_public_id
    WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate.source_file_public_id = ${input.sourceFilePublicId}
      AND candidate.source_revision_public_id
        = ${input.previousSourceRevisionPublicId}
    ORDER BY candidate.normalized_path COLLATE "C"
  `;
  if (oldHeads.length === 0) return 0;
  if (oldHeads.length > 10_000) throw rehomeError("candidate_limit_exceeded");
  const candidates = oldHeads.map((candidate) => {
    const publicId = candidateIdentity(input.documentJobPublicId, candidate.old_public_id);
    return {
      old_public_id: candidate.old_public_id,
      public_id: publicId,
      source_work_public_id: work[0]!.public_id,
      logical_path: candidate.logical_path,
      normalized_path: candidate.normalized_path,
      entry_kind: candidate.entry_kind,
      page_source_file_public_id: candidate.page_source_file_public_id,
      page_source_revision_public_id:
        candidate.page_source_file_public_id === input.sourceFilePublicId
          && candidate.page_source_revision_public_id
            === input.previousSourceRevisionPublicId
          ? input.sourceRevisionPublicId
          : candidate.page_source_revision_public_id,
      object_id: candidate.object_id,
      checksum_sha256: candidate.checksum_sha256,
      byte_count: Number(candidate.byte_count)
    };
  });
  await sql`
    INSERT INTO focowiki.generated_page_candidates (
      public_id, knowledge_base_id, source_work_public_id,
      source_revision_public_id, logical_path, normalized_path, entry_kind,
      source_file_public_id, page_source_file_public_id,
      page_source_revision_public_id, object_id, checksum_sha256, byte_count,
      base_activation_revision, state, created_at
    )
    SELECT item.public_id, ${input.knowledgeBaseId},
           item.source_work_public_id, ${input.sourceRevisionPublicId},
           item.logical_path, item.normalized_path, item.entry_kind,
           ${input.sourceFilePublicId}, item.page_source_file_public_id,
           item.page_source_revision_public_id, item.object_id,
           item.checksum_sha256, item.byte_count,
           ${input.activationRevision}, 'active', ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(candidates as never)}::jsonb) AS item(
      old_public_id text, public_id text, source_work_public_id text,
      logical_path text, normalized_path text, entry_kind text,
      page_source_file_public_id text, page_source_revision_public_id text,
      object_id text, checksum_sha256 text, byte_count bigint
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM focowiki.generated_page_candidates current
      WHERE current.knowledge_base_id = ${input.knowledgeBaseId}
        AND current.source_work_public_id = item.source_work_public_id
        AND current.source_revision_public_id = ${input.sourceRevisionPublicId}
        AND current.normalized_path = item.normalized_path
        AND current.state IN ('staged', 'active')
    )
    ON CONFLICT ON CONSTRAINT generated_page_candidates_revision_path_key
      DO NOTHING
  `;
  const resolved = await sql<Array<{
    old_public_id: string;
    public_id: string;
    normalized_path: string;
    object_id: string;
  }>>`
    WITH desired AS (
      SELECT *
      FROM jsonb_to_recordset(${sql.json(candidates as never)}::jsonb) AS item(
        old_public_id text, public_id text, normalized_path text,
        checksum_sha256 text, object_id text
      )
    )
    SELECT desired.old_public_id, current.public_id,
           current.normalized_path, current.object_id
    FROM desired
    JOIN LATERAL (
      SELECT candidate.public_id, candidate.normalized_path,
             candidate.object_id
      FROM focowiki.generated_page_candidates candidate
      WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
        AND candidate.source_work_public_id = ${work[0]!.public_id}
        AND candidate.source_revision_public_id = ${input.sourceRevisionPublicId}
        AND candidate.normalized_path = desired.normalized_path
        AND candidate.state IN ('staged', 'active')
      ORDER BY (candidate.public_id <> desired.public_id) DESC,
               candidate.created_at DESC, candidate.public_id COLLATE "C"
      LIMIT 1
    ) current ON true
    ORDER BY desired.normalized_path COLLATE "C"
  `;
  if (resolved.length !== candidates.length) {
    throw rehomeError("candidate_resolution_incomplete");
  }
  await sql`
    UPDATE focowiki.generated_page_candidates candidate
    SET state = 'active'
    WHERE candidate.knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate.public_id = ANY(${resolved.map((item) => item.public_id)}::text[])
      AND candidate.state IN ('staged', 'active')
  `;
  await sql`
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      generated_page_candidate_public_id, created_at
    )
    SELECT 'object-owner-' || md5(
             ${input.documentJobPublicId} || chr(31) || item.public_id
           ),
           ${input.knowledgeBaseId}, item.object_id,
           'generated_page_candidate', item.public_id, ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(resolved as never)}::jsonb) AS item(
      public_id text, object_id text
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM focowiki.object_owners owner
      WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
        AND owner.generated_page_candidate_public_id = item.public_id
    )
  `;
  const updated = await sql<Array<{ normalized_path: string }>>`
    UPDATE focowiki.generated_page_heads head
    SET page_candidate_public_id = item.public_id,
        source_revision_public_id = CASE
          WHEN head.source_revision_public_id
            = ${input.previousSourceRevisionPublicId}
          THEN ${input.sourceRevisionPublicId}
          ELSE head.source_revision_public_id END,
        activation_revision = ${input.activationRevision},
        updated_at = ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(resolved as never)}::jsonb) AS item(
      old_public_id text, public_id text, normalized_path text
    )
    WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
      AND head.normalized_path = item.normalized_path
      AND head.page_candidate_public_id = item.old_public_id
    RETURNING head.normalized_path
  `;
  if (updated.length !== candidates.length) {
    throw rehomeError("head_update_conflict");
  }
  await sql`
    UPDATE focowiki.scoped_activation_owners owner
    SET active_page_candidate_public_id = item.public_id,
        updated_at = ${input.activatedAt}
    FROM jsonb_to_recordset(${sql.json(resolved as never)}::jsonb) AS item(
      old_public_id text, public_id text
    )
    WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
      AND owner.active_page_candidate_public_id = item.old_public_id
  `;
  return resolved.length;
}

function candidateIdentity(documentJobPublicId: string, oldPublicId: string): string {
  return `generated-page-candidate-${createHash("sha256").update([
    "rehome-current-page-v1",
    documentJobPublicId,
    oldPublicId
  ].join("\0")).digest("hex")}`;
}

function rehomeError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document page candidate rehome error: ${code}`), {
    code
  });
}
