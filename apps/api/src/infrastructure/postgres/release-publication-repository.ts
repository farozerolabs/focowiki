import type {
  OkfGraphRelationship,
  SourceMetadataDefaults,
  SourceModelSuggestions
} from "@focowiki/okf";
import type {
  ReleaseChangeAction,
  ReleaseChangeRecord,
  ReleaseChangeSummary,
  ReleaseNavigationEntryRecord,
  ReleasePublicationRepository,
  ReleaseSourceFileRecord,
  ReleaseValidationIssue,
  ReusableReleasePageRecord
} from "../../application/ports/release-publication-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ReleaseSourceFileRow = {
  source_file_id: string;
  source_revision_id: string;
  source_directory_id: string | null;
  name: string;
  relative_path: string;
  generated_path: string;
  object_key: string;
  content_type: string;
  size_bytes: string | number;
  checksum_sha256: string;
  metadata_json: unknown;
  model_suggestions_json: unknown;
  publication_required: boolean;
  path_key: string;
};

type NavigationEntryRow = {
  id: string;
  parent_path: string;
  kind: ReleaseNavigationEntryRecord["kind"];
  name: string;
  target_path: string;
  label: string;
  sort_key: string;
  entry_count: string | number | null;
  direct_child_count: string | number | null;
  title: string | null;
  description: string | null;
  timestamp: string | null;
  version: string | null;
  duplicate_title_count: string | number;
  duplicate_timestamp_count: string | number;
  duplicate_version_count: string | number;
};

type ReusablePageRow = {
  source_file_id: string;
  logical_path: string;
  object_key: string;
  content_type: string;
  size_bytes: string | number;
  checksum_sha256: string;
  okf_type: string | null;
  title: string | null;
  description: string | null;
  tags_json: unknown;
  frontmatter_json: unknown;
};

type RelationshipRow = {
  source_file_id: string;
  generated_path: string;
  title: string;
  relation_type: string;
  direction: "incoming" | "outgoing";
  weight: string | number;
  reason: string;
  source: string;
  evidence_json: unknown;
};

type ReleaseChangeRow = {
  source_file_id: string;
  action: ReleaseChangeAction;
  previous_path: string | null;
  path: string | null;
  title: string;
};

type ReleaseChangeSummaryRow = {
  created: string | number;
  updated: string | number;
  moved: string | number;
  deleted: string | number;
};

type ReleaseDirectoryChangeRow = {
  path: string;
  changed_file_count: string | number;
};

type MarkdownLinkRow = {
  from_path: string;
  to_path: string;
  label: string;
};

export function createPostgresReleasePublicationRepository(
  sql: DatabaseClient
): ReleasePublicationRepository {
  return {
    async materializeSourceSnapshot(input) {
      return await sql.begin("isolation level repeatable read", async (transaction) => {
        await transaction`
          DELETE FROM focowiki.release_resource_operations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        `;
        await transaction`
          INSERT INTO focowiki.release_resource_operations (
            release_id, knowledge_base_id, operation_id
          )
          SELECT ${input.releaseId}, operation.knowledge_base_id, operation.id
          FROM focowiki.resource_operations operation
          JOIN focowiki.releases release
            ON release.id = ${input.releaseId}
           AND release.knowledge_base_id = operation.knowledge_base_id
          WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
            AND operation.state = 'publishing'
            AND operation.candidate_catalog_generation <= release.catalog_generation
          ON CONFLICT (release_id, operation_id) DO NOTHING
        `;
        await transaction`
          DELETE FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_source_directories
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        `;
        const directoryRows = await transaction<Array<{ count: string | number }>>`
          WITH inserted AS (
            INSERT INTO focowiki.release_source_directories (
              release_id, knowledge_base_id, source_directory_id,
              parent_source_directory_id, name, relative_path, path_key, depth,
              resource_revision
            )
            SELECT ${input.releaseId}, directory.knowledge_base_id, directory.id,
                   CASE WHEN captured.operation_id IS NOT NULL
                     THEN directory.candidate_parent_id ELSE directory.parent_id END,
                   CASE WHEN captured.operation_id IS NOT NULL
                     THEN directory.candidate_name ELSE directory.name END,
                   CASE WHEN captured.operation_id IS NOT NULL
                     THEN directory.candidate_relative_path ELSE directory.relative_path END,
                   CASE WHEN captured.operation_id IS NOT NULL
                     THEN directory.candidate_path_key ELSE directory.path_key END,
                   CASE WHEN captured.operation_id IS NOT NULL
                     THEN directory.candidate_depth ELSE directory.depth END,
                   directory.resource_revision + CASE WHEN captured.operation_id IS NULL THEN 0 ELSE 1 END
            FROM focowiki.source_directories directory
            LEFT JOIN focowiki.release_resource_operations captured
              ON captured.release_id = ${input.releaseId}
             AND captured.knowledge_base_id = directory.knowledge_base_id
             AND captured.operation_id = directory.candidate_operation_id
            WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
              AND directory.deleted_at IS NULL
              AND directory.deletion_intent_id IS NULL
            ON CONFLICT (release_id, source_directory_id) DO NOTHING
            RETURNING source_directory_id
          )
          SELECT count(*)::int AS count FROM inserted
        `;
        const sourceRows = await transaction<Array<{ count: string | number }>>`
          WITH selected AS (
            SELECT source.*,
                   captured.operation_id AS publishing_operation_id
            FROM focowiki.source_files source
            LEFT JOIN focowiki.release_resource_operations captured
              ON captured.release_id = ${input.releaseId}
             AND captured.knowledge_base_id = source.knowledge_base_id
             AND captured.operation_id = source.candidate_operation_id
            WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.processing_status = 'completed'
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
              AND (
                source.id = ANY(${input.publicationSourceFileIds})
                OR captured.operation_id IS NOT NULL
                OR EXISTS (
                  SELECT 1
                  FROM focowiki.knowledge_bases knowledge_base
                  JOIN focowiki.bundle_files active_file
                    ON active_file.release_id = knowledge_base.active_release_id
                   AND active_file.knowledge_base_id = knowledge_base.id
                   AND active_file.file_kind = 'page'
                   AND active_file.source_file_id = source.id
                  WHERE knowledge_base.id = source.knowledge_base_id
                )
              )
          ), inserted AS (
            INSERT INTO focowiki.release_source_files (
              release_id, knowledge_base_id, source_file_id, source_revision_id,
              source_directory_id, name, relative_path, path_key, generated_path,
              object_key, content_type, size_bytes, checksum_sha256, metadata_json,
              model_suggestions_json, publication_required, resource_revision, content_revision
            )
            SELECT ${input.releaseId}, source.knowledge_base_id, source.id,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN COALESCE(source.candidate_revision_id, source.active_revision_id)
                     ELSE source.active_revision_id END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN source.candidate_directory_id ELSE source.directory_id END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN source.candidate_name ELSE source.name END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN source.candidate_relative_path ELSE source.relative_path END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN source.candidate_path_key ELSE source.path_key END,
                   'pages/' || CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN source.candidate_relative_path ELSE source.relative_path END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN COALESCE(source.candidate_object_key, source.object_key)
                     ELSE source.object_key END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN COALESCE(source.candidate_content_type, source.content_type)
                     ELSE source.content_type END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN COALESCE(source.candidate_size_bytes, source.size_bytes)
                     ELSE source.size_bytes END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN COALESCE(source.candidate_checksum_sha256, source.checksum_sha256)
                     ELSE source.checksum_sha256 END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN COALESCE(source.candidate_metadata_json, source.metadata_json)
                     ELSE source.metadata_json END,
                   CASE WHEN source.publishing_operation_id IS NOT NULL
                     THEN source.candidate_model_suggestions_json
                     ELSE source.model_suggestions_json END,
                   (source.publishing_operation_id IS NOT NULL
                     OR source.id = ANY(${input.publicationSourceFileIds})),
                   source.resource_revision + CASE WHEN source.publishing_operation_id IS NULL THEN 0 ELSE 1 END,
                   source.content_revision + CASE
                     WHEN source.publishing_operation_id IS NOT NULL
                      AND source.candidate_revision_id IS NOT NULL THEN 1 ELSE 0 END
            FROM selected source
            ON CONFLICT (release_id, source_file_id) DO NOTHING
            RETURNING source_file_id
          )
          SELECT count(*)::int AS count FROM inserted
        `;
        return {
          directoryCount: Number(directoryRows[0]?.count ?? 0),
          sourceFileCount: Number(sourceRows[0]?.count ?? 0)
        };
      });
    },
    async countSourceFiles(input) {
      const rows = await sql<Array<{ count: string | number }>>`
        SELECT count(*)::int AS count
        FROM focowiki.release_source_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND release_id = ${input.releaseId}
      `;
      return Number(rows[0]?.count ?? 0);
    },
    async listSourceFiles(input) {
      const cursor = parsePathCursor(input.cursor);
      const rows = await sql<ReleaseSourceFileRow[]>`
        SELECT source_file_id, source_revision_id, source_directory_id, name,
               relative_path, generated_path, object_key, content_type, size_bytes,
               checksum_sha256, metadata_json, model_suggestions_json,
               publication_required, path_key
        FROM focowiki.release_source_files
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND release_id = ${input.releaseId}
          ${cursor ? sql`AND (path_key, source_file_id) > (${cursor.pathKey}, ${cursor.id})` : sql``}
        ORDER BY path_key COLLATE "C", source_file_id
        LIMIT ${input.limit + 1}
      `;
      const pageRows = rows.slice(0, input.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapSourceFile),
        nextCursor: rows.length > input.limit && last
          ? serializePathCursor({ pathKey: last.path_key, id: last.source_file_id })
          : null
      };
    },
    async listNavigationEntries(input) {
      const cursor = parseNavigationCursor(input.cursor);
      const rows = await sql<NavigationEntryRow[]>`
        WITH file_entry_base AS MATERIALIZED (
          SELECT source.source_file_id,
                 source.source_directory_id,
                 CASE WHEN source.source_directory_id IS NULL THEN 'pages'
                   ELSE 'pages/' || directory.relative_path END AS parent_path,
                 source.name,
                 COALESCE(NULLIF(page.title, ''), regexp_replace(source.name, '\\.md$', '', 'i')) AS title,
                 lower(COALESCE(NULLIF(page.title, ''), regexp_replace(source.name, '\\.md$', '', 'i'))) AS normalized_title,
                 NULLIF(page.description, '') AS description,
                 NULLIF(page.frontmatter_json->>'timestamp', '') AS timestamp,
                 NULLIF(page.frontmatter_json->>'version', '') AS version
          FROM focowiki.release_source_files source
          LEFT JOIN focowiki.release_source_directories directory
            ON directory.release_id = source.release_id
           AND directory.source_directory_id = source.source_directory_id
          JOIN focowiki.bundle_files page
            ON page.release_id = source.release_id
           AND page.knowledge_base_id = source.knowledge_base_id
           AND page.source_file_id = source.source_file_id
           AND page.file_kind = 'page'
          WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
            AND source.release_id = ${input.releaseId}
        ), ranked_file_entries AS MATERIALIZED (
          SELECT file.*,
                 count(*) OVER duplicate_order AS duplicate_title_count,
                 lag(timestamp) OVER duplicate_order AS previous_timestamp,
                 lead(timestamp) OVER duplicate_order AS next_timestamp,
                 lag(version) OVER duplicate_order AS previous_version,
                 lead(version) OVER duplicate_order AS next_version
          FROM file_entry_base file
          WINDOW duplicate_order AS (
            PARTITION BY source_directory_id, normalized_title
            ORDER BY timestamp NULLS FIRST, version NULLS FIRST,
                     lower(name), source_file_id
            ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
          )
        ), file_entries AS MATERIALIZED (
          SELECT file.source_file_id, file.parent_path, file.name, file.title,
                 file.description, file.timestamp, file.version,
                 file.duplicate_title_count,
                 CASE WHEN file.timestamp IS NULL THEN file.duplicate_title_count
                   ELSE 1
                     + CASE WHEN file.previous_timestamp = file.timestamp THEN 1 ELSE 0 END
                     + CASE WHEN file.next_timestamp = file.timestamp THEN 1 ELSE 0 END
                   END AS duplicate_timestamp_count,
                 CASE WHEN file.version IS NULL THEN file.duplicate_title_count
                   ELSE 1
                     + CASE WHEN file.previous_timestamp IS NOT DISTINCT FROM file.timestamp
                                  AND file.previous_version = file.version THEN 1 ELSE 0 END
                     + CASE WHEN file.next_timestamp IS NOT DISTINCT FROM file.timestamp
                                  AND file.next_version = file.version THEN 1 ELSE 0 END
                   END AS duplicate_version_count
          FROM ranked_file_entries file
        ), direct_child_counts AS MATERIALIZED (
          SELECT child.source_directory_id, sum(child.count)::bigint AS child_count
          FROM (
            SELECT directory.parent_source_directory_id AS source_directory_id,
                   count(*)::bigint AS count
            FROM focowiki.release_source_directories directory
            WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
              AND directory.release_id = ${input.releaseId}
            GROUP BY directory.parent_source_directory_id
            UNION ALL
            SELECT file.source_directory_id, count(*)::bigint
            FROM focowiki.release_source_files file
            WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
              AND file.release_id = ${input.releaseId}
            GROUP BY file.source_directory_id
          ) child
          GROUP BY child.source_directory_id
        ), entries AS (
          SELECT 'root'::text AS id, 'pages'::text AS parent_path,
                 'directory_start'::text AS kind, ''::text AS name,
                 ''::text AS target_path, ''::text AS label,
                 '-1:'::text AS sort_key,
                 COALESCE((SELECT child_count FROM direct_child_counts
                   WHERE source_directory_id IS NULL), 0)::bigint AS entry_count,
                 NULL::bigint AS direct_child_count,
                 NULL::text AS title, NULL::text AS description,
                 NULL::text AS timestamp, NULL::text AS version,
                 1::bigint AS duplicate_title_count,
                 1::bigint AS duplicate_timestamp_count,
                 1::bigint AS duplicate_version_count
          UNION ALL
          SELECT 'start:' || directory.source_directory_id,
                 'pages/' || directory.relative_path, 'directory_start', '', '', '', '-1:',
                 COALESCE(children.child_count, 0)::bigint,
                 NULL::bigint, NULL::text, NULL::text, NULL::text, NULL::text,
                 1::bigint, 1::bigint, 1::bigint
          FROM focowiki.release_source_directories directory
          LEFT JOIN direct_child_counts children
            ON children.source_directory_id = directory.source_directory_id
          WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
            AND directory.release_id = ${input.releaseId}
          UNION ALL
          SELECT 'directory:' || directory.source_directory_id,
                 CASE WHEN directory.parent_source_directory_id IS NULL THEN 'pages'
                   ELSE 'pages/' || parent.relative_path END,
                 'directory', directory.name, directory.name || '/index.md',
                 directory.name, '0:' || lower(directory.name), NULL::bigint,
                 COALESCE(children.child_count, 0)::bigint,
                 NULL::text, NULL::text, NULL::text, NULL::text,
                 1::bigint, 1::bigint, 1::bigint
          FROM focowiki.release_source_directories directory
          LEFT JOIN focowiki.release_source_directories parent
            ON parent.release_id = directory.release_id
           AND parent.source_directory_id = directory.parent_source_directory_id
          LEFT JOIN direct_child_counts children
            ON children.source_directory_id = directory.source_directory_id
          WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
            AND directory.release_id = ${input.releaseId}
          UNION ALL
          SELECT 'file:' || file.source_file_id, file.parent_path,
                 'file', file.name, file.name, file.title,
                 '1:' || lower(file.title) || ':' || lower(file.name), NULL::bigint,
                 NULL::bigint, file.title, file.description, file.timestamp, file.version,
                 file.duplicate_title_count, file.duplicate_timestamp_count,
                 file.duplicate_version_count
          FROM file_entries file
        )
        SELECT id, parent_path, kind, name, target_path, label, sort_key, entry_count,
               direct_child_count, title, description, timestamp, version, duplicate_title_count,
               duplicate_timestamp_count, duplicate_version_count
        FROM entries
        WHERE true
          ${cursor ? sql`AND (parent_path COLLATE "C", sort_key COLLATE "C", id) > (${cursor.parentPath}::text COLLATE "C", ${cursor.sortKey}::text COLLATE "C", ${cursor.id})` : sql``}
        ORDER BY parent_path COLLATE "C", sort_key COLLATE "C", id
        LIMIT ${input.limit + 1}
      `;
      const pageRows = rows.slice(0, input.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => ({
          id: row.id,
          parentPath: row.parent_path,
          kind: row.kind,
          name: row.name,
          targetPath: row.target_path,
          label: row.label,
          entryCount: row.entry_count === null ? null : Number(row.entry_count),
          directChildCount: row.direct_child_count === null ? null : Number(row.direct_child_count),
          title: row.title,
          description: row.description,
          timestamp: row.timestamp,
          version: row.version,
          duplicateTitleCount: Number(row.duplicate_title_count),
          duplicateTimestampCount: Number(row.duplicate_timestamp_count),
          duplicateVersionCount: Number(row.duplicate_version_count)
        })),
        nextCursor: rows.length > input.limit && last
          ? serializeNavigationCursor({
              parentPath: last.parent_path,
              sortKey: last.sort_key,
              id: last.id
            })
          : null
      };
    },
    async listReusablePages(input) {
      if (input.sourceFileIds.length === 0) return [];
      const rows = await sql<ReusablePageRow[]>`
        WITH changed_sources AS MATERIALIZED (
          SELECT candidate.source_file_id
          FROM focowiki.release_source_files candidate
          LEFT JOIN focowiki.bundle_files previous
            ON previous.release_id = ${input.releaseId}
           AND previous.source_file_id = candidate.source_file_id
           AND previous.file_kind = 'page'
          WHERE candidate.release_id = ${input.candidateReleaseId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND (previous.id IS NULL OR previous.logical_path <> candidate.generated_path)
        )
        SELECT source_file_id, logical_path, object_key, content_type, size_bytes,
               checksum_sha256, okf_type, title, description, tags_json,
               frontmatter_json
        FROM focowiki.bundle_files previous
        WHERE previous.knowledge_base_id = ${input.knowledgeBaseId}
          AND previous.release_id = ${input.releaseId}
          AND previous.file_kind = 'page'
          AND previous.source_file_id = ANY(${input.sourceFileIds})
          AND NOT EXISTS (
            SELECT 1
            FROM focowiki.source_file_graph_edges edge
            WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
              AND edge.status = 'accepted'
              AND (
                (edge.from_source_file_id = previous.source_file_id
                  AND edge.to_source_file_id IN (SELECT source_file_id FROM changed_sources))
                OR (edge.to_source_file_id = previous.source_file_id
                  AND edge.from_source_file_id IN (SELECT source_file_id FROM changed_sources))
              )
          )
        ORDER BY previous.source_file_id
      `;
      return rows.map(mapReusablePage);
    },
    async persistMarkdownLinks(input) {
      if (input.links.length === 0) return;
      await sql`
        INSERT INTO focowiki.release_markdown_links ${sql(
          input.links.map((link) => ({
            release_id: input.releaseId,
            knowledge_base_id: input.knowledgeBaseId,
            source_file_id: link.sourceFileId,
            from_path: link.from,
            to_path: link.to,
            label: link.label,
            navigation_only: link.navigationOnly
          })),
          "release_id",
          "knowledge_base_id",
          "source_file_id",
          "from_path",
          "to_path",
          "label",
          "navigation_only"
        )}
        ON CONFLICT (release_id, from_path, to_path, label) DO NOTHING
      `;
    },
    async copyReusableMarkdownLinks(input) {
      if (input.sourceFileIds.length === 0) return;
      await sql`
        INSERT INTO focowiki.release_markdown_links (
          release_id, knowledge_base_id, source_file_id,
          from_path, to_path, label, navigation_only
        )
        SELECT ${input.releaseId}, previous.knowledge_base_id, previous.source_file_id,
               previous.from_path, previous.to_path, previous.label, previous.navigation_only
        FROM focowiki.release_markdown_links previous
        JOIN focowiki.release_source_files candidate
          ON candidate.release_id = ${input.releaseId}
         AND candidate.knowledge_base_id = previous.knowledge_base_id
         AND candidate.source_file_id = previous.source_file_id
         AND candidate.generated_path = previous.from_path
        WHERE previous.knowledge_base_id = ${input.knowledgeBaseId}
          AND previous.release_id = ${input.previousReleaseId}
          AND previous.source_file_id = ANY(${input.sourceFileIds})
        ON CONFLICT (release_id, from_path, to_path, label) DO NOTHING
      `;
    },
    async pruneInvalidSourceMarkdownLinks(input) {
      let deleted = 0;
      for (;;) {
        const rows = await sql<Array<{ count: string | number }>>`
          WITH target AS (
            SELECT link.release_id, link.from_path, link.to_path, link.label
            FROM focowiki.release_markdown_links link
            LEFT JOIN focowiki.bundle_files target_file
              ON target_file.knowledge_base_id = link.knowledge_base_id
             AND target_file.release_id = link.release_id
             AND target_file.logical_path = link.to_path
            WHERE link.knowledge_base_id = ${input.knowledgeBaseId}
              AND link.release_id = ${input.releaseId}
              AND link.navigation_only = false
              AND target_file.id IS NULL
              AND NOT (link.to_path = ANY(${input.plannedTargetPaths}))
            ORDER BY link.from_path COLLATE "C", link.to_path COLLATE "C", link.label COLLATE "C"
            LIMIT ${input.batchSize}
          ), removed AS (
            DELETE FROM focowiki.release_markdown_links link
            USING target
            WHERE link.release_id = target.release_id
              AND link.from_path = target.from_path
              AND link.to_path = target.to_path
              AND link.label = target.label
            RETURNING link.release_id
          )
          SELECT count(*)::int AS count FROM removed
        `;
        const count = Number(rows[0]?.count ?? 0);
        deleted += count;
        if (count === 0) return deleted;
      }
    },
    async listValidMarkdownLinks(input) {
      const cursor = parseMarkdownLinkCursor(input.cursor);
      const rows = await sql<MarkdownLinkRow[]>`
        SELECT link.from_path, link.to_path, link.label
        FROM focowiki.release_markdown_links link
        JOIN focowiki.bundle_files source_file
          ON source_file.knowledge_base_id = link.knowledge_base_id
         AND source_file.release_id = link.release_id
         AND source_file.logical_path = link.from_path
        LEFT JOIN focowiki.bundle_files target_file
          ON target_file.knowledge_base_id = link.knowledge_base_id
         AND target_file.release_id = link.release_id
         AND target_file.logical_path = link.to_path
        WHERE link.knowledge_base_id = ${input.knowledgeBaseId}
          AND link.release_id = ${input.releaseId}
          AND (target_file.id IS NOT NULL OR link.to_path = ANY(${input.plannedTargetPaths}))
          ${cursor ? sql`AND (link.from_path COLLATE "C", link.to_path COLLATE "C", link.label COLLATE "C") > (${cursor.from}::text COLLATE "C", ${cursor.to}::text COLLATE "C", ${cursor.label}::text COLLATE "C")` : sql``}
        ORDER BY link.from_path COLLATE "C", link.to_path COLLATE "C", link.label COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      const pageRows = rows.slice(0, input.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map((row) => ({
          from: row.from_path,
          to: row.to_path,
          label: row.label
        })),
        nextCursor: rows.length > input.limit && last
          ? serializeMarkdownLinkCursor({
              from: last.from_path,
              to: last.to_path,
              label: last.label
            })
          : null
      };
    },
    async summarizeChanges(input) {
      const summaryRows = await sql<ReleaseChangeSummaryRow[]>`
        WITH previous AS MATERIALIZED (
          SELECT source_file_id, source_revision_id, resource_revision, generated_path
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = COALESCE(${input.previousReleaseId}, '')
        ), current AS MATERIALIZED (
          SELECT source_file_id, source_revision_id, resource_revision, generated_path
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        ), changes AS (
          SELECT CASE
                   WHEN previous.source_file_id IS NULL THEN 'created'
                   WHEN current.source_file_id IS NULL THEN 'deleted'
                   WHEN previous.generated_path <> current.generated_path THEN 'moved'
                   ELSE 'updated'
                 END AS action
          FROM previous
          FULL OUTER JOIN current USING (source_file_id)
          WHERE previous.source_file_id IS NULL
             OR current.source_file_id IS NULL
             OR previous.generated_path <> current.generated_path
             OR previous.source_revision_id <> current.source_revision_id
             OR previous.resource_revision <> current.resource_revision
        )
        SELECT count(*) FILTER (WHERE action = 'created')::int AS created,
               count(*) FILTER (WHERE action = 'updated')::int AS updated,
               count(*) FILTER (WHERE action = 'moved')::int AS moved,
               count(*) FILTER (WHERE action = 'deleted')::int AS deleted
        FROM changes
      `;
      const directoryRows = await sql<ReleaseDirectoryChangeRow[]>`
        WITH previous AS MATERIALIZED (
          SELECT source_file_id, source_revision_id, resource_revision, generated_path
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = COALESCE(${input.previousReleaseId}, '')
        ), current AS MATERIALIZED (
          SELECT source_file_id, source_revision_id, resource_revision, generated_path
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        ), changed_paths AS (
          SELECT previous.generated_path AS previous_path,
                 current.generated_path AS current_path
          FROM previous
          FULL OUTER JOIN current USING (source_file_id)
          WHERE previous.source_file_id IS NULL
             OR current.source_file_id IS NULL
             OR previous.generated_path <> current.generated_path
             OR previous.source_revision_id <> current.source_revision_id
             OR previous.resource_revision <> current.resource_revision
        ), directories AS (
          SELECT regexp_replace(COALESCE(current_path, previous_path), '/[^/]+$', '') AS path
          FROM changed_paths
          UNION ALL
          SELECT regexp_replace(previous_path, '/[^/]+$', '') AS path
          FROM changed_paths
          WHERE previous_path IS NOT NULL
            AND current_path IS NOT NULL
            AND previous_path <> current_path
        )
        SELECT path, count(*)::int AS changed_file_count
        FROM directories
        WHERE path <> ''
        GROUP BY path
        ORDER BY changed_file_count DESC, path COLLATE "C"
        LIMIT ${input.directoryLimit}
      `;
      const summary = summaryRows[0];
      return {
        created: Number(summary?.created ?? 0),
        updated: Number(summary?.updated ?? 0),
        moved: Number(summary?.moved ?? 0),
        deleted: Number(summary?.deleted ?? 0),
        affectedDirectories: directoryRows.map((row) => ({
          path: row.path,
          changedFileCount: Number(row.changed_file_count)
        }))
      } satisfies ReleaseChangeSummary;
    },
    async listChanges(input) {
      const cursor = parseIdCursor(input.cursor);
      const rows = await sql<ReleaseChangeRow[]>`
        WITH previous AS MATERIALIZED (
          SELECT source_file_id, source_revision_id, resource_revision,
                 generated_path, name, metadata_json
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = COALESCE(${input.previousReleaseId}, '')
        ), current AS MATERIALIZED (
          SELECT source_file_id, source_revision_id, resource_revision,
                 generated_path, name, metadata_json
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        ), changes AS (
          SELECT COALESCE(current.source_file_id, previous.source_file_id) AS source_file_id,
                 CASE
                   WHEN previous.source_file_id IS NULL THEN 'created'
                   WHEN current.source_file_id IS NULL THEN 'deleted'
                   WHEN previous.generated_path <> current.generated_path THEN 'moved'
                   ELSE 'updated'
                 END AS action,
                 previous.generated_path AS previous_path,
                 current.generated_path AS path,
                 COALESCE(NULLIF(current.metadata_json->>'title', ''), current.name,
                          NULLIF(previous.metadata_json->>'title', ''), previous.name) AS title
          FROM previous
          FULL OUTER JOIN current USING (source_file_id)
          WHERE previous.source_file_id IS NULL
             OR current.source_file_id IS NULL
             OR previous.generated_path <> current.generated_path
             OR previous.source_revision_id <> current.source_revision_id
             OR previous.resource_revision <> current.resource_revision
        )
        SELECT source_file_id, action, previous_path, path, title
        FROM changes
        WHERE ${cursor?.id ?? null}::text IS NULL
           OR source_file_id > ${cursor?.id ?? null}
        ORDER BY source_file_id
        LIMIT ${input.limit + 1}
      `;
      const pageRows = rows.slice(0, input.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapReleaseChange),
        nextCursor: rows.length > input.limit && last
          ? serializeIdCursor(last.source_file_id)
          : null
      };
    },
    async listSourceGraphNeighborhood(input) {
      const rows = await sql<RelationshipRow[]>`
        WITH raw_relationships AS (
          SELECT edge.to_source_file_id AS source_file_id, edge.relation_type,
                 'outgoing'::text AS direction, edge.weight, edge.reason,
                 edge.source, edge.evidence_json
          FROM focowiki.source_file_graph_edges edge
          WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
            AND edge.from_source_file_id = ${input.sourceFileId}
            AND edge.status = 'accepted'
          UNION ALL
          SELECT edge.from_source_file_id, edge.relation_type,
                 'incoming'::text, edge.weight, edge.reason,
                 edge.source, edge.evidence_json
          FROM focowiki.source_file_graph_edges edge
          WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}
            AND edge.to_source_file_id = ${input.sourceFileId}
            AND edge.status = 'accepted'
        ), relationships AS (
          SELECT source_file_id, relation_type, direction, weight, reason, source, evidence_json
          FROM (
            SELECT raw_relationships.*,
                   row_number() OVER (
                     PARTITION BY source_file_id
                     ORDER BY weight DESC,
                              CASE WHEN direction = 'outgoing' THEN 0 ELSE 1 END,
                              relation_type ASC
                   ) AS relationship_rank
            FROM raw_relationships
          ) ranked
          WHERE relationship_rank = 1
        )
        SELECT related.source_file_id, snapshot.generated_path,
               COALESCE(node.title, snapshot.name) AS title,
               related.relation_type, related.direction, related.weight,
               related.reason, related.source, related.evidence_json
        FROM relationships related
        JOIN focowiki.release_source_files snapshot
          ON snapshot.release_id = ${input.releaseId}
         AND snapshot.knowledge_base_id = ${input.knowledgeBaseId}
         AND snapshot.source_file_id = related.source_file_id
        LEFT JOIN focowiki.source_file_graph_nodes node
          ON node.knowledge_base_id = snapshot.knowledge_base_id
         AND node.source_file_id = snapshot.source_file_id
        ORDER BY related.weight DESC, related.source_file_id
        LIMIT ${input.limit}
      `;
      return rows.map(mapRelationship);
    },
    async materializeTree(input) {
      return await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.knowledge_file_tree_nodes
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        `;
        await transaction`
          WITH RECURSIVE paths AS (
            SELECT DISTINCT array_to_string(segments[1:depth], '/') AS path
            FROM focowiki.bundle_files file
            CROSS JOIN LATERAL regexp_split_to_array(file.logical_path, '/') segments
            CROSS JOIN LATERAL generate_series(1, array_length(segments, 1) - 1) depth
            WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
              AND file.release_id = ${input.releaseId}
          ), scoped_directories AS MATERIALIZED (
            SELECT source_directory_id, parent_source_directory_id, relative_path
            FROM focowiki.release_source_directories
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_id = ${input.releaseId}
          ), direct_counts AS MATERIALIZED (
            SELECT source_directory_id, count(*)::int AS file_count
            FROM focowiki.release_source_files
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_id = ${input.releaseId}
            GROUP BY source_directory_id
          ), directory_closure AS (
            SELECT source_directory_id AS ancestor_id,
                   source_directory_id AS descendant_id
            FROM scoped_directories
            UNION ALL
            SELECT closure.ancestor_id, child.source_directory_id
            FROM directory_closure closure
            JOIN scoped_directories child
              ON child.parent_source_directory_id = closure.descendant_id
          ), descendant_counts AS MATERIALIZED (
            SELECT closure.ancestor_id AS source_directory_id,
                   COALESCE(sum(direct.file_count), 0)::int AS file_count
            FROM directory_closure closure
            LEFT JOIN direct_counts direct
              ON direct.source_directory_id = closure.descendant_id
            GROUP BY closure.ancestor_id
          ), source_totals AS MATERIALIZED (
            SELECT count(*)::int AS total_file_count,
                   count(*) FILTER (WHERE source_directory_id IS NULL)::int AS root_file_count
            FROM focowiki.release_source_files
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_id = ${input.releaseId}
          )
          INSERT INTO focowiki.knowledge_file_tree_nodes (
            id, knowledge_base_id, release_id, parent_id, path, name, node_type,
            file_id, source_directory_id, depth, sort_key, child_count,
            direct_file_count, descendant_file_count
          )
          SELECT 'tree-directory-' || md5(${input.releaseId} || ':' || path.path),
                 ${input.knowledgeBaseId}, ${input.releaseId},
                 CASE WHEN position('/' in path.path) = 0 THEN NULL
                   ELSE 'tree-directory-' || md5(${input.releaseId} || ':' || regexp_replace(path.path, '/[^/]+$', '')) END,
                 path.path, regexp_replace(path.path, '^.*/', ''), 'directory', NULL,
                 directory.source_directory_id,
                 array_length(regexp_split_to_array(path.path, '/'), 1),
                 '0:' || lower(regexp_replace(path.path, '^.*/', '')), 0,
                 CASE WHEN path.path = 'pages' THEN totals.root_file_count
                   ELSE COALESCE(direct.file_count, 0) END,
                 CASE WHEN path.path = 'pages' THEN totals.total_file_count
                   ELSE COALESCE(descendants.file_count, 0) END
          FROM paths path
          LEFT JOIN scoped_directories directory
            ON 'pages/' || directory.relative_path = path.path
          LEFT JOIN direct_counts direct
            ON direct.source_directory_id = directory.source_directory_id
          LEFT JOIN descendant_counts descendants
            ON descendants.source_directory_id = directory.source_directory_id
          CROSS JOIN source_totals totals
          ON CONFLICT (release_id, path) DO NOTHING
        `;
        await transaction`
          INSERT INTO focowiki.knowledge_file_tree_nodes (
            id, knowledge_base_id, release_id, parent_id, path, name, node_type,
            file_id, source_directory_id, depth, sort_key, child_count,
            direct_file_count, descendant_file_count
          )
          SELECT 'tree-file-' || md5(${input.releaseId} || ':' || file.logical_path),
                 file.knowledge_base_id, file.release_id,
                 CASE WHEN position('/' in file.logical_path) = 0 THEN NULL
                   ELSE 'tree-directory-' || md5(${input.releaseId} || ':' || regexp_replace(file.logical_path, '/[^/]+$', '')) END,
                 file.logical_path, regexp_replace(file.logical_path, '^.*/', ''),
                 'file', file.id, file.source_directory_id,
                 array_length(regexp_split_to_array(file.logical_path, '/'), 1),
                 '1:' || lower(regexp_replace(file.logical_path, '^.*/', '')), 0, 0, 0
          FROM focowiki.bundle_files file
          WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
            AND file.release_id = ${input.releaseId}
          ON CONFLICT (release_id, path) DO NOTHING
        `;
        await transaction`
          UPDATE focowiki.knowledge_file_tree_nodes parent
          SET child_count = child.count
          FROM (
            SELECT parent_id, count(*)::int AS count
            FROM focowiki.knowledge_file_tree_nodes
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_id = ${input.releaseId}
              AND parent_id IS NOT NULL
            GROUP BY parent_id
          ) child
          WHERE parent.id = child.parent_id
        `;
        const rows = await transaction<Array<{ count: string | number }>>`
          SELECT count(*)::int AS count
          FROM focowiki.knowledge_file_tree_nodes
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        `;
        return { entryCount: Number(rows[0]?.count ?? 0) };
      });
    },
    async validateRelease(input) {
      const requiredPaths = [
        "index.md",
        "log.md",
        "schema.md",
        "schema-frontmatter.md",
        "schema-navigation.md",
        "schema-extensions.md",
        "pages/index.md",
        "_index/index.md",
        "_index/manifest.json",
        "_index/search.json",
        "_index/links.json",
        "_index/changes.json",
        ...(input.requireGraph ? ["_graph/index.md", "_graph/manifest.json"] : [])
      ];
      const sourceNavigationEntryPaths = [
        "schema.md",
        "_index/index.md",
        ...(input.requireGraph ? ["_graph/index.md"] : [])
      ];
      const rows = await sql<Array<{
        rule_id: string;
        path: string | null;
        message: string;
      }>>`
        WITH expected_pages AS MATERIALIZED (
          SELECT source_file_id, generated_path
          FROM focowiki.release_source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
        ), actual_pages AS MATERIALIZED (
          SELECT id, source_file_id, logical_path
          FROM focowiki.bundle_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_id = ${input.releaseId}
            AND file_kind = 'page'
        ), issues AS (
          SELECT 'FOCOWIKI-RELEASE-SOURCE-PAGE'::text AS rule_id,
                 expected.generated_path AS path,
                 'Release source snapshot has no matching generated page.'::text AS message
          FROM expected_pages expected
          LEFT JOIN actual_pages actual
            ON actual.source_file_id = expected.source_file_id
           AND actual.logical_path = expected.generated_path
          WHERE actual.id IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-EXTRA-PAGE', actual.logical_path,
                 'Generated page has no matching release source snapshot.'
          FROM actual_pages actual
          LEFT JOIN expected_pages expected
            ON expected.source_file_id = actual.source_file_id
           AND expected.generated_path = actual.logical_path
          WHERE expected.source_file_id IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-TREE-REACHABILITY', file.logical_path,
                 'Generated file is missing from the release tree.'
          FROM focowiki.bundle_files file
          LEFT JOIN focowiki.knowledge_file_tree_nodes tree
            ON tree.release_id = file.release_id
           AND tree.knowledge_base_id = file.knowledge_base_id
           AND tree.file_id = file.id
          WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
            AND file.release_id = ${input.releaseId}
            AND tree.id IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-DIRECTORY-INDEX',
                 'pages/' || directory.relative_path || '/index.md',
                 'Source directory is missing its generated index.'
          FROM focowiki.release_source_directories directory
          LEFT JOIN focowiki.bundle_files file
            ON file.release_id = directory.release_id
           AND file.knowledge_base_id = directory.knowledge_base_id
           AND file.logical_path = 'pages/' || directory.relative_path || '/index.md'
          WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
            AND directory.release_id = ${input.releaseId}
            AND file.id IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-REQUIRED-FILE', required.path,
                 'Required generated release file is missing.'
          FROM unnest(${requiredPaths}::text[]) required(path)
          LEFT JOIN focowiki.bundle_files file
            ON file.knowledge_base_id = ${input.knowledgeBaseId}
           AND file.release_id = ${input.releaseId}
           AND file.logical_path = required.path
          WHERE file.id IS NULL
          UNION ALL
          SELECT 'OKF-0.1-CONCEPT-TYPE', file.logical_path,
                 'Non-reserved Markdown concept has no persisted type.'
          FROM focowiki.bundle_files file
          WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
            AND file.release_id = ${input.releaseId}
            AND file.logical_path LIKE '%.md'
            AND file.logical_path <> 'log.md'
            AND file.logical_path !~ '(^|/)index\.md$'
            AND NULLIF(btrim(file.okf_type), '') IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-SOURCE-NAVIGATION', entry.path,
                 'Generated extension entry point does not link to source-backed document navigation.'
          FROM unnest(${sourceNavigationEntryPaths}::text[]) entry(path)
          JOIN focowiki.bundle_files file
            ON file.knowledge_base_id = ${input.knowledgeBaseId}
           AND file.release_id = ${input.releaseId}
           AND file.logical_path = entry.path
          LEFT JOIN focowiki.release_markdown_links link
            ON link.knowledge_base_id = file.knowledge_base_id
           AND link.release_id = file.release_id
           AND link.from_path = file.logical_path
           AND link.to_path = 'pages/index.md'
           AND link.navigation_only = true
          WHERE link.to_path IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-CONTINUATION-CHAIN', continuation.logical_path,
                 'Generated continuation concept is not linked from its navigation sequence.'
          FROM focowiki.bundle_files continuation
          WHERE continuation.knowledge_base_id = ${input.knowledgeBaseId}
            AND continuation.release_id = ${input.releaseId}
            AND continuation.file_kind IN (
              'history_page', 'directory_index_page', 'directory_index_map'
            )
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.release_markdown_links link
              JOIN focowiki.bundle_files source
                ON source.knowledge_base_id = link.knowledge_base_id
               AND source.release_id = link.release_id
               AND source.logical_path = link.from_path
              WHERE link.knowledge_base_id = continuation.knowledge_base_id
                AND link.release_id = continuation.release_id
                AND link.to_path = continuation.logical_path
                AND link.navigation_only = true
                AND (
                  (continuation.file_kind = 'history_page'
                    AND source.file_kind IN ('log', 'history_page'))
                  OR
                  (continuation.file_kind IN ('directory_index_page', 'directory_index_map')
                    AND source.file_kind IN (
                      'directory_index', 'directory_index_page', 'directory_index_map'
                    ))
                )
            )
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-NAVIGATION-CLASSIFICATION', file.logical_path,
                 'Generated navigation file has an invalid navigation-only classification.'
          FROM focowiki.bundle_files file
          WHERE file.knowledge_base_id = ${input.knowledgeBaseId}
            AND file.release_id = ${input.releaseId}
            AND ((file.file_kind IN (
                    'index', 'log', 'history_page', 'directory_index', 'directory_index_page',
                    'directory_index_map', 'index_catalog'
                  ) AND file.navigation_only = false)
              OR (file.file_kind = 'page' AND file.navigation_only = true))
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-GRAPH-PATH', page.logical_path,
                 'Release graph node is missing or does not resolve to the generated page path.'
          FROM actual_pages page
          LEFT JOIN focowiki.knowledge_graph_nodes node
            ON node.knowledge_base_id = ${input.knowledgeBaseId}
           AND node.release_id = ${input.releaseId}
           AND node.file_id = page.id
           AND node.path = page.logical_path
          WHERE ${input.requireGraph}
            AND node.id IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-BROKEN-NAVIGATION-LINK', link.from_path,
                 'Generated navigation file links to a missing release path.'
          FROM focowiki.release_markdown_links link
          LEFT JOIN focowiki.bundle_files target
            ON target.knowledge_base_id = link.knowledge_base_id
           AND target.release_id = link.release_id
           AND target.logical_path = link.to_path
          WHERE link.knowledge_base_id = ${input.knowledgeBaseId}
            AND link.release_id = ${input.releaseId}
            AND link.navigation_only = true
            AND target.id IS NULL
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-NAVIGATION-LABEL', link.from_path,
                 'Generated navigation label does not match the target concept title.'
          FROM focowiki.release_markdown_links link
          JOIN focowiki.bundle_files target
            ON target.knowledge_base_id = link.knowledge_base_id
           AND target.release_id = link.release_id
           AND target.logical_path = link.to_path
          WHERE link.knowledge_base_id = ${input.knowledgeBaseId}
            AND link.release_id = ${input.releaseId}
            AND link.navigation_only = true
            AND target.file_kind = 'page'
            AND target.title IS NOT NULL
            AND link.label <> target.title
            AND left(link.label, length(target.title) + 2) <> target.title || ' ('
          UNION ALL
          SELECT 'FOCOWIKI-RELEASE-INDEX-COVERAGE', page.logical_path,
                 'Source-backed concept must appear exactly once in its directory navigation.'
          FROM actual_pages page
          LEFT JOIN focowiki.release_markdown_links link
            ON link.knowledge_base_id = ${input.knowledgeBaseId}
           AND link.release_id = ${input.releaseId}
           AND link.to_path = page.logical_path
           AND link.navigation_only = true
          LEFT JOIN focowiki.bundle_files source
            ON source.knowledge_base_id = link.knowledge_base_id
           AND source.release_id = link.release_id
           AND source.logical_path = link.from_path
           AND source.file_kind IN ('directory_index', 'directory_index_page')
          GROUP BY page.logical_path
          HAVING count(source.id) <> 1
        )
        SELECT rule_id, path, message
        FROM issues
        ORDER BY rule_id, path NULLS FIRST
        LIMIT ${input.issueLimit + 1}
      `;
      const issues = rows.slice(0, input.issueLimit).map((row) => ({
        ruleId: row.rule_id,
        path: row.path,
        message: row.message
      } satisfies ReleaseValidationIssue));
      return {
        issues,
        truncated: rows.length > input.issueLimit
      };
    }
  };
}

function mapSourceFile(row: ReleaseSourceFileRow): ReleaseSourceFileRecord {
  return {
    sourceFileId: row.source_file_id,
    sourceRevisionId: row.source_revision_id,
    sourceDirectoryId: row.source_directory_id,
    name: row.name,
    relativePath: row.relative_path,
    generatedPath: row.generated_path,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    metadata: record(row.metadata_json) as SourceMetadataDefaults,
    suggestions: optionalRecord(row.model_suggestions_json) as SourceModelSuggestions | null,
    publicationRequired: row.publication_required
  };
}

function mapReusablePage(row: ReusablePageRow): ReusableReleasePageRecord {
  return {
    sourceFileId: row.source_file_id,
    logicalPath: row.logical_path,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    checksumSha256: row.checksum_sha256,
    okfType: row.okf_type,
    title: row.title,
    description: row.description,
    tags: strings(row.tags_json),
    frontmatter: record(row.frontmatter_json)
  };
}

function mapRelationship(row: RelationshipRow): OkfGraphRelationship {
  return {
    fileId: row.source_file_id,
    path: row.generated_path,
    title: row.title,
    relationType: row.relation_type,
    direction: row.direction,
    weight: Number(row.weight),
    reason: row.reason,
    source: row.source,
    evidence: record(row.evidence_json)
  };
}

function mapReleaseChange(row: ReleaseChangeRow): ReleaseChangeRecord {
  return {
    sourceFileId: row.source_file_id,
    action: row.action,
    previousPath: row.previous_path,
    path: row.path,
    title: row.title
  };
}

function serializeMarkdownLinkCursor(value: {
  from: string;
  to: string;
  label: string;
}): string {
  return encodeCursor(value);
}

function parseMarkdownLinkCursor(cursor: string | null): {
  from: string;
  to: string;
  label: string;
} | null {
  if (!cursor) return null;
  const value = decodeCursor(cursor);
  return typeof value.from === "string"
    && typeof value.to === "string"
    && typeof value.label === "string"
    ? { from: value.from, to: value.to, label: value.label }
    : null;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalRecord(value: unknown): Record<string, unknown> | null {
  return value === null ? null : record(value);
}

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function serializePathCursor(value: { pathKey: string; id: string }): string {
  return encodeCursor(value);
}

function parsePathCursor(cursor: string | null): { pathKey: string; id: string } | null {
  if (!cursor) return null;
  const value = decodeCursor(cursor);
  return typeof value.pathKey === "string" && typeof value.id === "string"
    ? { pathKey: value.pathKey, id: value.id }
    : null;
}

function serializeNavigationCursor(value: {
  parentPath: string;
  sortKey: string;
  id: string;
}): string {
  return encodeCursor(value);
}

function parseNavigationCursor(cursor: string | null): {
  parentPath: string;
  sortKey: string;
  id: string;
} | null {
  if (!cursor) return null;
  const value = decodeCursor(cursor);
  return typeof value.parentPath === "string"
    && typeof value.sortKey === "string"
    && typeof value.id === "string"
    ? { parentPath: value.parentPath, sortKey: value.sortKey, id: value.id }
    : null;
}

function serializeIdCursor(id: string): string {
  return encodeCursor({ id });
}

function parseIdCursor(cursor: string | null): { id: string } | null {
  if (!cursor) return null;
  const value = decodeCursor(cursor);
  return typeof value.id === "string" ? { id: value.id } : null;
}

function encodeCursor(value: Record<string, string>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(cursor: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;
  return record(parsed);
}
