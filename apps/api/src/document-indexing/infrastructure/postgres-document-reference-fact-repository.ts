import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentRelationCandidate } from
  "../application/document-relation-candidates.js";
import { metadataAliases } from "./production-document-metadata.js";

export type DocumentReferenceSource = {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  normalizedPath: string;
  title: string;
  aliases: readonly string[];
  sourceType: string | null;
  tags: readonly string[];
};

type SourceRow = {
  knowledge_base_id: string;
  source_file_public_id: string;
  source_revision_public_id: string;
  normalized_path: string;
  title: string;
  metadata: Record<string, unknown>;
};

export function createPostgresDocumentReferenceFactRepository(
  sql: DatabaseClient
) {
  const repository = {
    async replaceRevision(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      identityKeys: readonly string[];
      references: readonly DocumentRelationCandidate[];
    }): Promise<number> {
      validateIdentity(input.knowledgeBaseId);
      validateIdentity(input.sourceFilePublicId);
      validateIdentity(input.sourceRevisionPublicId);
      const references = input.references.filter((item) =>
        item.referenceKind === "markdown_link"
        || item.referenceKind === "okf_metadata").map((item) => ({
        public_id: `source-reference-${createHash("sha256").update(JSON.stringify([
            input.sourceRevisionPublicId,
            item.referenceKind,
            item.normalizedTargetKey,
            item.evidenceChecksumSha256
          ])).digest("hex")}`,
        reference_kind: item.referenceKind,
        normalized_target_key: item.normalizedTargetKey,
        raw_target: item.rawTarget,
        evidence_checksum_sha256: item.evidenceChecksumSha256,
          evidence: item.evidence
        }));
      if (references.length > 512) throw invalid("reference_limit_exceeded");
      const identityKeys = boundedKeys(input.identityKeys);
      await transaction(sql, async (tx) => {
        await tx`
          DELETE FROM focowiki.source_file_identity_keys
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_revision_public_id = ${input.sourceRevisionPublicId}
        `;
        if (identityKeys.length > 0) await tx`
          INSERT INTO focowiki.source_file_identity_keys (
            public_id, knowledge_base_id, source_file_public_id,
            source_revision_public_id, identity_kind,
            normalized_identity_key, state, activation_revision
          )
          SELECT 'source-identity-' || md5(
                   ${input.sourceRevisionPublicId} || E'\\x1f' || desired.key
                 ),
                 ${input.knowledgeBaseId}, ${input.sourceFilePublicId},
                 ${input.sourceRevisionPublicId},
                 split_part(desired.key, ':', 1), desired.key,
                 'staged', NULL
          FROM unnest(${identityKeys}::text[]) AS desired(key)
        `;
        await tx`
          DELETE FROM focowiki.unresolved_file_references
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_revision_public_id = ${input.sourceRevisionPublicId}
        `;
        if (references.length === 0) return;
        await tx`
          INSERT INTO focowiki.unresolved_file_references (
            public_id, knowledge_base_id, source_file_public_id,
            source_revision_public_id, reference_kind,
            normalized_target_key, raw_target,
            evidence_checksum_sha256, evidence, resolution_state,
            resolved_target_source_file_public_id
          )
          SELECT desired.public_id, ${input.knowledgeBaseId},
                 ${input.sourceFilePublicId}, ${input.sourceRevisionPublicId},
                 desired.reference_kind, desired.normalized_target_key,
                 desired.raw_target, desired.evidence_checksum_sha256,
                 desired.evidence, 'pending', NULL
          FROM jsonb_to_recordset(${tx.json(references as never)}::jsonb)
            AS desired(
              public_id text, reference_kind text,
              normalized_target_key text, raw_target text,
              evidence_checksum_sha256 text, evidence jsonb
            )
        `;
      });
      return references.length;
    },

    async findTargetsByIdentityKeys(input: {
      knowledgeBaseId: string;
      identityKeys: readonly string[];
      excludeSourceRevisionPublicId: string | null;
      limit: number;
    }): Promise<readonly DocumentReferenceSource[]> {
      const keys = boundedKeys(input.identityKeys);
      if (keys.length === 0) return [];
      validateLimit(input.limit);
      const rows = await sql<SourceRow[]>`
        WITH eligible AS (${eligibleSources(sql, input.knowledgeBaseId)})
        SELECT DISTINCT ON (eligible.source_file_public_id) eligible.*
        FROM eligible
        JOIN focowiki.source_file_identity_keys identity
          ON identity.knowledge_base_id = eligible.knowledge_base_id
         AND identity.source_file_public_id = eligible.source_file_public_id
         AND identity.source_revision_public_id = eligible.source_revision_public_id
        WHERE (${input.excludeSourceRevisionPublicId}::text IS NULL
          OR eligible.source_revision_public_id
            <> ${input.excludeSourceRevisionPublicId})
          AND identity.normalized_identity_key = ANY(${keys}::text[])
          AND identity.state IN ('staged', 'active')
        ORDER BY eligible.source_file_public_id,
                 eligible.normalized_path COLLATE "C",
                 eligible.source_revision_public_id
        LIMIT ${input.limit}
      `;
      return rows.map(mapSource);
    },

    async findReferencingIdentityKeys(input: {
      knowledgeBaseId: string;
      identityKeys: readonly string[];
      excludeSourceRevisionPublicId: string | null;
      limit: number;
    }): Promise<readonly (DocumentReferenceSource & {
      matchedIdentityKey: string;
      evidence: Readonly<Record<string, unknown>>;
    })[]> {
      const keys = boundedKeys(input.identityKeys);
      if (keys.length === 0) return [];
      validateLimit(input.limit);
      const rows = await sql<Array<SourceRow & {
        matched_identity_key: string;
        evidence: Record<string, unknown>;
      }>>`
        WITH eligible AS (${eligibleSources(sql, input.knowledgeBaseId)})
        SELECT DISTINCT ON (eligible.source_file_public_id)
               eligible.*, fact.normalized_target_key AS matched_identity_key,
               fact.evidence
        FROM eligible
        JOIN focowiki.unresolved_file_references fact
          ON fact.knowledge_base_id = eligible.knowledge_base_id
         AND fact.source_file_public_id = eligible.source_file_public_id
         AND fact.source_revision_public_id = eligible.source_revision_public_id
        WHERE fact.normalized_target_key = ANY(${keys}::text[])
          AND (${input.excludeSourceRevisionPublicId}::text IS NULL
            OR eligible.source_revision_public_id
              <> ${input.excludeSourceRevisionPublicId})
        ORDER BY eligible.source_file_public_id,
                 fact.normalized_target_key COLLATE "C", fact.public_id
        LIMIT ${input.limit}
      `;
      return rows.map((row) => ({
        ...mapSource(row),
        matchedIdentityKey: row.matched_identity_key,
        evidence: structuredClone(row.evidence)
      }));
    },

    async hydrateEligible(input: {
      knowledgeBaseId: string;
      candidates: readonly {
        sourceFilePublicId: string;
        sourceRevisionPublicId: string;
      }[];
      limit: number;
    }): Promise<readonly DocumentReferenceSource[]> {
      validateLimit(input.limit);
      if (input.candidates.length === 0) return [];
      if (input.candidates.length > 256) throw invalid("candidate_limit_exceeded");
      const rows = await sql<SourceRow[]>`
        WITH requested(source_file_public_id, source_revision_public_id, ordinal) AS (
          SELECT item.source_file_public_id, item.source_revision_public_id,
                 item.ordinal
          FROM jsonb_to_recordset(${sql.json(input.candidates.map(
            (item, index) => ({
              source_file_public_id: item.sourceFilePublicId,
              source_revision_public_id: item.sourceRevisionPublicId,
              ordinal: index
            })) as never)}::jsonb)
            AS item(source_file_public_id text,
                    source_revision_public_id text, ordinal integer)
        ), eligible AS (${eligibleSources(sql, input.knowledgeBaseId)})
        SELECT eligible.*
        FROM requested
        JOIN eligible
          ON eligible.source_file_public_id = requested.source_file_public_id
         AND eligible.source_revision_public_id
           = requested.source_revision_public_id
        ORDER BY requested.ordinal
        LIMIT ${input.limit}
      `;
      return rows.map(mapSource);
    }
  };
  return repository;
}

function eligibleSources(sql: DatabaseClient, knowledgeBaseId: string) {
  return sql`
    SELECT DISTINCT ON (presentation.source_file_public_id)
           presentation.knowledge_base_id,
           presentation.source_file_public_id,
           presentation.source_revision_public_id,
           presentation.normalized_path,
           presentation.title,
           presentation.metadata
    FROM focowiki.source_revision_presentations presentation
    JOIN focowiki.source_files source
      ON source.knowledge_base_id = presentation.knowledge_base_id
     AND source.public_id = presentation.source_file_public_id
     AND source.deleted_at IS NULL
    JOIN focowiki.source_revisions revision
      ON revision.knowledge_base_id = presentation.knowledge_base_id
     AND revision.source_file_public_id = presentation.source_file_public_id
     AND revision.public_id = presentation.source_revision_public_id
     AND revision.deleted_at IS NULL
    JOIN focowiki.document_processing_jobs job
      ON job.knowledge_base_id = presentation.knowledge_base_id
     AND job.source_file_public_id = presentation.source_file_public_id
     AND job.source_revision_public_id = presentation.source_revision_public_id
     AND job.state IN ('waiting', 'processing', 'available')
    WHERE presentation.knowledge_base_id = ${knowledgeBaseId}
    ORDER BY presentation.source_file_public_id,
             job.readiness_sequence DESC,
             presentation.source_revision_public_id DESC
  `;
}

function mapSource(row: SourceRow): DocumentReferenceSource {
  const metadata = row.metadata ?? {};
  const type = typeof metadata.type === "string" ? metadata.type.trim() : "";
  const tags = Array.isArray(metadata.tags)
    ? metadata.tags.filter((value): value is string => typeof value === "string")
    : [];
  return {
    knowledgeBaseId: row.knowledge_base_id,
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.source_revision_public_id,
    normalizedPath: row.normalized_path,
    title: row.title,
    aliases: metadataAliases(metadata),
    sourceType: type || null,
    tags
  };
}

function boundedKeys(values: readonly string[]): string[] {
  if (values.length > 512) throw invalid("identity_key_limit_exceeded");
  return [...new Set(values.map((value) => value.normalize("NFKC").trim()
    .toLocaleLowerCase("en-US")).filter((value) => value
      && Buffer.byteLength(value, "utf8") <= 4_096))];
}

function validateIdentity(value: string): void {
  if (!value || Buffer.byteLength(value, "utf8") > 255) {
    throw invalid("identity_invalid");
  }
}

function validateLimit(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > 256) {
    throw invalid("limit_invalid");
  }
}

function invalid(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document reference fact error: ${code}`), { code });
}

function transaction<T>(
  sql: DatabaseClient,
  callback: (tx: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}
