import type { DatabaseClient } from "../../db/client.js";
import type { ModelSuggestions } from "@focowiki/okf";
import type { CanonicalFileRelation, FileRelationEvidenceKind } from
  "../domain/file-relation.js";

export type ActiveGeneratedSourceContext = {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  resourceRevision: number;
  logicalPath: string;
  title: string;
  objectId: string;
  checksumSha256: string;
  byteCount: number;
  contentType: string;
  modelSuggestions: ModelSuggestions | null;
  semanticEntities: readonly {
    label: string;
    kind: string;
    description: string | null;
    confidence: number;
    evidencePaths: readonly string[];
  }[];
};

export function createPostgresDocumentGeneratedContext(sql: DatabaseClient) {
  return {
    async readRevisionSemanticEntities(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicId: string;
      limit: number;
    }) {
      const values = await readSemanticEntities(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        sourceRevisionPublicIds: [input.sourceRevisionPublicId],
        maximumEntities: input.limit
      });
      return values.get(input.sourceRevisionPublicId) ?? [];
    },
    async readKnowledgeBase(input: { knowledgeBaseId: string }) {
      const rows = await sql<Array<{
        public_id: string;
        name: string;
        description: string | null;
      }>>`
        SELECT public_id, name, description
        FROM focowiki.knowledge_bases
        WHERE public_id = ${input.knowledgeBaseId}
          AND deleted_at IS NULL
        LIMIT 1
      `;
      const row = rows[0];
      if (!row) throw generatedContextError("knowledge_base_missing");
      return { id: row.public_id, name: row.name, description: row.description };
    },

    async readActiveSourcePresentation(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
    }): Promise<{ logicalPath: string; sourceRevisionPublicId: string } | null> {
      const rows = await sql<Array<{
        logical_path: string;
        source_revision_public_id: string;
        resource_revision: number | string;
      }>>`
        SELECT presentation.logical_path,
               active.active_source_revision_public_id AS source_revision_public_id
        FROM focowiki.source_file_active_revisions active
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = active.knowledge_base_id
         AND presentation.source_file_public_id = active.source_file_public_id
         AND presentation.source_revision_public_id
           = active.active_source_revision_public_id
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND active.source_file_public_id = ${input.sourceFilePublicId}
          AND active.active_source_revision_public_id IS NOT NULL
        LIMIT 1
      `;
      return rows[0] ? {
        logicalPath: rows[0].logical_path,
        sourceRevisionPublicId: rows[0].source_revision_public_id
      } : null;
    },

    async countPostActivationSources(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
    }): Promise<number> {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.source_file_active_revisions active
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = active.knowledge_base_id
         AND source.public_id = active.source_file_public_id
         AND source.deleted_at IS NULL
        WHERE active.knowledge_base_id = ${input.knowledgeBaseId}
          AND (
            active.active_source_revision_public_id IS NOT NULL
            OR active.source_file_public_id = ${input.sourceFilePublicId}
          )
      `;
      return Number(rows[0]?.count ?? 0);
    },

    async readRecentAvailableDocumentEvents(input: {
      knowledgeBaseId: string;
      excludingSourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly {
      occurredAt: string;
      action: string;
      message: string;
      links: Array<{ path: string; title: string }>;
    }[]> {
      if (input.limit <= 0) return [];
      const excludedSourceFilePublicIds = boundedIds(
        input.excludingSourceFilePublicIds,
        10_000
      );
      const rows = await sql<Array<{
        terminal_at: string | Date;
        logical_path: string;
        title: string;
      }>>`
        SELECT job.terminal_at,
               presentation.logical_path,
               presentation.title
        FROM focowiki.document_processing_jobs job
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = job.knowledge_base_id
         AND active.source_file_public_id = job.source_file_public_id
         AND active.active_source_revision_public_id
           = job.source_revision_public_id
        JOIN focowiki.source_files source
          ON source.knowledge_base_id = active.knowledge_base_id
         AND source.public_id = active.source_file_public_id
         AND source.deleted_at IS NULL
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = job.knowledge_base_id
         AND presentation.source_file_public_id = job.source_file_public_id
         AND presentation.source_revision_public_id = job.source_revision_public_id
        WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
          AND job.state = 'available'
          AND job.terminal_at IS NOT NULL
          AND job.source_file_public_id NOT IN ${sql(
            excludedSourceFilePublicIds.length > 0
              ? excludedSourceFilePublicIds
              : ["document-log-no-exclusion"]
          )}
        ORDER BY job.terminal_at DESC, job.public_id COLLATE "C"
        LIMIT ${input.limit}
      `;
      return rows.map((row) => ({
        occurredAt: normalizeTimestamp(row.terminal_at),
        action: "Updated page",
        message: `Updated pages/${row.logical_path}.`,
        links: [{ path: `pages/${row.logical_path}`, title: row.title }]
      }));
    },

    async countUnaffectedActiveRelations(input: {
      knowledgeBaseId: string;
      affectedSourceFilePublicIds: readonly string[];
    }): Promise<number> {
      const affected = boundedIds(input.affectedSourceFilePublicIds, 10_000);
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.canonical_file_relations relation
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND relation.active AND relation.retired_at IS NULL
          AND relation.first_source_file_public_id NOT IN ${sql(affected)}
          AND relation.second_source_file_public_id NOT IN ${sql(affected)}
      `;
      return Number(rows[0]?.count ?? 0);
    },

    async readActiveRelationPublicIds(input: {
      knowledgeBaseId: string;
      affectedSourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly string[]> {
      const affected = boundedIds(input.affectedSourceFilePublicIds, input.limit);
      const rows = await sql<Array<{ public_id: string }>>`
        SELECT relation.public_id
        FROM focowiki.canonical_file_relations relation
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND relation.active AND relation.retired_at IS NULL
          AND (relation.first_source_file_public_id IN ${sql(affected)}
            OR relation.second_source_file_public_id IN ${sql(affected)})
        ORDER BY relation.public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) {
        throw generatedContextError("relation_limit_exceeded");
      }
      return rows.map((row) => row.public_id);
    },

    async readActiveSources(input: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
      limit: number;
    }): Promise<readonly ActiveGeneratedSourceContext[]> {
      const sourceIds = boundedIds(input.sourceFilePublicIds, input.limit);
      if (sourceIds.length === 0) return [];
      const rows = await sql<Array<{
        source_file_public_id: string;
        source_revision_public_id: string;
        resource_revision: number | string;
        logical_path: string;
        title: string;
        object_id: string;
        checksum_sha256: string;
        byte_count: number | string;
        content_type: string;
        model_suggestions: ModelSuggestions | null;
      }>>`
        SELECT source.public_id AS source_file_public_id,
               source.revision AS resource_revision,
               revision.public_id AS source_revision_public_id,
               presentation.logical_path, presentation.title,
               revision.object_id, revision.checksum_sha256,
               revision.byte_count, revision.content_type,
               presentation.model_suggestions
        FROM focowiki.source_files source
        JOIN focowiki.source_file_active_revisions active
          ON active.knowledge_base_id = source.knowledge_base_id
         AND active.source_file_public_id = source.public_id
        JOIN focowiki.source_revisions revision
          ON revision.knowledge_base_id = active.knowledge_base_id
         AND revision.source_file_public_id = active.source_file_public_id
         AND revision.public_id = active.active_source_revision_public_id
         AND revision.deleted_at IS NULL
        JOIN focowiki.source_revision_presentations presentation
          ON presentation.knowledge_base_id = revision.knowledge_base_id
         AND presentation.source_file_public_id = revision.source_file_public_id
         AND presentation.source_revision_public_id = revision.public_id
        WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
          AND source.public_id IN ${sql(sourceIds)}
          AND source.deleted_at IS NULL
        ORDER BY source.public_id COLLATE "C"
        LIMIT ${input.limit}
      `;
      const entities = await readSemanticEntities(sql, {
        knowledgeBaseId: input.knowledgeBaseId,
        sourceRevisionPublicIds: rows.map((row) => row.source_revision_public_id),
        maximumEntities: Math.min(10_000, input.limit * 1_000)
      });
      return rows.map((row) => ({
        sourceFilePublicId: row.source_file_public_id,
        sourceRevisionPublicId: row.source_revision_public_id,
        resourceRevision: Number(row.resource_revision),
        logicalPath: row.logical_path,
        title: row.title,
        objectId: row.object_id,
        checksumSha256: row.checksum_sha256,
        byteCount: Number(row.byte_count),
        contentType: row.content_type,
        modelSuggestions: row.model_suggestions,
        semanticEntities: entities.get(row.source_revision_public_id) ?? []
      }));
    },

    async readPostActivationRelations(input: {
      knowledgeBaseId: string;
      affectedSourceFilePublicIds: readonly string[];
      replacingSourceFilePublicId: string;
      replacingSourceRevisionPublicId: string;
      invalidatedEvidence: readonly {
        sourceRevisionPublicId: string;
        referenceKind: FileRelationEvidenceKind;
        evidenceChecksumSha256: string;
      }[];
      candidateRelations: readonly CanonicalFileRelation[];
      limit: number;
    }): Promise<readonly CanonicalFileRelation[]> {
      const affected = boundedIds(input.affectedSourceFilePublicIds, input.limit);
      const rows = await sql<Array<{
        relation_public_id: string;
        first_source_file_public_id: string;
        second_source_file_public_id: string;
        relation_kind: "references" | "related";
        evidence_public_id: string;
        source_file_public_id: string;
        source_revision_public_id: string;
        direction: "first_to_second" | "second_to_first";
        evidence_kind: FileRelationEvidenceKind;
        evidence_checksum_sha256: string;
        evidence: Readonly<Record<string, unknown>>;
      }>>`
        SELECT relation.public_id AS relation_public_id,
               relation.first_source_file_public_id,
               relation.second_source_file_public_id,
               relation.relation_kind,
               evidence.public_id AS evidence_public_id,
               evidence.source_file_public_id,
               evidence.source_revision_public_id,
               CASE WHEN evidence.source_file_public_id
                 = relation.first_source_file_public_id
                 THEN 'first_to_second' ELSE 'second_to_first' END AS direction,
               CASE evidence.evidence_kind
                 WHEN 'explicit_reference' THEN 'markdown_link'
                 WHEN 'title_alias' THEN 'stable_alias'
                 ELSE 'semantic'
               END AS evidence_kind,
               evidence.evidence_fingerprint_sha256
                 AS evidence_checksum_sha256,
               evidence.evidence
        FROM focowiki.canonical_file_relations relation
        JOIN focowiki.relation_directed_evidence evidence
          ON evidence.knowledge_base_id = relation.knowledge_base_id
         AND evidence.pair_public_id = relation.pair_public_id
         AND evidence.active AND evidence.retired_at IS NULL
        JOIN focowiki.source_file_active_revisions active_evidence
          ON active_evidence.knowledge_base_id = evidence.knowledge_base_id
         AND active_evidence.source_file_public_id = evidence.source_file_public_id
         AND active_evidence.active_source_revision_public_id
           = evidence.source_revision_public_id
        WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
          AND relation.active AND relation.retired_at IS NULL
          AND EXISTS (
            SELECT 1 FROM focowiki.source_file_active_revisions endpoint
            WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
              AND endpoint.source_file_public_id
                = relation.first_source_file_public_id
              AND endpoint.active_source_revision_public_id
                = relation.first_source_revision_public_id
          )
          AND EXISTS (
            SELECT 1 FROM focowiki.source_file_active_revisions endpoint
            WHERE endpoint.knowledge_base_id = relation.knowledge_base_id
              AND endpoint.source_file_public_id
                = relation.second_source_file_public_id
              AND endpoint.active_source_revision_public_id
                = relation.second_source_revision_public_id
          )
          AND (relation.first_source_file_public_id IN ${sql(affected)}
            OR relation.second_source_file_public_id IN ${sql(affected)})
        ORDER BY relation.public_id COLLATE "C", evidence.public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) throw generatedContextError("relation_limit_exceeded");
      const invalidated = new Set(input.invalidatedEvidence.map((item) => [
        item.sourceRevisionPublicId,
        item.referenceKind,
        item.evidenceChecksumSha256
      ].join("\0")));
      const retained = rows.filter((row) =>
        row.source_file_public_id !== input.replacingSourceFilePublicId
          && !invalidated.has([
            row.source_revision_public_id,
            row.evidence_kind,
            row.evidence_checksum_sha256
          ].join("\0")))
        .map((row): CanonicalFileRelation => ({
          publicId: row.relation_public_id,
          knowledgeBaseId: input.knowledgeBaseId,
          firstSourceFilePublicId: row.first_source_file_public_id,
          secondSourceFilePublicId: row.second_source_file_public_id,
          relationKind: row.relation_kind,
          evidence: {
            publicId: row.evidence_public_id,
            sourceFilePublicId: row.source_file_public_id,
            sourceRevisionPublicId: row.source_revision_public_id,
            direction: row.direction,
            evidenceKind: row.evidence_kind,
            evidenceChecksumSha256: row.evidence_checksum_sha256,
            value: row.evidence
          }
        }));
      return [...new Map([...retained, ...input.candidateRelations]
        .map((relation) => [relation.evidence.publicId, relation])).values()]
        .sort((left, right) => left.evidence.publicId.localeCompare(
          right.evidence.publicId,
          "en"
        ));
    }
  };
}

function normalizeTimestamp(value: string | Date): string {
  const timestamp = value instanceof Date ? value.toISOString() : value;
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw generatedContextError("event_timestamp_invalid");
  }
  return timestamp;
}

async function readSemanticEntities(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    sourceRevisionPublicIds: readonly string[];
    maximumEntities: number;
  }
) {
  if (input.sourceRevisionPublicIds.length === 0) return new Map<string, Array<{
    label: string;
    kind: string;
    description: string | null;
    confidence: number;
    evidencePaths: readonly string[];
  }>>();
  const rows = await sql<Array<{
    source_revision_public_id: string;
    label: string;
    entity_kind: string;
    description: string | null;
    confidence: number | string;
    logical_path: string;
  }>>`
    SELECT observation.source_revision_public_id,
           observation.label, entity.entity_kind,
           observation.description, observation.confidence,
           evidence.logical_path
    FROM focowiki.semantic_entity_observations observation
    JOIN focowiki.semantic_entities entity
      ON entity.knowledge_base_id = observation.knowledge_base_id
     AND entity.semantic_generation_public_id
       = observation.semantic_generation_public_id
     AND entity.public_id = observation.entity_public_id
     AND entity.deleted_at IS NULL
    LEFT JOIN LATERAL (
      SELECT item.logical_path
      FROM focowiki.semantic_mentions mention
      JOIN focowiki.semantic_evidence item
        ON item.knowledge_base_id = mention.knowledge_base_id
       AND item.semantic_generation_public_id
         = mention.semantic_generation_public_id
       AND item.public_id = mention.evidence_public_id
      WHERE mention.knowledge_base_id = observation.knowledge_base_id
        AND mention.semantic_generation_public_id
          = observation.semantic_generation_public_id
        AND mention.entity_public_id = observation.entity_public_id
        AND mention.source_revision_public_id
          = observation.source_revision_public_id
      ORDER BY item.public_id COLLATE "C"
      LIMIT 1
    ) evidence ON true
    WHERE observation.knowledge_base_id = ${input.knowledgeBaseId}
      AND observation.source_revision_public_id
        IN ${sql([...new Set(input.sourceRevisionPublicIds)])}
    ORDER BY observation.source_revision_public_id COLLATE "C",
             observation.entity_public_id COLLATE "C"
    LIMIT ${input.maximumEntities + 1}
  `;
  if (rows.length > input.maximumEntities) {
    throw generatedContextError("semantic_entity_limit_exceeded");
  }
  const result = new Map<string, Array<{
    label: string;
    kind: string;
    description: string | null;
    confidence: number;
    evidencePaths: readonly string[];
  }>>();
  for (const row of rows) {
    const current = result.get(row.source_revision_public_id) ?? [];
    current.push({
      label: row.label,
      kind: row.entity_kind,
      description: row.description,
      confidence: Number(row.confidence),
      evidencePaths: row.logical_path ? [row.logical_path] : []
    });
    result.set(row.source_revision_public_id, current);
  }
  return result;
}

function boundedIds(values: readonly string[], limit: number): string[] {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10_000
    || values.length > limit || values.some((value) => !value
      || Buffer.byteLength(value, "utf8") > 255)) {
    throw generatedContextError("input_invalid");
  }
  return [...new Set(values)].sort();
}

function generatedContextError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document generated context error: ${code}`), { code });
}
