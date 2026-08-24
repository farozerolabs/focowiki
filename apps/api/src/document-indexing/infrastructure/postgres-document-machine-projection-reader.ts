import type { DatabaseClient } from "../../db/client.js";
import { posix } from "node:path";
import { portableIndexDirectoryPath } from "@focowiki/okf";
import { mapDocumentProjectionRecord } from
  "./document-projection-record.js";
import {
  createPostgresDocumentGraphProjectionReader
} from
  "./postgres-document-graph-projection-reader.js";
import {
  createPostgresDocumentSemanticDirectoryReader
} from "./postgres-document-semantic-directory-reader.js";
import {
  visibleDocumentGraphEvidence,
  visibleDocumentGraphRelation
} from "./postgres-document-graph-visibility.js";
import { createPostgresDocumentNavigationTermReader } from
  "./postgres-document-navigation-term-reader.js";

const MAXIMUM_ROOT_RECORDS = 100_000;
const MAXIMUM_CHECKSUM_PATHS = 100_000;

export function createPostgresDocumentMachineProjectionReader(
  sql: DatabaseClient
) {
  const graphProjection = createPostgresDocumentGraphProjectionReader(sql);
  const semanticDirectory = createPostgresDocumentSemanticDirectoryReader(sql);
  const navigationTerms = createPostgresDocumentNavigationTermReader(sql);
  return {
    ...graphProjection,
    ...semanticDirectory,
    ...navigationTerms,
    async resolveSourceFilePublicIdsForRevisions(input: {
      knowledgeBaseId: string;
      sourceRevisionPublicIds: readonly string[];
    }): Promise<string[]> {
      const revisions = sortedUnique(input.sourceRevisionPublicIds);
      if (revisions.length === 0) return [];
      if (revisions.length > 10_000) {
        throw projectionReaderError("affected_revision_limit_exceeded");
      }
      const rows = await sql<Array<{ source_file_public_id: string }>>`
        SELECT DISTINCT source_file_public_id COLLATE "C"
               AS source_file_public_id
        FROM focowiki.document_projection_records
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND source_revision_public_id = ANY(${revisions}::text[])
        ORDER BY source_file_public_id
        LIMIT ${revisions.length + 1}
      `;
      if (rows.length > revisions.length) {
        throw projectionReaderError("affected_source_limit_exceeded");
      }
      return rows.map((row) => row.source_file_public_id);
    },
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
      publicationGenerationPublicId?: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
      logLimit: number;
    }) {
      const includedSourceRevisionPublicIds = sortedUnique(
        input.includedSourceRevisionPublicIds ?? []);
      const excludedActiveSourceFilePublicIds = sortedUnique(
        input.excludedActiveSourceFilePublicIds ?? []);
      if (input.publicationGenerationPublicId) {
        const [knowledgeBases, statistics, currentRecords, previousLogs] =
          await Promise.all([
            sql<Array<{
              public_id: string; name: string; description: string | null;
            }>>`
              SELECT public_id, name, description
              FROM focowiki.knowledge_bases
              WHERE public_id = ${input.knowledgeBaseId}
                AND deleted_at IS NULL
              LIMIT 1
            `,
            sql<Array<{
              source_file_count: number | string;
              relationship_count: number | string;
              root_entry_count: number | string;
            }>>`
              SELECT source_file_count, relationship_count, root_entry_count
              FROM focowiki.projection_generation_statistics
              WHERE publication_generation_public_id
                      = ${input.publicationGenerationPublicId}
                AND knowledge_base_id = ${input.knowledgeBaseId}
            `,
            sql<Array<{
              source_revision_public_id: string;
              logical_path: string;
              title: string;
              created_at: Date | string;
            }>>`
              SELECT source_revision_public_id, logical_path, title, created_at
              FROM focowiki.document_projection_records
              WHERE knowledge_base_id = ${input.knowledgeBaseId}
                AND source_revision_public_id
                      = ANY(${includedSourceRevisionPublicIds}::text[])
              ORDER BY normalized_path COLLATE "C"
              LIMIT ${Math.max(1, includedSourceRevisionPublicIds.length + 1)}
            `,
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
               AND record.source_revision_public_id
                     = job.source_revision_public_id
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
        const statistic = statistics[0];
        if (!knowledgeBase || !statistic
          || currentRecords.length > includedSourceRevisionPublicIds.length) {
          throw projectionReaderError("root_projection_statistics_missing");
        }
        return {
          knowledgeBase: {
            id: knowledgeBase.public_id,
            name: knowledgeBase.name,
            description: knowledgeBase.description
          },
          sourceFileCount: Number(statistic.source_file_count),
          graphEdgeCount: Number(statistic.relationship_count),
          rootEntryCount: Number(statistic.root_entry_count),
          currentLogEntries: currentRecords.map((record) => ({
            occurredAt: normalizeTimestamp(record.created_at),
            action: "Updated page",
            message: `Updated pages/${record.logical_path}.`,
            links: [{
              path: `pages/${record.logical_path}`, title: record.title
            }]
          })),
          previousLogEntries: previousLogs.map((record) => ({
            occurredAt: normalizeTimestamp(record.terminal_at),
            action: "Updated page",
            message: `Updated pages/${record.logical_path}.`,
            links: [{
              path: `pages/${record.logical_path}`, title: record.title
            }]
          }))
        };
      }
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
    async readDocumentDirectoryState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      publicationGenerationPublicId?: string;
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
               CASE
                 WHEN overlay.source_revision_public_id IS NOT NULL
                   THEN CASE WHEN overlay.incoming_count
                          + overlay.outgoing_count > 0 THEN 1 ELSE 0 END
                 WHEN ${input.publicationGenerationPublicId ?? null}::text
                        IS NOT NULL
                   THEN CASE WHEN coalesce(active_degree.incoming_count, 0)
                          + coalesce(active_degree.outgoing_count, 0) > 0
                        THEN 1 ELSE 0 END
                 WHEN EXISTS (
                   SELECT 1
                   FROM focowiki.canonical_file_relations relation
                   WHERE relation.knowledge_base_id
                           = record.knowledge_base_id
                     AND (
                       relation.first_source_revision_public_id
                         = record.source_revision_public_id
                       OR relation.second_source_revision_public_id
                         = record.source_revision_public_id
                     )
                     AND (${visibleDocumentGraphRelation(
                       sql,
                       includedSourceRevisionPublicIds,
                       excludedActiveSourceFilePublicIds
                     )})
                     AND EXISTS (
                       SELECT 1
                       FROM focowiki.relation_directed_evidence evidence
                       WHERE evidence.knowledge_base_id
                               = relation.knowledge_base_id
                         AND evidence.pair_public_id = relation.pair_public_id
                         AND (${visibleDocumentGraphEvidence(
                           sql,
                           includedSourceRevisionPublicIds,
                           excludedActiveSourceFilePublicIds
                         )})
                     )
                 ) THEN 1 ELSE 0
               END AS relationship_count
        FROM focowiki.document_semantic_directory_memberships membership
        JOIN focowiki.document_projection_records record
          ON record.knowledge_base_id = membership.knowledge_base_id
         AND record.source_revision_public_id = membership.source_revision_public_id
        LEFT JOIN focowiki.projection_generation_graph_degrees overlay
          ON overlay.publication_generation_public_id
               = ${input.publicationGenerationPublicId ?? null}
         AND overlay.knowledge_base_id = record.knowledge_base_id
         AND overlay.source_revision_public_id
               = record.source_revision_public_id
        LEFT JOIN focowiki.document_graph_degrees active_degree
          ON active_degree.knowledge_base_id = record.knowledge_base_id
         AND active_degree.source_revision_public_id
               = record.source_revision_public_id
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
        records: rows.map(mapDocumentProjectionRecord),
        childDirectories: descendantRows.map(({ directory_path: scopePath }) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${portableIndexDirectoryPath(scopePath)}/index.json`
        })),
        resourcePaths: headRows.map((row) => row.logical_path).filter((path) =>
          posix.basename(path) !== "index.json")
      };
    }
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
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
