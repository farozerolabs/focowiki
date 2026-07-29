import type {
  SearchProjectionDocumentRepository,
  SearchProjectionDocumentScope
} from "../../application/ports/search-projection-document-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  createContentProjectionRecord,
  createGraphProjectionRecord,
  type ContentProjectionFact,
  type GraphProjectionFact,
  type SearchProjectionAction,
  type SearchProjectionRecord
} from "../../search/search-projection-record.js";

type ContentRecordRow = {
  record_key: string;
  action: SearchProjectionAction;
  knowledge_base_id: string;
  source_file_id: string;
  source_revision_id: string;
  path_revision: number;
  logical_path: string;
  file_kind: string;
  title: string | null;
  heading: string | null;
  body: string;
  metadata_json: Record<string, unknown>;
  source_url: string | null;
  checksum_sha256: string;
  segment_ordinal: number;
  segment_total: number;
};

type GraphRecordRow = {
  record_key: string;
  action: SearchProjectionAction;
  knowledge_base_id: string;
  source_file_id: string;
  source_revision_id: string;
  logical_path: string;
  title: string;
  source_url: string | null;
  lexical_text: string;
  exact_terms: string[];
  phrase_terms: string[];
  explicit_references: string[];
  fingerprint: string;
};

export function createPostgresSearchProjectionDocumentRepository(
  sql: DatabaseClient
): SearchProjectionDocumentRepository {
  return {
    async listRecords(input) {
      const limit = boundedLimit(input.limit);
      const records = input.indexKind === "content"
        ? (await selectContentRecords(sql, input, {
            cursor: input.cursor,
            limit,
            recordKeys: null
          })).map((row) => mapContentRow(row, input))
        : (await selectGraphRecords(sql, input, {
            cursor: input.cursor,
            limit,
            recordKeys: null
          })).map((row) => mapGraphRow(row, input));
      return {
        records,
        nextCursor: records.length === limit ? records.at(-1)!.key : null
      };
    },

    async loadRecords(input) {
      if (input.recordKeys.length === 0) return [];
      const uniqueKeys = [...new Set(input.recordKeys)];
      const records = input.indexKind === "content"
        ? (await selectContentRecords(sql, input, {
            cursor: null,
            limit: null,
            recordKeys: uniqueKeys
          })).map((row) => mapContentRow(row, input))
        : (await selectGraphRecords(sql, input, {
            cursor: null,
            limit: null,
            recordKeys: uniqueKeys
          })).map((row) => mapGraphRow(row, input));
      const byKey = new Map(records.map((record) => [record.key, record]));
      return uniqueKeys.flatMap((key) => {
        const record = byKey.get(key);
        return record ? [record] : [];
      });
    }
  };
}

async function selectContentRecords(
  sql: DatabaseClient,
  scope: SearchProjectionDocumentScope,
  page: {
    cursor: string | null;
    limit: number | null;
    recordKeys: string[] | null;
  }
): Promise<ContentRecordRow[]> {
  const rowLimit = page.limit ?? 10_000;
  return sql<ContentRecordRow[]>`
    WITH target_reference AS MATERIALIZED (
      SELECT reference.*
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
        AND reference.generation_id = ${scope.generationId}
    ), active_reference AS MATERIALIZED (
      SELECT reference.*
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
        AND reference.generation_id = ${scope.activeGenerationId}
    ), changed AS MATERIALIZED (
      SELECT 'upsert'::text AS action, target.*
      FROM target_reference target
      LEFT JOIN active_reference active
        ON active.source_file_id = target.source_file_id
      WHERE ${scope.activeEpoch} = 0
         OR active.source_file_id IS NULL
         OR active.source_revision_id IS DISTINCT FROM target.source_revision_id
         OR active.logical_path IS DISTINCT FROM target.logical_path
         OR active.search_document_id IS DISTINCT FROM target.search_document_id
      UNION ALL
      SELECT 'close'::text AS action, active.*
      FROM active_reference active
      LEFT JOIN target_reference target
        ON target.source_file_id = active.source_file_id
      WHERE ${scope.activeEpoch} > 0
        AND (
          target.source_file_id IS NULL
          OR active.source_revision_id IS DISTINCT FROM target.source_revision_id
          OR active.logical_path IS DISTINCT FROM target.logical_path
          OR active.search_document_id IS DISTINCT FROM target.search_document_id
        )
    ), projected AS MATERIALIZED (
      SELECT
        'content:' || changed.action || ':' || changed.source_revision_id
          || ':' || changed.path_revision::text
          || ':' || segment.ordinal::text AS record_key,
        changed.action,
        changed.knowledge_base_id,
        changed.source_file_id,
        changed.source_revision_id,
        changed.path_revision,
        changed.logical_path,
        'page'::text AS file_kind,
        nullif(changed.title, '') AS title,
        nullif(segment.heading, '') AS heading,
        segment.normalized_text AS body,
        changed.metadata_json,
        nullif(changed.source_url, '') AS source_url,
        document.source_body_checksum_sha256 AS checksum_sha256,
        segment.ordinal AS segment_ordinal,
        document.segment_count AS segment_total
      FROM changed
      JOIN focowiki.search_projection_documents document
        ON document.knowledge_base_id = changed.knowledge_base_id
       AND document.id = changed.search_document_id
       AND document.lifecycle_state = 'ready'
      JOIN focowiki.search_projection_segments segment
        ON segment.knowledge_base_id = document.knowledge_base_id
       AND segment.document_id = document.id
    )
    SELECT *
    FROM projected
    WHERE (${page.cursor}::text IS NULL OR record_key > ${page.cursor})
      AND (
        ${page.recordKeys}::text[] IS NULL
        OR record_key = ANY(${page.recordKeys})
      )
    ORDER BY record_key
    LIMIT ${rowLimit}
  `;
}

async function selectGraphRecords(
  sql: DatabaseClient,
  scope: SearchProjectionDocumentScope,
  page: {
    cursor: string | null;
    limit: number | null;
    recordKeys: string[] | null;
  }
): Promise<GraphRecordRow[]> {
  const rowLimit = page.limit ?? 10_000;
  return sql<GraphRecordRow[]>`
    WITH target_reference AS MATERIALIZED (
      SELECT reference.*
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
        AND reference.generation_id = ${scope.generationId}
    ), active_reference AS MATERIALIZED (
      SELECT reference.*
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
        AND reference.generation_id = ${scope.activeGenerationId}
    ), changed AS MATERIALIZED (
      SELECT 'upsert'::text AS action, target.*
      FROM target_reference target
      LEFT JOIN active_reference active
        ON active.source_file_id = target.source_file_id
      WHERE ${scope.activeEpoch} = 0
         OR active.source_file_id IS NULL
         OR active.source_revision_id IS DISTINCT FROM target.source_revision_id
         OR active.logical_path IS DISTINCT FROM target.logical_path
      UNION ALL
      SELECT 'close'::text AS action, active.*
      FROM active_reference active
      LEFT JOIN target_reference target
        ON target.source_file_id = active.source_file_id
      WHERE ${scope.activeEpoch} > 0
        AND (
          target.source_file_id IS NULL
          OR active.source_revision_id IS DISTINCT FROM target.source_revision_id
          OR active.logical_path IS DISTINCT FROM target.logical_path
        )
    ), projected AS MATERIALIZED (
      SELECT
        'graph:' || changed.action || ':' || changed.source_file_id AS record_key,
        changed.action,
        changed.knowledge_base_id,
        changed.source_file_id,
        changed.source_revision_id,
        changed.logical_path,
        changed.title,
        nullif(changed.source_url, '') AS source_url,
        term.lexical_text,
        term.exact_terms,
        term.phrase_terms,
        term.explicit_references,
        term.term_fingerprint AS fingerprint
      FROM changed
      JOIN focowiki.source_file_graph_term_documents term
        ON term.knowledge_base_id = changed.knowledge_base_id
       AND term.source_file_id = changed.source_file_id
       AND term.source_revision_id = changed.source_revision_id
    )
    SELECT *
    FROM projected
    WHERE (${page.cursor}::text IS NULL OR record_key > ${page.cursor})
      AND (
        ${page.recordKeys}::text[] IS NULL
        OR record_key = ANY(${page.recordKeys})
      )
    ORDER BY record_key
    LIMIT ${rowLimit}
  `;
}

function mapContentRow(
  row: ContentRecordRow,
  scope: SearchProjectionDocumentScope
): SearchProjectionRecord {
  const fact: ContentProjectionFact = {
    action: row.action,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    pathRevision: Number(row.path_revision),
    logicalPath: row.logical_path,
    fileKind: row.file_kind,
    title: row.title,
    heading: row.heading,
    body: row.body,
    metadata: row.metadata_json,
    sourceUrl: row.source_url,
    checksumSha256: row.checksum_sha256,
    segmentOrdinal: Number(row.segment_ordinal),
    segmentTotal: Number(row.segment_total),
    activeEpoch: scope.activeEpoch,
    pendingEpoch: scope.pendingEpoch
  };
  return createContentProjectionRecord(fact);
}

function mapGraphRow(
  row: GraphRecordRow,
  scope: SearchProjectionDocumentScope
): SearchProjectionRecord {
  const fact: GraphProjectionFact = {
    action: row.action,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    logicalPath: row.logical_path,
    title: row.title,
    sourceUrl: row.source_url,
    lexicalText: row.lexical_text,
    exactTerms: row.exact_terms,
    phraseTerms: row.phrase_terms,
    explicitReferences: row.explicit_references,
    fingerprint: row.fingerprint,
    activeEpoch: scope.activeEpoch,
    pendingEpoch: scope.pendingEpoch
  };
  return createGraphProjectionRecord(fact);
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Search projection scan limit must be a positive integer");
  }
  return Math.min(value, 2_000);
}
