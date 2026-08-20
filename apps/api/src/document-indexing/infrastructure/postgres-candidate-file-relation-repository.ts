import type { DatabaseClient } from "../../db/client.js";
import type {
  CanonicalFileRelation,
  FileRelationEvidenceKind
} from "../domain/file-relation.js";
import {
  assertRepositoryIdentity,
  uniqueBoundedStrings
} from "./document-repository-validation.js";
import {
  visibleDocumentGraphEvidence,
  visibleDocumentGraphRecord,
  visibleDocumentGraphRelation
} from "./postgres-document-graph-visibility.js";

type RelationRow = {
  relation_public_id: string;
  knowledge_base_id: string;
  first_source_file_public_id: string;
  second_source_file_public_id: string;
  relation_kind: "references" | "related";
  evidence_public_id: string;
  evidence_source_file_public_id: string;
  evidence_source_revision_public_id: string;
  evidence_kind: "explicit_reference" | "title_alias" | "first_layer" | "graphrag";
  evidence_fingerprint_sha256: string;
  evidence: Record<string, unknown>;
};

export function createPostgresCandidateFileRelationRepository(sql: DatabaseClient) {
  return {
    async listPublicIdsForPairs(input: {
      knowledgeBaseId: string;
      pairPublicIds: readonly string[];
      limit: number;
    }): Promise<readonly string[]> {
      const pairPublicIds = uniqueBoundedStrings(
        input.pairPublicIds,
        "pair_public_ids",
        input.limit,
        255
      );
      if (pairPublicIds.length === 0) return [];
      const rows = await sql<Array<{ public_id: string }>>`
        SELECT DISTINCT relation.public_id COLLATE "C" AS public_id
        FROM focowiki.relation_candidate_pairs pair
        JOIN focowiki.canonical_file_relations relation
          ON relation.knowledge_base_id = pair.knowledge_base_id
         AND relation.first_source_revision_public_id
           = pair.first_source_revision_public_id
         AND relation.second_source_revision_public_id
           = pair.second_source_revision_public_id
         AND relation.retired_at IS NULL
        WHERE pair.knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND pair.public_id IN ${sql(pairPublicIds)}
        ORDER BY public_id
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw relationRepositoryError("candidate_relation_limit_exceeded");
      }
      return rows.map((row) => row.public_id);
    },

    async listActivePublicIds(input: {
      knowledgeBaseId: string;
      affectedSourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly string[]> {
      const ids = uniqueBoundedStrings(
        input.affectedSourceFilePublicIds,
        "affected_source_file_public_ids",
        input.limit,
        255
      );
      if (ids.length === 0) return [];
      const rows = await sql<Array<{ public_id: string }>>`
        SELECT public_id
        FROM focowiki.canonical_file_relations
        WHERE knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND active AND retired_at IS NULL
          AND (first_source_file_public_id IN ${sql(ids)}
            OR second_source_file_public_id IN ${sql(ids)})
        ORDER BY public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw Object.assign(new Error("Active relation limit exceeded"), {
          code: "candidate_relation_limit_exceeded"
        });
      }
      return rows.map((row) => row.public_id);
    },

    async listRenderable(input: {
      knowledgeBaseId: string;
      currentSourceFilePublicId: string;
      currentSourceRevisionPublicId: string;
      affectedSourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly CanonicalFileRelation[]> {
      const ids = uniqueBoundedStrings(
        input.affectedSourceFilePublicIds,
        "affected_source_file_public_ids",
        input.limit,
        255
      );
      if (ids.length === 0) return [];
      const currentSourceFilePublicId = assertRepositoryIdentity(
        input.currentSourceFilePublicId,
        "source_file_public_id"
      );
      const currentSourceRevisionPublicId = assertRepositoryIdentity(
        input.currentSourceRevisionPublicId,
        "source_revision_public_id"
      );
      const rows = await sql<RelationRow[]>`
        SELECT relation.public_id AS relation_public_id,
               relation.knowledge_base_id,
               relation.first_source_file_public_id,
               relation.second_source_file_public_id,
               relation.relation_kind,
               evidence.public_id AS evidence_public_id,
               evidence.source_file_public_id AS evidence_source_file_public_id,
               evidence.source_revision_public_id AS evidence_source_revision_public_id,
               evidence.evidence_kind, evidence.evidence_fingerprint_sha256,
               evidence.evidence
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND evidence.retired_at IS NULL
        JOIN focowiki.source_file_active_revisions first_active
          ON first_active.knowledge_base_id = relation.knowledge_base_id
         AND first_active.source_file_public_id
           = relation.first_source_file_public_id
        JOIN focowiki.source_file_active_revisions second_active
          ON second_active.knowledge_base_id = relation.knowledge_base_id
         AND second_active.source_file_public_id
           = relation.second_source_file_public_id
        WHERE relation.knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND relation.retired_at IS NULL
          AND (relation.first_source_file_public_id IN ${sql(ids)}
            OR relation.second_source_file_public_id IN ${sql(ids)})
          AND relation.first_source_revision_public_id = CASE
            WHEN relation.first_source_file_public_id = ${currentSourceFilePublicId}
            THEN ${currentSourceRevisionPublicId}
            ELSE first_active.active_source_revision_public_id
          END
          AND relation.second_source_revision_public_id = CASE
            WHEN relation.second_source_file_public_id = ${currentSourceFilePublicId}
            THEN ${currentSourceRevisionPublicId}
            ELSE second_active.active_source_revision_public_id
          END
        ORDER BY relation.public_id, evidence.public_id
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw Object.assign(new Error("Candidate file relation limit exceeded"), {
          code: "candidate_relation_limit_exceeded"
        });
      }
      return rows.map(mapRelation);
    },

    async listVisibleForSource(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      includedSourceRevisionPublicIds: readonly string[];
      excludedActiveSourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly CanonicalFileRelation[]> {
      if (!Number.isSafeInteger(input.limit) || input.limit < 1
        || input.limit > 10_000) {
        throw relationRepositoryError("invalid_limit");
      }
      const included = uniqueBoundedStrings(
        input.includedSourceRevisionPublicIds,
        "included_source_revision_public_ids",
        input.limit,
        255
      );
      const excluded = uniqueBoundedStrings(
        input.excludedActiveSourceFilePublicIds,
        "excluded_active_source_file_public_ids",
        input.limit,
        255
      );
      const sourceFilePublicId = assertRepositoryIdentity(
        input.sourceFilePublicId,
        "source_file_public_id"
      );
      const rows = await sql<RelationRow[]>`
        SELECT relation.public_id AS relation_public_id,
               relation.knowledge_base_id,
               relation.first_source_file_public_id,
               relation.second_source_file_public_id,
               relation.relation_kind,
               evidence.public_id AS evidence_public_id,
               evidence.source_file_public_id AS evidence_source_file_public_id,
               evidence.source_revision_public_id AS evidence_source_revision_public_id,
               evidence.evidence_kind, evidence.evidence_fingerprint_sha256,
               evidence.evidence
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND (${visibleDocumentGraphEvidence(sql, included, excluded)})
        JOIN focowiki.document_projection_records first_record
          ON first_record.knowledge_base_id = relation.knowledge_base_id
         AND first_record.source_revision_public_id
           = relation.first_source_revision_public_id
         AND (${visibleDocumentGraphRecord(sql, "first_record", included, excluded)})
        JOIN focowiki.document_projection_records second_record
          ON second_record.knowledge_base_id = relation.knowledge_base_id
         AND second_record.source_revision_public_id
           = relation.second_source_revision_public_id
         AND (${visibleDocumentGraphRecord(sql, "second_record", included, excluded)})
        WHERE relation.knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND (relation.first_source_file_public_id = ${sourceFilePublicId}
            OR relation.second_source_file_public_id = ${sourceFilePublicId})
          AND (${visibleDocumentGraphRelation(sql, included, excluded)})
        ORDER BY relation.public_id COLLATE "C", evidence.public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw relationRepositoryError("candidate_relation_limit_exceeded");
      }
      return rows.map(mapRelation);
    }
  };
}

function relationRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Candidate relation repository error: ${code}`), {
    code
  });
}

function mapRelation(row: RelationRow): CanonicalFileRelation {
  const sourceIsFirst = row.evidence_source_file_public_id
    === row.first_source_file_public_id;
  return {
    publicId: row.relation_public_id,
    knowledgeBaseId: row.knowledge_base_id,
    firstSourceFilePublicId: row.first_source_file_public_id,
    secondSourceFilePublicId: row.second_source_file_public_id,
    relationKind: row.relation_kind,
    evidence: {
      publicId: row.evidence_public_id,
      sourceFilePublicId: row.evidence_source_file_public_id,
      sourceRevisionPublicId: row.evidence_source_revision_public_id,
      direction: sourceIsFirst ? "first_to_second" : "second_to_first",
      evidenceKind: evidenceKind(row.evidence_kind),
      evidenceChecksumSha256: row.evidence_fingerprint_sha256,
      value: row.evidence
    }
  };
}

function evidenceKind(value: RelationRow["evidence_kind"]): FileRelationEvidenceKind {
  if (value === "explicit_reference") return "markdown_link";
  if (value === "title_alias") return "stable_alias";
  return "semantic";
}
