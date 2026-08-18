import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { StagedDocumentPage } from
  "../application/document-generated-page-staging.js";

export function createPostgresOperationGeneratedPageRepository(
  sql: DatabaseClient
) {
  return {
    async stage(input: {
      knowledgeBaseId: string;
      operationPublicId: string;
      baseActivationRevision: number;
      pages: readonly Omit<StagedDocumentPage, "pageCandidatePublicId">[];
      stagedAt: string;
    }): Promise<readonly StagedDocumentPage[]> {
      validateStage(input);
      const candidates = input.pages.map((page) => ({
        ...page,
        pageCandidatePublicId: candidateIdentity(input, page)
      })).sort(comparePage);
      if (candidates.length === 0) return [];
      await sql`
        INSERT INTO focowiki.generated_page_candidates (
          public_id, knowledge_base_id, owner_operation_public_id,
          logical_path, normalized_path, entry_kind,
          page_source_file_public_id, page_source_revision_public_id,
          object_id, checksum_sha256, byte_count,
          base_activation_revision, state, created_at
        )
        SELECT item.public_id, ${input.knowledgeBaseId},
               ${input.operationPublicId}, item.logical_path,
               item.normalized_path, item.entry_kind,
               item.page_source_file_public_id,
               item.page_source_revision_public_id, item.object_id,
               item.checksum_sha256, item.byte_count,
               ${input.baseActivationRevision}, 'staged', ${input.stagedAt}
        FROM jsonb_to_recordset(${sql.json(candidates.map((page) => ({
          public_id: page.pageCandidatePublicId,
          logical_path: page.logicalPath,
          normalized_path: page.normalizedPath,
          entry_kind: page.entryKind,
          page_source_file_public_id: page.sourceFilePublicId,
          page_source_revision_public_id: page.sourceRevisionPublicId,
          object_id: page.objectId,
          checksum_sha256: page.checksumSha256,
          byte_count: page.byteCount
        })) as never)}) AS item(
          public_id text, logical_path text, normalized_path text,
          entry_kind text, page_source_file_public_id text,
          page_source_revision_public_id text, object_id text,
          checksum_sha256 text, byte_count bigint
        )
        ON CONFLICT ON CONSTRAINT generated_page_candidates_operation_path_key
        DO NOTHING
      `;
      const rows = await sql<Array<{
        public_id: string;
        logical_path: string;
        normalized_path: string;
        entry_kind: string;
        source_file_public_id: string | null;
        source_revision_public_id: string | null;
        object_id: string;
        checksum_sha256: string;
        byte_count: number | string;
      }>>`
        SELECT public_id, logical_path, normalized_path, entry_kind,
               page_source_file_public_id AS source_file_public_id,
               page_source_revision_public_id AS source_revision_public_id,
               object_id, checksum_sha256, byte_count
        FROM focowiki.generated_page_candidates
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND owner_operation_public_id = ${input.operationPublicId}
          AND base_activation_revision = ${input.baseActivationRevision}
          AND public_id IN ${sql(candidates.map((page) =>
            page.pageCandidatePublicId))}
        ORDER BY normalized_path COLLATE "C"
      `;
      const stored = rows.map((row) => ({
        logicalPath: row.logical_path,
        normalizedPath: row.normalized_path,
        entryKind: row.entry_kind,
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        pageCandidatePublicId: row.public_id,
        objectId: row.object_id,
        checksumSha256: row.checksum_sha256,
        byteCount: Number(row.byte_count)
      }));
      if (stored.length !== candidates.length
        || stored.some((page, index) =>
          !samePersistedPage(page, candidates[index]!))) {
        throw operationPageError("immutable_candidate_conflict");
      }
      return candidates;
    }
  };
}

function candidateIdentity(
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    baseActivationRevision: number;
  },
  page: { normalizedPath: string; checksumSha256: string }
): string {
  return `generated-page-candidate-${createHash("sha256")
    .update(JSON.stringify([
      input.knowledgeBaseId, input.operationPublicId,
      String(input.baseActivationRevision), page.normalizedPath,
      page.checksumSha256
    ])).digest("hex")}`;
}

function validateStage(input: {
  knowledgeBaseId: string;
  operationPublicId: string;
  baseActivationRevision: number;
  pages: readonly Omit<StagedDocumentPage, "pageCandidatePublicId">[];
  stagedAt: string;
}): void {
  if ([input.knowledgeBaseId, input.operationPublicId]
    .some((value) => !value || Buffer.byteLength(value, "utf8") > 255)
    || !Number.isSafeInteger(input.baseActivationRevision)
    || input.baseActivationRevision < 0
    || !Number.isFinite(Date.parse(input.stagedAt))
    || input.pages.length > 10_000
    || new Set(input.pages.map((page) => page.normalizedPath)).size
      !== input.pages.length
    || input.pages.some((page) => !page.logicalPath || !page.normalizedPath
      || !page.entryKind || !page.objectId
      || !/^[0-9a-f]{64}$/u.test(page.checksumSha256)
      || !Number.isSafeInteger(page.byteCount) || page.byteCount < 1)) {
    throw operationPageError("invalid_input");
  }
}

function comparePage(
  left: { normalizedPath: string }, right: { normalizedPath: string }
): number {
  return left.normalizedPath < right.normalizedPath ? -1
    : left.normalizedPath > right.normalizedPath ? 1 : 0;
}

function samePersistedPage(
  stored: StagedDocumentPage,
  expected: StagedDocumentPage
): boolean {
  return stored.pageCandidatePublicId === expected.pageCandidatePublicId
    && stored.logicalPath === expected.logicalPath
    && stored.normalizedPath === expected.normalizedPath
    && stored.entryKind === expected.entryKind
    && stored.sourceFilePublicId === expected.sourceFilePublicId
    && stored.sourceRevisionPublicId === expected.sourceRevisionPublicId
    && stored.objectId === expected.objectId
    && stored.checksumSha256 === expected.checksumSha256
    && stored.byteCount === expected.byteCount;
}

function operationPageError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Operation page repository error: ${code}`), { code });
}
