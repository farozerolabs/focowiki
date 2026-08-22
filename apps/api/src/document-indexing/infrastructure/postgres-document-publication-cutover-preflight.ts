import type { DatabaseClient } from "../../db/client.js";
import {
  decideDocumentPublicationCutoverEligibility,
  inferDocumentPublicationOwnerCandidate
} from "../application/document-publication-cutover-preflight.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger
} from "./document-repository-validation.js";

export function createPostgresDocumentPublicationCutoverPreflight(
  sql: DatabaseClient
) {
  return {
    async inspect(input: Readonly<{
      knowledgeBaseId: string;
      cursor: string | null;
      limit: number;
    }>) {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 500);
      const cursor = input.cursor ?? "";
      const paths = await sql<Array<{
        normalized_path: string;
        logical_path: string;
        source_file_public_id: string | null;
        source_revision_public_id: string | null;
        object_id: string;
        checksum_sha256: string;
        byte_count: number | string;
      }>>`
        SELECT normalized_path, logical_path, source_file_public_id,
               source_revision_public_id, object_id, checksum_sha256,
               byte_count
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND normalized_path COLLATE "C" > ${cursor} COLLATE "C"
        ORDER BY normalized_path COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const hasMore = paths.length > limit;
      const page = paths.slice(0, limit).map((row) => ({
        normalizedPath: row.normalized_path,
        logicalPath: row.logical_path,
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        objectId: row.object_id,
        checksumSha256: row.checksum_sha256,
        byteCount: Number(row.byte_count),
        ownerCandidate: inferDocumentPublicationOwnerCandidate({
          normalizedPath: row.normalized_path,
          sourceFilePublicId: row.source_file_public_id
        })
      }));
      const summaryRows = await sql<Array<{
        active_path_count: number | string;
        duplicate_producer_path_count: number | string;
        unfinished_work_count: number | string;
        referenced_object_count: number | string;
        unverified_object_count: number | string;
        active_search_owner_count: number | string;
        search_owner_mismatch_count: number | string;
      }>>`
        SELECT
          (SELECT count(*) FROM focowiki.generated_page_heads head
           WHERE head.knowledge_base_id = ${knowledgeBaseId})
            AS active_path_count,
          (SELECT count(*) FROM (
             SELECT candidate.normalized_path
             FROM focowiki.generated_page_candidates candidate
             WHERE candidate.knowledge_base_id = ${knowledgeBaseId}
               AND candidate.state IN ('staged', 'active')
             GROUP BY candidate.normalized_path
             HAVING count(DISTINCT coalesce(
               candidate.source_file_public_id,
               candidate.owner_operation_public_id
             )) > 1
           ) duplicate) AS duplicate_producer_path_count,
          (SELECT count(*) FROM focowiki.document_artifact_work work
           WHERE work.knowledge_base_id = ${knowledgeBaseId}
             AND work.state IN ('waiting', 'running', 'waiting_on_projection'))
            AS unfinished_work_count,
          (SELECT count(DISTINCT head.object_id)
           FROM focowiki.generated_page_heads head
           WHERE head.knowledge_base_id = ${knowledgeBaseId})
            AS referenced_object_count,
          (SELECT count(*)
           FROM focowiki.generated_page_heads head
           LEFT JOIN focowiki.object_registrations object
             ON object.object_id = head.object_id
           WHERE head.knowledge_base_id = ${knowledgeBaseId}
             AND (object.object_id IS NULL OR object.state <> 'verified'))
            AS unverified_object_count,
          (SELECT count(*) FROM focowiki.search_document_owners owner
           WHERE owner.knowledge_base_id = ${knowledgeBaseId}
             AND owner.state = 'active') AS active_search_owner_count,
          (SELECT count(*) FROM focowiki.search_document_owners owner
           LEFT JOIN focowiki.source_file_active_revisions active
             ON active.knowledge_base_id = owner.knowledge_base_id
            AND active.source_file_public_id = owner.source_file_public_id
           WHERE owner.knowledge_base_id = ${knowledgeBaseId}
             AND owner.state = 'active'
             AND active.active_source_revision_public_id
                   IS DISTINCT FROM owner.source_revision_public_id)
            AS search_owner_mismatch_count
      `;
      const summary = summaryRows[0]!;
      const unresolvedRows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.generated_page_heads head
        LEFT JOIN focowiki.projection_artifact_owners owner
          ON owner.knowledge_base_id = head.knowledge_base_id
         AND owner.normalized_path = head.normalized_path
        WHERE head.knowledge_base_id = ${knowledgeBaseId}
          AND owner.normalized_path IS NULL
          AND head.source_file_public_id IS NULL
          AND NOT (
            head.normalized_path IN (
              'index.md', 'log.md', '_index/catalog.json',
              '_graph/catalog.json'
            )
            OR head.normalized_path LIKE 'pages/%/index%leaf%.md'
            OR head.normalized_path LIKE 'pages/%/index.md'
            OR head.normalized_path LIKE '_index/%'
            OR head.normalized_path LIKE '_graph/%'
          )
      `;
      const normalizedSummary = {
        activePathCount: Number(summary.active_path_count),
        ownerCandidateCount: Number(summary.active_path_count)
          - Number(unresolvedRows[0]?.count ?? 0),
        unresolvedOwnerCount: Number(unresolvedRows[0]?.count ?? 0),
        duplicateProducerPathCount: Number(
          summary.duplicate_producer_path_count
        ),
        unfinishedWorkCount: Number(summary.unfinished_work_count),
        referencedObjectCount: Number(summary.referenced_object_count),
        unverifiedObjectCount: Number(summary.unverified_object_count),
        activeSearchOwnerCount: Number(summary.active_search_owner_count),
        searchOwnerMismatchCount: Number(summary.search_owner_mismatch_count)
      };
      return {
        items: page,
        nextCursor: hasMore ? page.at(-1)?.normalizedPath ?? null : null,
        summary: normalizedSummary,
        eligibility: decideDocumentPublicationCutoverEligibility(
          normalizedSummary
        )
      };
    }
  };
}
