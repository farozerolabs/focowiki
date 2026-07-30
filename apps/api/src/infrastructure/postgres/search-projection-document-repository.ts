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
      if (input.activeEpoch === 0) {
        if (input.indexKind === "content") {
          const rows = await selectFullContentPage(sql, input, {
            cursor: decodeContentCursor(input.cursor),
            limit
          });
          return {
            records: rows.map((row) => mapContentRow(row, input)),
            nextCursor: rows.length === limit
              ? encodeContentCursor(rows.at(-1)!)
              : null
          };
        }
        const rows = await selectFullGraphPage(sql, input, {
          cursor: decodeGraphCursor(input.cursor),
          limit
        });
        return {
          records: rows.map((row) => mapGraphRow(row, input)),
          nextCursor: rows.length === limit
            ? encodeGraphCursor(rows.at(-1)!)
            : null
        };
      }
      const rows = input.indexKind === "content"
        ? await selectContentRecords(sql, input, {
            cursor: input.cursor,
            limit,
            recordKeys: null
          })
        : await selectGraphRecords(sql, input, {
            cursor: input.cursor,
            limit,
            recordKeys: null
          });
      const records = input.indexKind === "content"
        ? (rows as ContentRecordRow[]).map((row) => mapContentRow(row, input))
        : (rows as GraphRecordRow[]).map((row) => mapGraphRow(row, input));
      return {
        records,
        nextCursor: records.length === limit ? records.at(-1)!.key : null
      };
    },

    async loadRecords(input) {
      if (input.recordKeys.length === 0) return [];
      const uniqueKeys = [...new Set(input.recordKeys)];
      const records = input.activeEpoch === 0
        ? input.indexKind === "content"
          ? (await selectFullContentRecords(sql, input, uniqueKeys))
            .map((row) => mapContentRow(row, input))
          : (await selectFullGraphRecords(sql, input, uniqueKeys))
            .map((row) => mapGraphRow(row, input))
        : input.indexKind === "content"
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

async function selectFullContentPage(
  sql: DatabaseClient,
  scope: SearchProjectionDocumentScope,
  page: {
    cursor: ContentPageCursor | null;
    limit: number;
  }
): Promise<ContentRecordRow[]> {
  return sql<ContentRecordRow[]>`
    SELECT
      'content:upsert:' || reference.source_revision_id
        || ':' || reference.path_revision::text
        || ':' || segment.ordinal::text AS record_key,
      'upsert'::text AS action,
      reference.knowledge_base_id,
      reference.source_file_id,
      reference.source_revision_id,
      reference.path_revision,
      reference.logical_path,
      'page'::text AS file_kind,
      nullif(reference.title, '') AS title,
      nullif(segment.heading, '') AS heading,
      segment.normalized_text AS body,
      reference.metadata_json,
      nullif(reference.source_url, '') AS source_url,
      document.source_body_checksum_sha256 AS checksum_sha256,
      segment.ordinal AS segment_ordinal,
      document.segment_count AS segment_total
    FROM focowiki.generation_search_projection_refs reference
    JOIN focowiki.search_projection_documents document
      ON document.knowledge_base_id = reference.knowledge_base_id
     AND document.id = reference.search_document_id
     AND document.lifecycle_state = 'ready'
    JOIN focowiki.search_projection_segments segment
      ON segment.knowledge_base_id = document.knowledge_base_id
     AND segment.document_id = document.id
    WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
      AND reference.generation_id = ${scope.generationId}
      AND (
        ${page.cursor === null}
        OR (
          reference.source_revision_id,
          reference.source_file_id,
          reference.path_revision,
          segment.ordinal
        ) > (
          ${page.cursor?.sourceRevisionId ?? ""},
          ${page.cursor?.sourceFileId ?? ""},
          ${page.cursor?.pathRevision ?? 0}::bigint,
          ${page.cursor?.segmentOrdinal ?? 0}::integer
        )
      )
    ORDER BY
      reference.source_revision_id,
      reference.source_file_id,
      reference.path_revision,
      segment.ordinal
    LIMIT ${page.limit}
  `;
}

async function selectFullGraphPage(
  sql: DatabaseClient,
  scope: SearchProjectionDocumentScope,
  page: {
    cursor: GraphPageCursor | null;
    limit: number;
  }
): Promise<GraphRecordRow[]> {
  return sql<GraphRecordRow[]>`
    SELECT
      'graph:upsert:' || reference.source_file_id AS record_key,
      'upsert'::text AS action,
      reference.knowledge_base_id,
      reference.source_file_id,
      reference.source_revision_id,
      reference.logical_path,
      reference.title,
      nullif(reference.source_url, '') AS source_url,
      term.lexical_text,
      term.exact_terms,
      term.phrase_terms,
      term.explicit_references,
      term.term_fingerprint AS fingerprint
    FROM focowiki.generation_search_projection_refs reference
    JOIN focowiki.source_file_graph_term_documents term
      ON term.knowledge_base_id = reference.knowledge_base_id
     AND term.source_file_id = reference.source_file_id
     AND term.source_revision_id = reference.source_revision_id
    WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
      AND reference.generation_id = ${scope.generationId}
      AND (
        ${page.cursor === null}
        OR reference.source_file_id > ${page.cursor?.sourceFileId ?? ""}
      )
    ORDER BY reference.source_file_id
    LIMIT ${page.limit}
  `;
}

async function selectFullContentRecords(
  sql: DatabaseClient,
  scope: SearchProjectionDocumentScope,
  recordKeys: string[]
): Promise<ContentRecordRow[]> {
  const sourceRevisionIds = recordKeys.map(readContentRecordKey).map(
    (record) => record.sourceRevisionId
  );
  return sql<ContentRecordRow[]>`
    SELECT *
    FROM (
      SELECT
        'content:upsert:' || reference.source_revision_id
          || ':' || reference.path_revision::text
          || ':' || segment.ordinal::text AS record_key,
        'upsert'::text AS action,
        reference.knowledge_base_id,
        reference.source_file_id,
        reference.source_revision_id,
        reference.path_revision,
        reference.logical_path,
        'page'::text AS file_kind,
        nullif(reference.title, '') AS title,
        nullif(segment.heading, '') AS heading,
        segment.normalized_text AS body,
        reference.metadata_json,
        nullif(reference.source_url, '') AS source_url,
        document.source_body_checksum_sha256 AS checksum_sha256,
        segment.ordinal AS segment_ordinal,
        document.segment_count AS segment_total
      FROM focowiki.generation_search_projection_refs reference
      JOIN focowiki.search_projection_documents document
        ON document.knowledge_base_id = reference.knowledge_base_id
       AND document.id = reference.search_document_id
       AND document.lifecycle_state = 'ready'
      JOIN focowiki.search_projection_segments segment
        ON segment.knowledge_base_id = document.knowledge_base_id
       AND segment.document_id = document.id
      WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
        AND reference.generation_id = ${scope.generationId}
        AND reference.source_revision_id = ANY(${sourceRevisionIds})
    ) projected
    WHERE record_key = ANY(${recordKeys})
    ORDER BY record_key
  `;
}

async function selectFullGraphRecords(
  sql: DatabaseClient,
  scope: SearchProjectionDocumentScope,
  recordKeys: string[]
): Promise<GraphRecordRow[]> {
  const sourceFileIds = recordKeys.map(readGraphRecordKey);
  return sql<GraphRecordRow[]>`
    SELECT
      'graph:upsert:' || reference.source_file_id AS record_key,
      'upsert'::text AS action,
      reference.knowledge_base_id,
      reference.source_file_id,
      reference.source_revision_id,
      reference.logical_path,
      reference.title,
      nullif(reference.source_url, '') AS source_url,
      term.lexical_text,
      term.exact_terms,
      term.phrase_terms,
      term.explicit_references,
      term.term_fingerprint AS fingerprint
    FROM focowiki.generation_search_projection_refs reference
    JOIN focowiki.source_file_graph_term_documents term
      ON term.knowledge_base_id = reference.knowledge_base_id
     AND term.source_file_id = reference.source_file_id
     AND term.source_revision_id = reference.source_revision_id
    WHERE reference.knowledge_base_id = ${scope.knowledgeBaseId}
      AND reference.generation_id = ${scope.generationId}
      AND reference.source_file_id = ANY(${sourceFileIds})
      AND 'graph:upsert:' || reference.source_file_id = ANY(${recordKeys})
    ORDER BY record_key
  `;
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

type ContentPageCursor = {
  sourceRevisionId: string;
  sourceFileId: string;
  pathRevision: number;
  segmentOrdinal: number;
};

type GraphPageCursor = {
  sourceFileId: string;
};

function encodeContentCursor(row: ContentRecordRow): string {
  return encodeCursor({
    kind: "content",
    sourceRevisionId: row.source_revision_id,
    sourceFileId: row.source_file_id,
    pathRevision: Number(row.path_revision),
    segmentOrdinal: Number(row.segment_ordinal)
  });
}

function decodeContentCursor(cursor: string | null): ContentPageCursor | null {
  if (cursor === null) return null;
  const value = decodeCursor(cursor);
  if (
    value.kind !== "content"
    || typeof value.sourceRevisionId !== "string"
    || typeof value.sourceFileId !== "string"
    || !Number.isSafeInteger(value.pathRevision)
    || Number(value.pathRevision) <= 0
    || !Number.isSafeInteger(value.segmentOrdinal)
    || Number(value.segmentOrdinal) < 0
  ) {
    throw new Error("Content search projection cursor is invalid");
  }
  return {
    sourceRevisionId: value.sourceRevisionId,
    sourceFileId: value.sourceFileId,
    pathRevision: Number(value.pathRevision),
    segmentOrdinal: Number(value.segmentOrdinal)
  };
}

function encodeGraphCursor(row: GraphRecordRow): string {
  return encodeCursor({
    kind: "graph",
    sourceFileId: row.source_file_id
  });
}

function decodeGraphCursor(cursor: string | null): GraphPageCursor | null {
  if (cursor === null) return null;
  const value = decodeCursor(cursor);
  if (value.kind !== "graph" || typeof value.sourceFileId !== "string") {
    throw new Error("Graph search projection cursor is invalid");
  }
  return { sourceFileId: value.sourceFileId };
}

function encodeCursor(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  try {
    const value = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8")
    ) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("invalid cursor shape");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new Error("Search projection cursor is invalid");
  }
}

function readContentRecordKey(key: string): {
  sourceRevisionId: string;
} {
  const match = /^content:upsert:(.+):\d+:\d+$/u.exec(key);
  if (!match?.[1]) {
    throw new Error("Content search projection record key is invalid");
  }
  return { sourceRevisionId: match[1] };
}

function readGraphRecordKey(key: string): string {
  const match = /^graph:upsert:(.+)$/u.exec(key);
  if (!match?.[1]) {
    throw new Error("Graph search projection record key is invalid");
  }
  return match[1];
}
