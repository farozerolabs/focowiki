import type { DatabaseClient } from "../../db/client.js";
import { comparePortableRecordKeys } from "@focowiki/okf";
import { DOCUMENT_TERM_BUCKETS, type DocumentTermBucket } from
  "../application/document-term-routing.js";

const TERM_RECORD_PAGE_SIZE = 10_000;
const MAXIMUM_DIRECTORY_RECORDS = 10_000;

export function createPostgresDocumentNavigationTermReader(sql: DatabaseClient) {
  return {
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
        bucket: string; affected: boolean; unaffected: boolean;
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
        throw termReaderError("navigation_term_bucket_invalid");
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
        throw termReaderError("navigation_term_source_limit_exceeded");
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
        throw termReaderError("navigation_term_bucket_invalid");
      }
      return rows.map((row) => row.bucket as DocumentTermBucket);
    },
    async readNavigationTermCatalogState(input: {
      knowledgeBaseId: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }): Promise<{ buckets: DocumentTermBucket[] }> {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      const rows = await sql<Array<{ bucket: string }>>`
        SELECT DISTINCT term.bucket COLLATE "C" AS bucket
        FROM focowiki.document_navigation_terms term
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = term.knowledge_base_id
         AND record.source_revision_public_id = term.source_revision_public_id
        WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
          AND (record.source_revision_public_id = ANY(${included}::text[])
            OR (record.active AND record.source_file_public_id
                 <> ALL(${excluded}::text[])))
        ORDER BY bucket
        LIMIT 7
      `;
      if (rows.length > 6 || rows.some((row) =>
        !isDocumentTermBucket(row.bucket))) {
        throw termReaderError("navigation_term_catalog_invalid");
      }
      return { buckets: rows.map((row) => row.bucket as DocumentTermBucket) };
    },
    async readNavigationTermCatalogDeltaState(input: {
      knowledgeBaseId: string;
      buckets: readonly DocumentTermBucket[];
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }): Promise<readonly Readonly<{
      bucket: DocumentTermBucket;
      present: boolean;
    }>[]> {
      const buckets = sortedUnique(input.buckets);
      if (buckets.length === 0) return [];
      if (buckets.length > DOCUMENT_TERM_BUCKETS.length
        || buckets.some((bucket) => !isDocumentTermBucket(bucket))) {
        throw termReaderError("navigation_term_catalog_delta_invalid");
      }
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      const rows = await sql<Array<{ bucket: string; present: boolean }>>`
        SELECT desired.bucket,
               EXISTS (
                 SELECT 1
                 FROM focowiki.document_navigation_terms term
                 JOIN focowiki.document_projection_records record
                   ON record.knowledge_base_id = term.knowledge_base_id
                  AND record.source_revision_public_id
                        = term.source_revision_public_id
                 WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
                   AND term.bucket = desired.bucket
                   AND (record.source_revision_public_id
                          = ANY(${included}::text[])
                     OR (record.active AND record.source_file_public_id
                          <> ALL(${excluded}::text[])))
               ) AS present
        FROM unnest(${buckets}::text[]) AS desired(bucket)
        ORDER BY desired.bucket COLLATE "C"
      `;
      if (rows.length !== buckets.length || rows.some((row) =>
        !isDocumentTermBucket(row.bucket))) {
        throw termReaderError("navigation_term_catalog_delta_invalid");
      }
      return rows.map((row) => ({
        bucket: row.bucket as DocumentTermBucket,
        present: row.present
      }));
    },
    async listNavigationTermRecords(input: {
      knowledgeBaseId: string;
      bucket: DocumentTermBucket;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }): Promise<ReadonlyArray<Record<string, unknown>>> {
      const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
      const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
      return readTermRecordPages((cursor) => sql<Array<{
        term: string; postings: unknown;
      }>>`
        SELECT term.term COLLATE "C" AS term,
               jsonb_agg(jsonb_build_object(
                 'path', posting.page_path, 'fields', posting.fields
               ) ORDER BY posting.page_path COLLATE "C") AS postings
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
          AND (record.source_revision_public_id = ANY(${included}::text[])
            OR (record.active AND record.source_file_public_id
                 <> ALL(${excluded}::text[])))
          AND (${cursor === null} OR term.term COLLATE "C" > ${cursor ?? ""})
        GROUP BY term.term
        ORDER BY term.term COLLATE "C"
        LIMIT ${TERM_RECORD_PAGE_SIZE}
      `);
    },
    async listNavigationTermDeltaRecords(input: {
      knowledgeBaseId: string;
      bucket: DocumentTermBucket;
      affectedSourceFilePublicIds: readonly string[];
      includedSourceRevisionPublicIds: readonly string[];
    }): Promise<ReadonlyArray<Record<string, unknown>>> {
      const affected = sortedUnique(input.affectedSourceFilePublicIds);
      const included = sortedUnique(input.includedSourceRevisionPublicIds);
      if (affected.length === 0) {
        throw termReaderError("publication_delta_closure_incomplete");
      }
      if (affected.length > 10_000 || included.length > 10_000) {
        throw termReaderError("navigation_term_delta_limit_exceeded");
      }
      return readTermRecordPages((cursor) => sql<Array<{
        term: string; postings: unknown;
      }>>`
        WITH affected_terms AS MATERIALIZED (
          SELECT DISTINCT term.term COLLATE "C" AS term
          FROM focowiki.document_navigation_terms term
          JOIN focowiki.document_projection_records record
            ON record.knowledge_base_id = term.knowledge_base_id
           AND record.source_revision_public_id = term.source_revision_public_id
          WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
            AND term.bucket = ${input.bucket}
            AND (${cursor === null}
              OR term.term COLLATE "C" > ${cursor ?? ""})
            AND (record.source_file_public_id = ANY(${affected}::text[])
              OR record.source_revision_public_id = ANY(${included}::text[]))
          ORDER BY term
          LIMIT ${TERM_RECORD_PAGE_SIZE}
        ), visible_postings AS MATERIALIZED (
          SELECT term.term, posting.page_path, posting.fields
          FROM focowiki.document_navigation_terms term
          JOIN focowiki.document_navigation_postings posting
            ON posting.knowledge_base_id = term.knowledge_base_id
           AND posting.source_revision_public_id = term.source_revision_public_id
           AND posting.term = term.term
          JOIN focowiki.document_projection_records record
            ON record.knowledge_base_id = term.knowledge_base_id
           AND record.source_revision_public_id = term.source_revision_public_id
          JOIN affected_terms affected ON affected.term = term.term
          WHERE term.knowledge_base_id = ${input.knowledgeBaseId}
            AND term.bucket = ${input.bucket}
            AND (record.source_revision_public_id = ANY(${included}::text[])
              OR (record.active
                AND record.source_file_public_id <> ALL(${affected}::text[])))
        )
        SELECT affected.term,
               coalesce(jsonb_agg(jsonb_build_object(
                 'path', posting.page_path, 'fields', posting.fields
               ) ORDER BY posting.page_path COLLATE "C")
                 FILTER (WHERE posting.page_path IS NOT NULL), '[]'::jsonb)
                 AS postings
        FROM affected_terms affected
        LEFT JOIN visible_postings posting ON posting.term = affected.term
        GROUP BY affected.term
        ORDER BY affected.term COLLATE "C"
        LIMIT ${TERM_RECORD_PAGE_SIZE}
      `);
    },
    async listTermPartPaths(input: {
      knowledgeBaseId: string;
      bucket: DocumentTermBucket;
    }): Promise<readonly string[]> {
      const prefix = `_index/terms/${input.bucket}/${input.bucket}-terms-part-`;
      const rows = await sql<Array<{ logical_path: string }>>`
        SELECT logical_path FROM focowiki.generated_page_heads
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND left(normalized_path, char_length(${prefix})) = ${prefix}
          AND normalized_path LIKE '%.json'
        ORDER BY normalized_path COLLATE "C"
      `;
      return rows.map((row) => row.logical_path);
    }
  };
}

async function readTermRecordPages(
  read: (cursor: string | null) => Promise<Array<{
    term: string; postings: unknown;
  }>>
): Promise<ReadonlyArray<Record<string, unknown>>> {
  const records: Array<Record<string, unknown>> = [];
  let cursor: string | null = null;
  while (true) {
    const rows = await read(cursor);
    records.push(...rows.map((row) => ({
      term: row.term,
      postings: Array.isArray(row.postings) ? row.postings : []
    })));
    if (rows.length < TERM_RECORD_PAGE_SIZE) return records;
    cursor = rows.at(-1)!.term;
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(comparePortableRecordKeys);
}

function isDocumentTermBucket(value: string): value is DocumentTermBucket {
  return (DOCUMENT_TERM_BUCKETS as readonly string[]).includes(value);
}

function termReaderError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Navigation term reader error: ${code}`), {
    code
  });
}
