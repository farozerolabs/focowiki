import type { DatabaseClient } from "../../db/client.js";
import { posix } from "node:path";
import {
  portableByFileGraphPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import type { DocumentTermBucket } from
  "../application/document-term-routing.js";
import {
  createPostgresDocumentGraphProjectionReader
} from
  "./postgres-document-graph-projection-reader.js";

const MAXIMUM_TERM_RECORDS = 100_000;
const MAXIMUM_TERM_PARTS = 10_000;
const MAXIMUM_DIRECTORY_RECORDS = 10_000;
const MAXIMUM_ROOT_RECORDS = 100_000;
const MAXIMUM_CHECKSUM_PATHS = 100_000;

export function createPostgresDocumentMachineProjectionReader(
  sql: DatabaseClient
) {
  const graphProjection = createPostgresDocumentGraphProjectionReader(sql);
  return {
    ...graphProjection,
    async readGeneratedPageChecksums(input: {
      knowledgeBaseId: string;
      logicalPaths: readonly string[];
    }) {
      const logicalPaths = sortedUnique(input.logicalPaths);
      if (logicalPaths.length > MAXIMUM_CHECKSUM_PATHS) {
        throw projectionReaderError("generated_checksum_path_limit_exceeded");
      }
      if (logicalPaths.length === 0) return [];
      return sql<Array<{ logical_path: string; checksum_sha256: string }>>`
        SELECT logical_path, checksum_sha256
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND logical_path IN ${sql(logicalPaths)}
        ORDER BY logical_path COLLATE "C"
        LIMIT ${MAXIMUM_CHECKSUM_PATHS}
      `.then((rows) => rows.map((row) => ({
        logicalPath: row.logical_path,
        checksumSha256: row.checksum_sha256
      })));
    },

    async readRootProjectionState(input: {
      knowledgeBaseId: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
      logLimit: number;
    }) {
      const includedSourceRevisionPublicIds = sortedUnique(
        input.includedSourceRevisionPublicIds ?? []);
      const excludedActiveSourceFilePublicIds = sortedUnique(
        input.excludedActiveSourceFilePublicIds ?? []);
      const [knowledgeBases, records, graph, previousLogs] = await Promise.all([
        sql<Array<{ public_id: string; name: string; description: string | null }>>`
          SELECT public_id, name, description
          FROM focowiki.knowledge_bases
          WHERE public_id = ${input.knowledgeBaseId}
            AND deleted_at IS NULL
          LIMIT 1
        `,
        sql<Array<{
          source_file_public_id: string;
          source_revision_public_id: string;
          logical_path: string;
          title: string;
          created_at: Date | string;
        }>>`
          SELECT record.source_file_public_id,
                 record.source_revision_public_id,
                 record.logical_path, record.title, record.created_at
          FROM focowiki.document_projection_records record
          WHERE record.knowledge_base_id = ${input.knowledgeBaseId}
            AND (record.source_revision_public_id
                   = ANY(${includedSourceRevisionPublicIds}::text[])
              OR (record.active AND record.source_file_public_id
                   <> ALL(${excludedActiveSourceFilePublicIds}::text[])))
          ORDER BY record.normalized_path COLLATE "C"
          LIMIT ${MAXIMUM_ROOT_RECORDS + 1}
        `,
        graphProjection.readGraphCatalogState({
          knowledgeBaseId: input.knowledgeBaseId,
          includedSourceRevisionPublicIds,
          excludedActiveSourceFilePublicIds
        }),
        input.logLimit > 0 ? sql<Array<{
          terminal_at: Date | string;
          logical_path: string;
          title: string;
        }>>`
          SELECT job.terminal_at, record.logical_path, record.title
          FROM focowiki.document_processing_jobs job
          JOIN focowiki.document_projection_records record
            ON record.knowledge_base_id = job.knowledge_base_id
           AND record.source_file_public_id = job.source_file_public_id
           AND record.source_revision_public_id = job.source_revision_public_id
           AND record.active
          WHERE job.knowledge_base_id = ${input.knowledgeBaseId}
            AND job.state = 'available'
            AND job.terminal_at IS NOT NULL
            AND job.source_file_public_id
                  <> ALL(${excludedActiveSourceFilePublicIds}::text[])
          ORDER BY job.terminal_at DESC, job.public_id COLLATE "C"
          LIMIT ${Math.min(input.logLimit, 10_000)}
        ` : Promise.resolve([])
      ]);
      const knowledgeBase = knowledgeBases[0];
      if (!knowledgeBase) throw projectionReaderError("knowledge_base_missing");
      if (records.length > MAXIMUM_ROOT_RECORDS) {
        throw projectionReaderError("root_projection_record_limit_exceeded");
      }
      const included = new Set(includedSourceRevisionPublicIds);
      const topLevelEntries = new Set(records.map((record) => {
        const first = record.logical_path.split("/")[0]!;
        return record.logical_path.includes("/") ? `directory:${first}`
          : `file:${record.source_file_public_id}`;
      }));
      return {
        knowledgeBase: {
          id: knowledgeBase.public_id,
          name: knowledgeBase.name,
          description: knowledgeBase.description
        },
        sourceFileCount: new Set(records.map((record) =>
          record.source_file_public_id)).size,
        graphEdgeCount: graph.relationshipCount,
        rootEntryCount: topLevelEntries.size,
        currentLogEntries: records.filter((record) =>
          included.has(record.source_revision_public_id)).map((record) => ({
            occurredAt: normalizeTimestamp(record.created_at),
            action: "Updated page",
            message: `Updated pages/${record.logical_path}.`,
            links: [{ path: `pages/${record.logical_path}`, title: record.title }]
          })),
        previousLogEntries: previousLogs.map((record) => ({
          occurredAt: normalizeTimestamp(record.terminal_at),
          action: "Updated page",
          message: `Updated pages/${record.logical_path}.`,
          links: [{ path: `pages/${record.logical_path}`, title: record.title }]
        }))
      };
    },
    async readNavigationTermBucketState(input: {
      knowledgeBaseId: string;
      affectedSourceFilePublicIds: readonly string[];
    }): Promise<{
      catalogBuckets: DocumentTermBucket[];
      affectedBuckets: DocumentTermBucket[];
    }> {
      const affectedSourceFilePublicIds = sortedUnique(
        input.affectedSourceFilePublicIds);
      const rows = await sql<Array<{
        bucket: string;
        affected: boolean;
        unaffected: boolean;
      }>>`
        SELECT term.bucket,
               bool_or(record.source_file_public_id
                 = ANY(${affectedSourceFilePublicIds}::text[])) AS affected,
               bool_or(record.source_file_public_id
                 <> ALL(${affectedSourceFilePublicIds}::text[])) AS unaffected
        FROM focowiki.document_navigation_terms term
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = term.knowledge_base_id
         AND record.source_revision_public_id = term.source_revision_public_id
        WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
          AND record.active
        GROUP BY term.bucket
        ORDER BY term.bucket COLLATE "C"
      `;
      if (rows.some((row) => !isDocumentTermBucket(row.bucket))) {
        throw projectionReaderError("navigation_term_bucket_invalid");
      }
      return {
        catalogBuckets: rows.filter((row) => row.unaffected)
          .map((row) => row.bucket as DocumentTermBucket),
        affectedBuckets: rows.filter((row) => row.affected)
          .map((row) => row.bucket as DocumentTermBucket)
      };
    },

    async listNavigationTermBucketsForSources(input: {
      knowledgeBaseId: string;
      sourceFilePublicIds: readonly string[];
    }): Promise<DocumentTermBucket[]> {
      const sourceFilePublicIds = sortedUnique(input.sourceFilePublicIds);
      if (sourceFilePublicIds.length === 0) return [];
      if (sourceFilePublicIds.length > MAXIMUM_DIRECTORY_RECORDS) {
        throw projectionReaderError("navigation_term_source_limit_exceeded");
      }
      const rows = await sql<Array<{ bucket: string }>>`
        SELECT DISTINCT term.bucket COLLATE "C" AS bucket
        FROM focowiki.document_navigation_terms term
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = term.knowledge_base_id
         AND record.source_revision_public_id = term.source_revision_public_id
        WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
          AND record.source_file_public_id
                = ANY(${sourceFilePublicIds}::text[])
        ORDER BY bucket
        LIMIT 7
      `;
      if (rows.length > 6 || rows.some((row) =>
        !isDocumentTermBucket(row.bucket))) {
        throw projectionReaderError("navigation_term_bucket_invalid");
      }
      return rows.map((row) => row.bucket as DocumentTermBucket);
    },

    async readNavigationTermCatalogState(input: {
      knowledgeBaseId: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }): Promise<{ buckets: DocumentTermBucket[] }> {
      const includedSourceRevisionPublicIds = sortedUnique(
        input.includedSourceRevisionPublicIds ?? []);
      const excludedActiveSourceFilePublicIds = sortedUnique(
        input.excludedActiveSourceFilePublicIds ?? []);
      const rows = await sql<Array<{ bucket: string }>>`
        SELECT DISTINCT term.bucket COLLATE "C" AS bucket
        FROM focowiki.document_navigation_terms term
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = term.knowledge_base_id
         AND record.source_revision_public_id = term.source_revision_public_id
        WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
          AND (record.source_revision_public_id
                 = ANY(${includedSourceRevisionPublicIds}::text[])
            OR (record.active AND record.source_file_public_id
                 <> ALL(${excludedActiveSourceFilePublicIds}::text[])))
        ORDER BY bucket
        LIMIT 7
      `;
      if (rows.length > 6 || rows.some((row) =>
        !isDocumentTermBucket(row.bucket))) {
        throw projectionReaderError("navigation_term_catalog_invalid");
      }
      return { buckets: rows.map((row) => row.bucket as DocumentTermBucket) };
    },

    async readDocumentDirectoryState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const includedSourceRevisionPublicIds = sortedUnique(
        input.includedSourceRevisionPublicIds ?? []);
      const excludedActiveSourceFilePublicIds = sortedUnique(
        input.excludedActiveSourceFilePublicIds ?? []);
      const rows = await sql<Array<{
        page_path: string;
        title: string;
        summary: string;
        metadata: Record<string, unknown>;
        headings: string[];
        entities: string[];
        content_type: string;
        checksum_sha256: string;
        byte_count: number | string;
        relationship_count: number | string;
      }>>`
        SELECT membership.page_path, record.title, record.summary,
               record.metadata, record.headings, record.entities,
               record.content_type, record.checksum_sha256, record.byte_count,
               0 AS relationship_count
        FROM focowiki.document_semantic_directory_memberships membership
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = membership.knowledge_base_id
         AND record.source_revision_public_id = membership.source_revision_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND membership.directory_path = ${input.scopePath}
          AND position('/' in substring(membership.page_path
                from char_length(${input.scopePath}) + 2)) = 0
          AND (record.source_revision_public_id
                 = ANY(${includedSourceRevisionPublicIds}::text[])
            OR (record.active AND record.source_file_public_id
                 <> ALL(${excludedActiveSourceFilePublicIds}::text[])))
        ORDER BY record.normalized_path COLLATE "C"
      `;
      const relationshipState = await graphProjection
        .readPerFileGraphDirectoryState({
          knowledgeBaseId: input.knowledgeBaseId,
          scopePath: input.scopePath,
          includedSourceRevisionPublicIds,
          excludedActiveSourceFilePublicIds
        });
      const relationshipPagePaths = new Set(
        relationshipState.relationshipPagePaths);
      const descendantRows = await sql<Array<{ directory_path: string }>>`
        SELECT DISTINCT (
          ${input.scopePath} || '/' || split_part(
            substring(membership.directory_path
              from char_length(${input.scopePath}) + 2), '/', 1
          )
        ) COLLATE "C" AS directory_path
        FROM focowiki.document_semantic_directory_memberships membership
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = membership.knowledge_base_id
         AND record.source_revision_public_id = membership.source_revision_public_id
        WHERE membership.knowledge_base_id = ${input.knowledgeBaseId}
          AND left(membership.directory_path, char_length(${input.scopePath}) + 1)
            = ${`${input.scopePath}/`}
          AND (record.source_revision_public_id
                 = ANY(${includedSourceRevisionPublicIds}::text[])
            OR (record.active AND record.source_file_public_id
                 <> ALL(${excludedActiveSourceFilePublicIds}::text[])))
        ORDER BY directory_path
      `;
      const machineDirectory = portableIndexDirectoryPath(input.scopePath);
      const headRows = await sql<Array<{ logical_path: string }>>`
        SELECT logical_path
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND left(normalized_path, char_length(${machineDirectory}) + 1)
            = ${`${machineDirectory}/`}
          AND position('/' in substring(normalized_path
                from char_length(${machineDirectory}) + 2)) = 0
          AND right(normalized_path, 5) = '.json'
        ORDER BY normalized_path COLLATE "C"
      `;
      return {
        records: rows.map((row) => documentRecord({
          ...row,
          relationship_count: relationshipPagePaths.has(row.page_path) ? 1 : 0
        })),
        childDirectories: descendantRows.map(({ directory_path: scopePath }) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${portableIndexDirectoryPath(scopePath)}/index.json`
        })),
        resourcePaths: headRows.map((row) => row.logical_path).filter((path) =>
          posix.basename(path) !== "index.json")
      };
    },

    async listNavigationTermRecords(input: {
      knowledgeBaseId: string;
      bucket: DocumentTermBucket;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }): Promise<ReadonlyArray<Record<string, unknown>>> {
      const includedSourceRevisionPublicIds = sortedUnique(
        input.includedSourceRevisionPublicIds ?? []);
      const excludedActiveSourceFilePublicIds = sortedUnique(
        input.excludedActiveSourceFilePublicIds ?? []);
      return sql<Array<{ term: string; postings: unknown }>>`
        SELECT term.term,
               jsonb_agg(
                 jsonb_build_object(
                   'path', posting.page_path,
                   'fields', posting.fields
                 ) ORDER BY posting.page_path COLLATE "C"
               ) AS postings
        FROM focowiki.document_navigation_terms term
        JOIN focowiki.document_navigation_postings posting
          ON posting.knowledge_base_id = term.knowledge_base_id
         AND posting.source_revision_public_id = term.source_revision_public_id
         AND posting.term = term.term
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = term.knowledge_base_id
         AND record.source_revision_public_id = term.source_revision_public_id
        WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
          AND term.bucket = ${input.bucket}
          AND (record.source_revision_public_id
                 = ANY(${includedSourceRevisionPublicIds}::text[])
            OR (record.active AND record.source_file_public_id
                 <> ALL(${excludedActiveSourceFilePublicIds}::text[])))
        GROUP BY term.term
        ORDER BY term.term COLLATE "C"
        LIMIT ${MAXIMUM_TERM_RECORDS + 1}
      `.then((rows) => {
        if (rows.length > MAXIMUM_TERM_RECORDS) {
          throw projectionReaderError("navigation_term_record_limit_exceeded");
        }
        return rows.map((row) => ({
          term: row.term,
          postings: Array.isArray(row.postings) ? row.postings : []
        }));
      });
    },

    async listTermPartPaths(input: {
      knowledgeBaseId: string;
      bucket: DocumentTermBucket;
    }): Promise<readonly string[]> {
      const prefix = `_index/terms/${input.bucket}/${input.bucket}-terms-part-`;
      const rows = await sql<Array<{ logical_path: string }>>`
        SELECT logical_path
        FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND left(normalized_path, char_length(${prefix})) = ${prefix}
          AND normalized_path LIKE '%.json'
        ORDER BY normalized_path COLLATE "C"
        LIMIT ${MAXIMUM_TERM_PARTS + 1}
      `;
      if (rows.length > MAXIMUM_TERM_PARTS) {
        throw projectionReaderError("navigation_term_part_limit_exceeded");
      }
      return rows.map((row) => row.logical_path);
    }
  };
}

function documentRecord(row: {
  page_path: string;
  title: string;
  summary: string;
  metadata: Record<string, unknown>;
  headings: string[];
  entities: string[];
  content_type: string;
  checksum_sha256: string;
  byte_count: number | string;
  relationship_count: number | string;
}): Record<string, unknown> {
  const path = row.page_path;
  return {
    path,
    title: row.title,
    summary: row.summary,
    type: metadataString(row.metadata, "type") ?? "document",
    ...(metadataString(row.metadata, "description")
      ? { description: metadataString(row.metadata, "description") } : {}),
    subjects: metadataStrings(row.metadata, "subjects"),
    tags: metadataStrings(row.metadata, "tags"),
    metadata: row.metadata,
    headings: row.headings,
    keywords: metadataStrings(row.metadata, "keywords"),
    ...(metadataString(row.metadata, "language")
      ? { language: metadataString(row.metadata, "language") } : {}),
    entities: row.entities,
    contentType: row.content_type,
    checksumSha256: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    relationshipCount: Number(row.relationship_count),
    ...(Number(row.relationship_count) > 0
      ? { graphPath: portableByFileGraphPath(path) } : {})
  };
}

function metadataString(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function metadataStrings(
  metadata: Readonly<Record<string, unknown>>,
  key: string
): string[] {
  const value = metadata[key];
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return Array.isArray(value) ? value.filter((item): item is string =>
    typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim()) : [];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function isDocumentTermBucket(value: string): value is DocumentTermBucket {
  return ["latin", "han", "kana", "hangul", "number", "other"]
    .includes(value);
}

function projectionReaderError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Document machine projection reader error: ${code}`),
    { code }
  );
}

function normalizeTimestamp(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw projectionReaderError("projection_timestamp_invalid");
  }
  return date.toISOString();
}
