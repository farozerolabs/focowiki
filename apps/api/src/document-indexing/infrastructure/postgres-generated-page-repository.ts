import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { StagedDocumentPage } from
  "../application/document-generated-page-staging.js";
import { ownerIdentity } from "./production-document-identities.js";
import { validateGeneratedPageContributorStage as validateContributorStage }
  from "./generated-page-contributor-validation.js";

export type GeneratedPageHead = {
  logicalPath: string;
  normalizedPath: string;
  entryKind: string;
  sourceFilePublicId: string | null;
  sourceRevisionPublicId: string | null;
  pageCandidatePublicId: string;
  objectId: string;
  checksumSha256: string;
  byteCount: number;
  activationRevision: number;
};

type HeadRow = {
  logical_path: string;
  normalized_path: string;
  entry_kind: string;
  source_file_public_id: string | null;
  source_revision_public_id: string | null;
  page_candidate_public_id: string;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
  activation_revision: number | string;
};

export function createPostgresGeneratedPageRepository(sql: DatabaseClient) {
  return {
    async stage(input: {
      knowledgeBaseId: string;
      sourceWorkPublicId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      baseActivationRevision: number;
      pages: readonly Omit<StagedDocumentPage,
        "pageCandidatePublicId">[];
      stagedAt: string;
    }): Promise<readonly StagedDocumentPage[]> {
      validateStage(input);
      const candidates = input.pages.map((page) => ({
        ...page,
        pageCandidatePublicId: candidateIdentity(input, page)
      }));
      if (candidates.length === 0) return [];
      return await sql.begin(async (transaction) => {
        const objectIds = [...new Set(candidates.map((page) => page.objectId))];
        const registrations = await transaction<Array<{
          object_id: string;
          state: string;
        }>>`
          SELECT object_id, state
          FROM focowiki.object_registrations
          WHERE object_id IN ${transaction(objectIds)}
          ORDER BY object_id COLLATE "C"
          FOR UPDATE
        `;
        if (registrations.length !== objectIds.length
          || registrations.some((registration) => registration.state !== "verified")) {
          throw pageRepositoryError("page_object_unverified");
        }
        await transaction`
        INSERT INTO focowiki.generated_page_candidates (
          public_id, knowledge_base_id, source_work_public_id,
          source_revision_public_id, logical_path, normalized_path,
          entry_kind, source_file_public_id, page_source_file_public_id,
          page_source_revision_public_id, object_id, checksum_sha256,
          byte_count, base_activation_revision, state, created_at
        )
        SELECT item.public_id, ${input.knowledgeBaseId},
               ${input.sourceWorkPublicId},
               ${input.sourceRevisionPublicId}, item.logical_path,
               item.normalized_path, item.entry_kind,
               ${input.sourceFilePublicId}, item.page_source_file_public_id,
               item.page_source_revision_public_id, item.object_id,
               item.checksum_sha256, item.byte_count,
               ${input.baseActivationRevision}, 'staged', ${input.stagedAt}
        FROM jsonb_to_recordset(${transaction.json(candidates.map((page) => ({
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
          page_source_revision_public_id text, object_id text, checksum_sha256 text,
          byte_count bigint
        )
        ON CONFLICT ON CONSTRAINT generated_page_candidates_revision_path_key
        DO NOTHING
        `;
        await transaction`
          INSERT INTO focowiki.object_owners (
            public_id, knowledge_base_id, object_id, owner_kind,
            generated_page_candidate_public_id, created_at
          )
          SELECT item.public_id, ${input.knowledgeBaseId}, item.object_id,
                 'generated_page_candidate', item.page_candidate_public_id,
                 ${input.stagedAt}
          FROM jsonb_to_recordset(${transaction.json(candidates.map((page) => ({
            public_id: ownerIdentity(page.pageCandidatePublicId, page.objectId),
            page_candidate_public_id: page.pageCandidatePublicId,
            object_id: page.objectId
          })) as never)}) AS item(
            public_id text, page_candidate_public_id text, object_id text
          )
          ON CONFLICT (object_id, owner_kind, owner_public_id) DO NOTHING
        `;
        const rows = await transaction<Array<{
        public_id: string;
        logical_path: string;
        normalized_path: string;
        entry_kind: string;
        source_file_public_id: string;
        source_revision_public_id: string;
        object_id: string;
        checksum_sha256: string;
        byte_count: number | string;
        state: string;
      }>>`
        SELECT public_id, logical_path, normalized_path, entry_kind,
               page_source_file_public_id AS source_file_public_id,
               page_source_revision_public_id AS source_revision_public_id,
               object_id, checksum_sha256, byte_count, state
        FROM focowiki.generated_page_candidates
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_revision_public_id = ${input.sourceRevisionPublicId}
          AND base_activation_revision = ${input.baseActivationRevision}
          AND public_id IN ${transaction(candidates.map((page) =>
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
        || stored.some((page, index) => !samePersistedPage(
          page,
          [...candidates].sort(comparePage)[index]!
        ))) throw pageRepositoryError("immutable_candidate_conflict");
      return [...candidates].sort(comparePage);
      }) as unknown as readonly StagedDocumentPage[];
    },

    async stageForContributors(input: {
      knowledgeBaseId: string;
      contributors: readonly {
        sourceFilePublicId: string;
        sourceRevisionPublicId: string;
        sourceWorkPublicId: string;
        requiredSequence: number;
      }[];
      pages: readonly Omit<StagedDocumentPage, "pageCandidatePublicId">[];
      stagedAt: string;
    }): Promise<number> {
      validateContributorStage(input);
      const candidates = input.contributors.flatMap((contributor) =>
        input.pages.map((page) => ({
          public_id: candidateIdentity({
            knowledgeBaseId: input.knowledgeBaseId,
            sourceRevisionPublicId: contributor.sourceRevisionPublicId,
            baseActivationRevision: contributor.requiredSequence
          }, page),
          source_work_public_id: contributor.sourceWorkPublicId,
          source_file_public_id: contributor.sourceFilePublicId,
          source_revision_public_id: contributor.sourceRevisionPublicId,
          base_activation_revision: contributor.requiredSequence,
          logical_path: page.logicalPath,
          normalized_path: page.normalizedPath,
          entry_kind: page.entryKind,
          page_source_file_public_id: page.sourceFilePublicId,
          page_source_revision_public_id: page.sourceRevisionPublicId,
          object_id: page.objectId,
          checksum_sha256: page.checksumSha256,
          byte_count: page.byteCount
        }))
      );
      if (candidates.length === 0) return 0;
      return await sql.begin(async (transaction) => {
        const objectIds = [...new Set(candidates.map((page) => page.object_id))];
        const registrations = await transaction<Array<{
          object_id: string;
          state: string;
        }>>`
          SELECT object_id, state
          FROM focowiki.object_registrations
          WHERE object_id IN ${transaction(objectIds)}
          ORDER BY object_id COLLATE "C"
          FOR UPDATE
        `;
        if (registrations.length !== objectIds.length
          || registrations.some((registration) =>
            registration.state !== "verified")) {
          throw pageRepositoryError("page_object_unverified");
        }
        await transaction`
          INSERT INTO focowiki.generated_page_candidates (
            public_id, knowledge_base_id, source_work_public_id,
            source_revision_public_id, logical_path, normalized_path,
            entry_kind, source_file_public_id, page_source_file_public_id,
            page_source_revision_public_id, object_id, checksum_sha256,
            byte_count, base_activation_revision, state, created_at
          )
          SELECT item.public_id, ${input.knowledgeBaseId},
                 item.source_work_public_id, item.source_revision_public_id,
                 item.logical_path, item.normalized_path, item.entry_kind,
                 item.source_file_public_id, item.page_source_file_public_id,
                 item.page_source_revision_public_id, item.object_id,
                 item.checksum_sha256, item.byte_count,
                 item.base_activation_revision, 'staged', ${input.stagedAt}
          FROM jsonb_to_recordset(${transaction.json(candidates as never)}) AS item(
            public_id text, source_work_public_id text,
            source_file_public_id text, source_revision_public_id text,
            base_activation_revision bigint, logical_path text,
            normalized_path text, entry_kind text,
            page_source_file_public_id text,
            page_source_revision_public_id text, object_id text,
            checksum_sha256 text, byte_count bigint
          )
          ON CONFLICT ON CONSTRAINT generated_page_candidates_revision_path_key
          DO NOTHING
        `;
        await transaction`
          INSERT INTO focowiki.object_owners (
            public_id, knowledge_base_id, object_id, owner_kind,
            generated_page_candidate_public_id, created_at
          )
          SELECT item.owner_public_id, ${input.knowledgeBaseId}, item.object_id,
                 'generated_page_candidate', item.page_candidate_public_id,
                 ${input.stagedAt}
          FROM jsonb_to_recordset(${transaction.json(candidates.map((page) => ({
            owner_public_id: ownerIdentity(page.public_id, page.object_id),
            page_candidate_public_id: page.public_id,
            object_id: page.object_id
          })) as never)}) AS item(
            owner_public_id text, page_candidate_public_id text, object_id text
          )
          JOIN focowiki.generated_page_candidates candidate
            ON candidate.public_id = item.page_candidate_public_id
          ON CONFLICT (object_id, owner_kind, owner_public_id) DO NOTHING
        `;
        const rows = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.generated_page_candidates
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id IN ${transaction(candidates.map((page) => page.public_id))}
          ORDER BY public_id COLLATE "C"
        `;
        if (rows.length !== candidates.length) {
          throw pageRepositoryError("immutable_candidate_conflict");
        }
        return rows.length;
      }) as unknown as number;
    },

    async readCandidatesForPaths(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
      baseActivationRevision: number;
      normalizedPaths: readonly string[];
      limit: number;
    }): Promise<readonly StagedDocumentPage[]> {
      const paths = uniquePaths(input.normalizedPaths, input.limit);
      if (!input.knowledgeBaseId || !input.sourceRevisionPublicId
        || !Number.isSafeInteger(input.baseActivationRevision)
        || input.baseActivationRevision < 1) {
        throw pageRepositoryError("invalid_input");
      }
      if (paths.length === 0) return [];
      const rows = await sql<Array<{
        public_id: string;
        logical_path: string;
        normalized_path: string;
        entry_kind: string;
        page_source_file_public_id: string | null;
        page_source_revision_public_id: string | null;
        object_id: string;
        checksum_sha256: string;
        byte_count: number | string;
      }>>`
        SELECT public_id, logical_path, normalized_path, entry_kind,
               page_source_file_public_id, page_source_revision_public_id,
               object_id, checksum_sha256, byte_count
        FROM focowiki.generated_page_candidates
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_revision_public_id = ${input.sourceRevisionPublicId}
          AND base_activation_revision = ${input.baseActivationRevision}
          AND normalized_path IN ${sql(paths)}
          AND state = 'staged'
        ORDER BY normalized_path COLLATE "C"
        LIMIT ${input.limit}
      `;
      return rows.map((row) => ({
        logicalPath: row.logical_path,
        normalizedPath: row.normalized_path,
        entryKind: row.entry_kind,
        sourceFilePublicId: row.page_source_file_public_id,
        sourceRevisionPublicId: row.page_source_revision_public_id,
        pageCandidatePublicId: row.public_id,
        objectId: row.object_id,
        checksumSha256: row.checksum_sha256,
        byteCount: Number(row.byte_count)
      }));
    },

    async readHeads(input: {
      knowledgeBaseId: string;
      normalizedPaths: readonly string[];
      limit: number;
    }): Promise<readonly GeneratedPageHead[]> {
      const paths = uniquePaths(input.normalizedPaths, input.limit);
      const rows = paths.length === 0 ? [] : await sql<HeadRow[]>`
        SELECT logical_path, normalized_path, entry_kind,
               source_file_public_id, source_revision_public_id,
               page_candidate_public_id, object_id, checksum_sha256,
               byte_count, activation_revision
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND normalized_path IN ${sql(paths)}
        ORDER BY normalized_path COLLATE "C"
        LIMIT ${input.limit}
      `;
      return rows.map(mapHead);
    },

    async readSourceHeads(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      limit: number;
    }): Promise<readonly GeneratedPageHead[]> {
      assertLimit(input.limit);
      if (!input.knowledgeBaseId || !input.sourceFilePublicId) {
        throw pageRepositoryError("invalid_input");
      }
      const rows = await sql<HeadRow[]>`
        SELECT logical_path, normalized_path, entry_kind,
               source_file_public_id, source_revision_public_id,
               page_candidate_public_id, object_id, checksum_sha256,
               byte_count, activation_revision
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_file_public_id = ${input.sourceFilePublicId}
          AND entry_kind = 'source'
        ORDER BY normalized_path COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw pageRepositoryError("source_head_limit_exceeded");
      }
      return rows.map(mapHead);
    },

    async listHeads(input: {
      knowledgeBaseId: string;
      afterNormalizedPath: string | null;
      limit: number;
    }): Promise<{ items: readonly GeneratedPageHead[]; nextCursor: string | null }> {
      assertLimit(input.limit);
      const rows = await sql<HeadRow[]>`
        SELECT logical_path, normalized_path, entry_kind,
               source_file_public_id, source_revision_public_id,
               page_candidate_public_id, object_id, checksum_sha256,
               byte_count, activation_revision
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND (${input.afterNormalizedPath}::text IS NULL
            OR normalized_path COLLATE "C"
              > ${input.afterNormalizedPath}::text COLLATE "C")
        ORDER BY normalized_path COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      return {
        items: rows.slice(0, input.limit).map(mapHead),
        nextCursor: rows.length > input.limit
          ? rows[input.limit - 1]!.normalized_path : null
      };
    }
  };
}

function candidateIdentity(
  input: {
    knowledgeBaseId: string;
    sourceRevisionPublicId: string;
    baseActivationRevision: number;
  },
  page: { normalizedPath: string; checksumSha256: string }
): string {
  return `generated-page-candidate-${createHash("sha256")
    .update(JSON.stringify([
      input.knowledgeBaseId, input.sourceRevisionPublicId,
      String(input.baseActivationRevision),
      page.normalizedPath, page.checksumSha256
    ])).digest("hex")}`;
}

function validateStage(input: {
  knowledgeBaseId: string;
  sourceWorkPublicId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  baseActivationRevision: number;
  pages: readonly Omit<StagedDocumentPage,
    "pageCandidatePublicId">[];
  stagedAt: string;
}): void {
  if ([input.knowledgeBaseId, input.sourceWorkPublicId,
    input.sourceFilePublicId, input.sourceRevisionPublicId]
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
    throw pageRepositoryError("invalid_input");
  }
}

function uniquePaths(values: readonly string[], limit: number): string[] {
  assertLimit(limit);
  if (values.length > limit || values.some((value) => !value || value.length > 4096)) {
    throw pageRepositoryError("invalid_input");
  }
  return [...new Set(values)].sort();
}

function assertLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
    throw pageRepositoryError("invalid_input");
  }
}

function mapHead(row: HeadRow): GeneratedPageHead {
  return {
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    entryKind: row.entry_kind,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    pageCandidatePublicId: row.page_candidate_public_id,
    objectId: row.object_id,
    checksumSha256: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    activationRevision: Number(row.activation_revision)
  };
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
    && stored.objectId === expected.objectId
    && stored.checksumSha256 === expected.checksumSha256
    && stored.byteCount === expected.byteCount;
}

function pageRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Generated page repository error: ${code}`), { code });
}
