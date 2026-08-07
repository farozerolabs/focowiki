import type { DatabaseClient } from "../../db/client.js";
import type { EffectiveProjectionShard } from
  "../../application/ports/projection-catalog-repository.js";
import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import type { StorageVnextPublicationSnapshotPort } from "./projection-loader.js";
import type { StorageVnextShardDescriptor } from "../release/ports.js";
import type { StorageVnextImmutableBodyStore } from
  "../ownership/s3-immutable-body-store.js";
import type { StorageVnextImmutableObjectFormat } from
  "../ownership/content-address.js";
import {
  parseStorageVnextDirectoryNavigationState,
  STORAGE_VNEXT_DIRECTORY_NAVIGATION_SHARD_KIND
} from "./directory-state.js";
import {
  parseStorageVnextExtensionNavigationState,
  STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND
} from "./extension-navigation-state.js";
import { isAllowedPublicBundleFilePath } from "@focowiki/okf";
import { parseShard, type JsonProjectionRecord } from
  "../../publication/projection-shard-partitioning.js";

type CountRow = {
  source_file_count: number | string;
  directory_count: number | string;
  graph_node_count: number | string;
  graph_edge_count: number | string;
};

type DirectoryCountRow = {
  directory_path: string;
  descendant_file_count: number | string;
};

type PathRow = { logical_path: string };

type DirectoryStateRow = {
  depth: number | string;
  storage_key: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_format: StorageVnextImmutableObjectFormat;
};

type NavigationShardRow = {
  public_id: string;
  logical_kind: string;
  first_logical_path: string;
  last_logical_path: string;
  record_count: number | string;
  byte_count: number | string;
  checksum_sha256: string;
  object_id: string;
  ordinal: number | string;
};

type GeneratedObjectRow = {
  logical_path: string;
  object_id: string;
  storage_key: string;
  checksum_sha256: string;
  byte_count: number | string;
  content_type: string;
  object_format: StorageVnextImmutableObjectFormat;
};

type SummaryRow = CountRow & {
  generated_entry_count: number | string;
  generated_byte_count: number | string;
};

const PUBLIC_PROJECTION_PATH = /^_(?:index|graph)\/(search|links|manifest|tree|graph_node|graph_edge)\/(v[0-9]+\/[0-9]+)\.json$/u;

export function createPostgresStorageVnextPublicationSnapshot(
  sql: DatabaseClient,
  input: {
    objects: Pick<StorageVnextImmutableBodyStore, "readVerified">;
  }
): StorageVnextPublicationSnapshotPort {
  const objects = input.objects;
  return {
    async readBaseNavigationProfile(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.candidatePublicId);
      const rows = await sql<Array<{ navigation_profile_version: number | string }>>`
        SELECT coalesce(root.navigation_profile_version, 1)
                 AS navigation_profile_version
        FROM focowiki.release_candidates candidate
        LEFT JOIN focowiki.release_roots root
          ON root.knowledge_base_id = candidate.knowledge_base_id
         AND root.public_id = candidate.expected_active_root_public_id
        WHERE candidate.public_id = ${input.candidatePublicId}
          AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
          AND candidate.state = 'building'
        LIMIT 1
      `;
      const version = Number(requireRow(rows[0]).navigation_profile_version);
      if (!Number.isSafeInteger(version) || version < 0 || version > 1) {
        throw snapshotError("navigation_profile_conflict");
      }
      return version;
    },

    async readKnowledgeBaseCounts(input) {
      assertId(input.knowledgeBaseId);
      const rows = await sql<CountRow[]>`
        SELECT
          (SELECT count(*)
           FROM focowiki.source_files source
           JOIN focowiki.source_file_current_revisions current_revision
             ON current_revision.knowledge_base_id = source.knowledge_base_id
            AND current_revision.source_file_public_id = source.public_id
           WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
             AND source.deleted_at IS NULL
             AND source.status = 'ready') AS source_file_count,
          1 + (SELECT count(*)
               FROM focowiki.source_directories directory
               WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
                 AND directory.deleted_at IS NULL) AS directory_count,
          (SELECT count(*)
           FROM focowiki.graph_nodes node
           JOIN focowiki.source_file_current_revisions current_revision
             ON current_revision.knowledge_base_id = node.knowledge_base_id
            AND current_revision.source_file_public_id = node.source_file_public_id
            AND current_revision.source_revision_public_id = node.source_revision_public_id
           JOIN focowiki.source_files source
             ON source.knowledge_base_id = node.knowledge_base_id
            AND source.public_id = node.source_file_public_id
            AND source.deleted_at IS NULL
           WHERE node.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_node_count,
          (SELECT count(*)
           FROM focowiki.graph_edges edge
           JOIN focowiki.graph_nodes source_node
             ON source_node.knowledge_base_id = edge.knowledge_base_id
            AND source_node.public_id = edge.from_node_public_id
           JOIN focowiki.graph_nodes target_node
             ON target_node.knowledge_base_id = edge.knowledge_base_id
            AND target_node.public_id = edge.to_node_public_id
           JOIN focowiki.source_file_current_revisions source_current
             ON source_current.knowledge_base_id = source_node.knowledge_base_id
            AND source_current.source_file_public_id = source_node.source_file_public_id
            AND source_current.source_revision_public_id = source_node.source_revision_public_id
           JOIN focowiki.source_file_current_revisions target_current
             ON target_current.knowledge_base_id = target_node.knowledge_base_id
            AND target_current.source_file_public_id = target_node.source_file_public_id
            AND target_current.source_revision_public_id = target_node.source_revision_public_id
           WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_edge_count
        WHERE EXISTS (
          SELECT 1 FROM focowiki.knowledge_bases knowledge_base
          WHERE knowledge_base.public_id = ${input.knowledgeBaseId}
            AND knowledge_base.deleted_at IS NULL
        )
      `;
      return mapCounts(requireRow(rows[0]));
    },

    async readDirectoryDescendantFileCounts(input) {
      assertId(input.knowledgeBaseId);
      assertPaths(input.directoryPaths, 1_000);
      if (input.directoryPaths.length === 0) return new Map();
      const rows = await sql<DirectoryCountRow[]>`
        WITH requested AS (
          SELECT DISTINCT directory_path
          FROM unnest(${input.directoryPaths}::text[]) directory_path
        )
        SELECT requested.directory_path,
               count(source.public_id) AS descendant_file_count
        FROM requested
        LEFT JOIN focowiki.source_files source
          ON source.knowledge_base_id = ${input.knowledgeBaseId}
         AND source.deleted_at IS NULL
         AND source.status = 'ready'
         AND EXISTS (
           SELECT 1
           FROM focowiki.source_file_current_revisions current_revision
           WHERE current_revision.knowledge_base_id = source.knowledge_base_id
             AND current_revision.source_file_public_id = source.public_id
         )
         AND (
           requested.directory_path = 'pages'
           OR left(
             source.logical_path,
             length(substring(requested.directory_path FROM 7)) + 1
           ) = substring(requested.directory_path FROM 7) || '/'
         )
        GROUP BY requested.directory_path
        ORDER BY requested.directory_path COLLATE "C"
      `;
      return new Map(rows.map((row) => [
        row.directory_path,
        Number(row.descendant_file_count)
      ]));
    },

    async readDirectoryLeaves(request) {
      assertId(request.knowledgeBaseId);
      assertId(request.candidatePublicId);
      assertPaths([request.directoryPath], 1);
      assertLimit(request.maximumBytes, Number.MAX_SAFE_INTEGER);
      const rows = await sql<DirectoryStateRow[]>`
        WITH RECURSIVE candidate_scope AS (
          SELECT candidate_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${request.candidatePublicId}
            AND candidate.knowledge_base_id = ${request.knowledgeBaseId}
            AND candidate.state = 'building'
        ), lineage AS (
          SELECT root.public_id, root.base_root_public_id, 0 AS depth,
                 ARRAY[root.public_id]::text[] AS visited
          FROM candidate_scope scope
          JOIN focowiki.release_roots root
            ON root.public_id = scope.candidate_root_public_id
          UNION ALL
          SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
                 lineage.visited || base.public_id
          FROM lineage
          JOIN focowiki.release_roots base
            ON base.public_id = lineage.base_root_public_id
          WHERE lineage.depth < 63
            AND NOT base.public_id = ANY(lineage.visited)
        )
        SELECT lineage.depth, object.storage_key, shard.checksum_sha256,
               shard.byte_count, object.content_type, object.object_format
        FROM lineage
        JOIN focowiki.release_root_shards attached
          ON attached.release_root_public_id = lineage.public_id
        JOIN focowiki.release_shards shard
          ON shard.knowledge_base_id = ${request.knowledgeBaseId}
         AND shard.public_id = attached.release_shard_public_id
        JOIN focowiki.object_registrations object
          ON object.object_id = shard.object_id
         AND object.state = 'verified'
        WHERE shard.logical_kind = ${STORAGE_VNEXT_DIRECTORY_NAVIGATION_SHARD_KIND}
          AND shard.first_logical_path = ${request.directoryPath}
          AND shard.last_logical_path = ${request.directoryPath}
        ORDER BY lineage.depth, attached.ordinal, shard.public_id COLLATE "C"
        LIMIT 65537
      `;
      if (rows.length > 65_536) throw snapshotError("directory_state_limit_exceeded");
      const depth = rows[0] ? Number(rows[0].depth) : null;
      if (depth === null) return [];
      const parts = [];
      for (const row of rows.filter((item) => Number(item.depth) === depth)) {
        if (row.object_format !== "okf-generated-json-v1") {
          throw snapshotError("directory_state_conflict");
        }
        const bytes = await input.objects.readVerified({
          descriptor: {
            objectId: `generated-sha256:${row.object_format}:${row.checksum_sha256}`,
            storageKey: row.storage_key,
            checksum: row.checksum_sha256,
            byteCount: Number(row.byte_count),
            contentType: row.content_type,
            objectFormat: row.object_format
          },
          maximumBytes: request.maximumBytes,
          signal: request.signal
        });
        parts.push(parseStorageVnextDirectoryNavigationState({
          bytes,
          directoryPath: request.directoryPath
        }));
      }
      parts.sort((left, right) => left.partIndex - right.partIndex);
      if (
        parts.some((part, index) =>
          part.partIndex !== index || part.partCount !== parts.length)
      ) throw snapshotError("directory_state_conflict");
      return parts.flatMap((part) => part.leaves);
    },

    async readExtensionNavigationLeaves(request) {
      return readNavigationLeaves({
        sql,
        objects: input.objects,
        request,
        logicalKind: STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND,
        parse: parseStorageVnextExtensionNavigationState
      });
    },

    async listExtensionNavigationShards(request) {
      assertId(request.knowledgeBaseId);
      assertId(request.candidatePublicId);
      assertPaths(request.directoryPaths, 64);
      assertLimit(request.limit, 65_536);
      if (request.directoryPaths.length === 0) return [];
      const rows = await sql<NavigationShardRow[]>`
        WITH candidate_scope AS MATERIALIZED (
          SELECT candidate_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${request.candidatePublicId}
            AND candidate.knowledge_base_id = ${request.knowledgeBaseId}
            AND candidate.state = 'building'
        )
        SELECT shard.public_id, shard.logical_kind, shard.first_logical_path,
               shard.last_logical_path, shard.record_count, shard.byte_count,
               shard.checksum_sha256, shard.object_id, shard.ordinal
        FROM candidate_scope scope
        CROSS JOIN LATERAL focowiki.resolve_release_shards(
          scope.candidate_root_public_id
        ) shard
        WHERE shard.logical_kind = ${STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND}
          AND shard.first_logical_path = ANY(${request.directoryPaths})
          AND shard.last_logical_path = shard.first_logical_path
        ORDER BY shard.first_logical_path COLLATE "C", shard.ordinal,
                 shard.public_id COLLATE "C"
        LIMIT ${request.limit + 1}
      `;
      if (rows.length > request.limit) {
        throw snapshotError("navigation_state_limit_exceeded");
      }
      return rows.map((row): StorageVnextShardDescriptor => ({
        publicId: row.public_id,
        logicalKind: row.logical_kind,
        firstLogicalPath: row.first_logical_path,
        lastLogicalPath: row.last_logical_path,
        recordCount: Number(row.record_count),
        byteCount: Number(row.byte_count),
        checksum: row.checksum_sha256,
        objectId: row.object_id,
        ordinal: Number(row.ordinal)
      }));
    },

    async readProjectionRecords(request) {
      assertId(request.knowledgeBaseId);
      assertId(request.candidatePublicId);
      assertPaths([request.logicalPath], 1);
      assertLimit(request.maximumBytes, Number.MAX_SAFE_INTEGER);
      const row = await findEffectiveGeneratedObject(sql, request);
      if (!row) return [];
      return parseProjectionRecords(await readGeneratedObject(input.objects, row, {
        maximumBytes: request.maximumBytes,
        signal: request.signal
      }));
    },

    async listAffectedObsoletePaths(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.candidatePublicId);
      assertLimit(input.limit, 250_000);
      for (const paths of [
        input.sourcePaths,
        input.currentDirectoryPaths,
        input.deletedDirectoryPaths,
        input.currentLogicalPaths
      ]) assertPaths(paths, input.limit);
      const rows = await sql<PathRow[]>`
        WITH candidate_scope AS MATERIALIZED (
          SELECT candidate_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${input.candidatePublicId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.state = 'building'
        )
        SELECT entry.logical_path
        FROM candidate_scope scope
        CROSS JOIN LATERAL focowiki.resolve_release_catalog(
          scope.candidate_root_public_id
        ) entry
        WHERE (
          entry.logical_path = ANY(${input.sourcePaths})
          OR (
            entry.entry_kind = 'directory'
            AND EXISTS (
              SELECT 1
              FROM unnest(${input.currentDirectoryPaths}::text[]) directory_path
              WHERE entry.logical_path = directory_path || '/index.md'
                 OR (
                   left(entry.logical_path, length(directory_path) + 7)
                     = directory_path || '/index-'
                   AND right(entry.logical_path, 3) = '.md'
                 )
            )
          )
          OR EXISTS (
            SELECT 1
            FROM unnest(${input.deletedDirectoryPaths}::text[]) directory_path
            WHERE entry.logical_path = directory_path || '/index.md'
               OR left(entry.logical_path, length(directory_path) + 1)
                    = directory_path || '/'
          )
        )
          AND NOT entry.logical_path = ANY(${input.currentLogicalPaths})
        ORDER BY entry.logical_path COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) throw snapshotError("affected_path_budget_exceeded");
      return rows.map((row) => row.logical_path);
    },

    async listProjectionShards(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.candidatePublicId);
      assertLimit(input.limit, 65_536);
      assertLimit(input.maximumBytes, Number.MAX_SAFE_INTEGER);
      const rows = await sql<GeneratedObjectRow[]>`
        WITH candidate_scope AS MATERIALIZED (
          SELECT candidate_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${input.candidatePublicId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.state = 'building'
        )
        SELECT entry.logical_path, entry.object_id, object.storage_key,
               entry.checksum_sha256, entry.byte_count,
               object.content_type, object.object_format
        FROM candidate_scope scope
        CROSS JOIN LATERAL focowiki.resolve_release_catalog(
          scope.candidate_root_public_id
        ) entry
        JOIN focowiki.object_registrations object
          ON object.object_id = entry.object_id
         AND object.state = 'verified'
        WHERE entry.logical_path ~ '^_(index|graph)/(search|links|manifest|tree|graph_node|graph_edge)/v[0-9]+/[0-9]+[.]json$'
        ORDER BY entry.logical_path COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      if (rows.length > input.limit) throw snapshotError("projection_shard_budget_exceeded");
      const shards: EffectiveProjectionShard[] = [];
      for (const row of rows) {
        const records = parseProjectionRecords(await readGeneratedObject(
          objects,
          row,
          { maximumBytes: input.maximumBytes }
        ));
        shards.push(toProjectionShard(row, records.length));
      }
      return shards;
    },

    async listExtensionCatalogPaths(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.candidatePublicId);
      assertLimit(input.limit, 1_000);
      const cursor = decodeExtensionPathCursor(input.cursor, input.candidatePublicId);
      const rows = await sql<PathRow[]>`
        WITH RECURSIVE candidate_scope AS MATERIALIZED (
          SELECT candidate_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${input.candidatePublicId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.state = 'building'
        ), lineage AS (
          SELECT root.public_id, root.base_root_public_id, 0 AS depth,
                 ARRAY[root.public_id]::text[] AS visited
          FROM candidate_scope scope
          JOIN focowiki.release_roots root
            ON root.public_id = scope.candidate_root_public_id
           AND root.knowledge_base_id = ${input.knowledgeBaseId}
          UNION ALL
          SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
                 lineage.visited || base.public_id
          FROM lineage
          JOIN focowiki.release_roots base
            ON base.public_id = lineage.base_root_public_id
           AND base.knowledge_base_id = ${input.knowledgeBaseId}
          WHERE lineage.depth < 63
            AND NOT base.public_id = ANY(lineage.visited)
        ), layered AS MATERIALIZED (
          SELECT item.logical_path, item.deleted, lineage.depth
          FROM lineage
          CROSS JOIN LATERAL (
            SELECT scoped.logical_path, scoped.deleted
            FROM (
              SELECT entry.logical_path, false AS deleted
              FROM focowiki.release_catalog_entries entry
              WHERE entry.release_root_public_id = lineage.public_id
                AND entry.knowledge_base_id = ${input.knowledgeBaseId}
                AND entry.logical_path COLLATE "C" >
                    coalesce(${cursor?.logicalPath ?? null}::text, '') COLLATE "C"
                AND (
                  (entry.logical_path COLLATE "C" >= '_graph/' COLLATE "C"
                   AND entry.logical_path COLLATE "C" < '_graph0' COLLATE "C")
                  OR
                  (entry.logical_path COLLATE "C" >= '_index/' COLLATE "C"
                   AND entry.logical_path COLLATE "C" < '_index0' COLLATE "C")
                )
              UNION ALL
              SELECT tombstone.logical_path, true AS deleted
              FROM focowiki.release_catalog_tombstones tombstone
              WHERE tombstone.release_root_public_id = lineage.public_id
                AND tombstone.knowledge_base_id = ${input.knowledgeBaseId}
                AND tombstone.logical_path COLLATE "C" >
                    coalesce(${cursor?.logicalPath ?? null}::text, '') COLLATE "C"
                AND (
                  (tombstone.logical_path COLLATE "C" >= '_graph/' COLLATE "C"
                   AND tombstone.logical_path COLLATE "C" < '_graph0' COLLATE "C")
                  OR
                  (tombstone.logical_path COLLATE "C" >= '_index/' COLLATE "C"
                   AND tombstone.logical_path COLLATE "C" < '_index0' COLLATE "C")
                )
            ) scoped
            WHERE scoped.logical_path ~ '^_graph/by-file/[^/]+[.]json$'
               OR (
                 scoped.logical_path ~ '^_(index|graph)/.+[.]md$'
                 AND scoped.logical_path NOT LIKE '%/%/%/%/%'
               )
            ORDER BY scoped.logical_path COLLATE "C"
            LIMIT ${input.limit + 1}
          ) item
        ), effective AS (
          SELECT DISTINCT ON (layered.logical_path COLLATE "C") layered.*
          FROM layered
          ORDER BY layered.logical_path COLLATE "C", layered.depth
        )
        SELECT effective.logical_path
        FROM effective
        WHERE NOT effective.deleted
        ORDER BY effective.logical_path COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      const logicalPaths = rows.slice(0, input.limit).map((row) => row.logical_path);
      const last = logicalPaths.at(-1);
      return {
        byFileLogicalPaths: logicalPaths.filter((path) =>
          /^_graph\/by-file\/[^/]+\.json$/u.test(path)),
        markdownLogicalPaths: logicalPaths.filter((path) =>
          path.endsWith(".md")
          && (
            isAllowedPublicBundleFilePath(path)
            || isObsoleteExtensionNavigationPath(path)
          )),
        scannedCount: logicalPaths.length,
        nextCursor: rows.length > input.limit && last
          ? encodeExtensionPathCursor({
              scope: input.candidatePublicId,
              logicalPath: last
            })
          : null
      };
    },

    async summarizeCandidate(input) {
      assertId(input.knowledgeBaseId);
      assertId(input.candidatePublicId);
      assertId(input.operationPublicId);
      const rows = await sql<SummaryRow[]>`
        WITH candidate_scope AS MATERIALIZED (
          SELECT candidate.candidate_root_public_id
          FROM focowiki.release_candidates candidate
          WHERE candidate.public_id = ${input.candidatePublicId}
            AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate.operation_public_id = ${input.operationPublicId}
            AND candidate.state = 'building'
        ), generated AS MATERIALIZED (
          SELECT count(*) AS generated_entry_count,
                 coalesce(sum(entry.byte_count), 0) AS generated_byte_count
          FROM candidate_scope scope
          CROSS JOIN LATERAL focowiki.resolve_release_catalog(
            scope.candidate_root_public_id
          ) entry
          WHERE entry.source_file_public_id IS NULL OR EXISTS (
            SELECT 1 FROM focowiki.source_files source
            WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.public_id = entry.source_file_public_id
              AND source.deleted_at IS NULL
          )
        )
        SELECT counts.source_file_count, counts.directory_count,
               counts.graph_node_count, counts.graph_edge_count,
               generated.generated_entry_count, generated.generated_byte_count
        FROM candidate_scope
        CROSS JOIN LATERAL (
          SELECT
            (SELECT count(*) FROM focowiki.source_files source
             JOIN focowiki.source_file_current_revisions current_revision
               ON current_revision.knowledge_base_id = source.knowledge_base_id
              AND current_revision.source_file_public_id = source.public_id
             WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
               AND source.deleted_at IS NULL
               AND source.status = 'ready') AS source_file_count,
            1 + (SELECT count(*) FROM focowiki.source_directories directory
                 WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
                   AND directory.deleted_at IS NULL) AS directory_count,
            (SELECT count(*) FROM focowiki.graph_nodes node
             JOIN focowiki.source_file_current_revisions current_revision
               ON current_revision.knowledge_base_id = node.knowledge_base_id
              AND current_revision.source_file_public_id = node.source_file_public_id
              AND current_revision.source_revision_public_id = node.source_revision_public_id
             WHERE node.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_node_count,
            (SELECT count(*) FROM focowiki.graph_edges edge
             JOIN focowiki.graph_nodes source_node
               ON source_node.knowledge_base_id = edge.knowledge_base_id
              AND source_node.public_id = edge.from_node_public_id
             JOIN focowiki.graph_nodes target_node
               ON target_node.knowledge_base_id = edge.knowledge_base_id
              AND target_node.public_id = edge.to_node_public_id
             JOIN focowiki.source_file_current_revisions source_current
               ON source_current.knowledge_base_id = source_node.knowledge_base_id
              AND source_current.source_file_public_id = source_node.source_file_public_id
              AND source_current.source_revision_public_id = source_node.source_revision_public_id
             JOIN focowiki.source_file_current_revisions target_current
               ON target_current.knowledge_base_id = target_node.knowledge_base_id
              AND target_current.source_file_public_id = target_node.source_file_public_id
              AND target_current.source_revision_public_id = target_node.source_revision_public_id
             WHERE edge.knowledge_base_id = ${input.knowledgeBaseId}) AS graph_edge_count
        ) counts
        CROSS JOIN generated
      `;
      const row = requireRow(rows[0]);
      return {
        ...mapCounts(row),
        generatedEntryCount: Number(row.generated_entry_count),
        generatedByteCount: Number(row.generated_byte_count)
      };
    }
  };
}

async function readNavigationLeaves(input: {
  sql: DatabaseClient;
  objects: Pick<StorageVnextImmutableBodyStore, "readVerified">;
  request: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    directoryPath: string;
    maximumBytes: number;
    signal: AbortSignal;
  };
  logicalKind: string;
  parse(request: { bytes: Uint8Array; directoryPath: string }): {
    partIndex: number;
    partCount: number;
    leaves: PersistentDirectoryLeaf[];
  };
}): Promise<readonly PersistentDirectoryLeaf[]> {
  assertId(input.request.knowledgeBaseId);
  assertId(input.request.candidatePublicId);
  assertPaths([input.request.directoryPath], 1);
  assertLimit(input.request.maximumBytes, Number.MAX_SAFE_INTEGER);
  const rows = await input.sql<DirectoryStateRow[]>`
    WITH RECURSIVE candidate_scope AS (
      SELECT candidate_root_public_id
      FROM focowiki.release_candidates candidate
      WHERE candidate.public_id = ${input.request.candidatePublicId}
        AND candidate.knowledge_base_id = ${input.request.knowledgeBaseId}
        AND candidate.state = 'building'
    ), lineage AS (
      SELECT root.public_id, root.base_root_public_id, 0 AS depth,
             ARRAY[root.public_id]::text[] AS visited
      FROM candidate_scope scope
      JOIN focowiki.release_roots root
        ON root.public_id = scope.candidate_root_public_id
      UNION ALL
      SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
             lineage.visited || base.public_id
      FROM lineage
      JOIN focowiki.release_roots base
        ON base.public_id = lineage.base_root_public_id
      WHERE lineage.depth < 63
        AND NOT base.public_id = ANY(lineage.visited)
    )
    SELECT lineage.depth, object.storage_key, shard.checksum_sha256,
           shard.byte_count, object.content_type, object.object_format
    FROM lineage
    JOIN focowiki.release_root_shards attached
      ON attached.release_root_public_id = lineage.public_id
    JOIN focowiki.release_shards shard
      ON shard.knowledge_base_id = ${input.request.knowledgeBaseId}
     AND shard.public_id = attached.release_shard_public_id
    JOIN focowiki.object_registrations object
      ON object.object_id = shard.object_id
     AND object.state = 'verified'
    WHERE shard.logical_kind = ${input.logicalKind}
      AND shard.first_logical_path = ${input.request.directoryPath}
      AND shard.last_logical_path = ${input.request.directoryPath}
    ORDER BY lineage.depth, attached.ordinal, shard.public_id COLLATE "C"
    LIMIT 65537
  `;
  if (rows.length > 65_536) throw snapshotError("navigation_state_limit_exceeded");
  const depth = rows[0] ? Number(rows[0].depth) : null;
  if (depth === null) return [];
  const parts = [];
  for (const row of rows.filter((item) => Number(item.depth) === depth)) {
    if (row.object_format !== "okf-generated-json-v1") {
      throw snapshotError("navigation_state_conflict");
    }
    const bytes = await input.objects.readVerified({
      descriptor: {
        objectId: `generated-sha256:${row.object_format}:${row.checksum_sha256}`,
        storageKey: row.storage_key,
        checksum: row.checksum_sha256,
        byteCount: Number(row.byte_count),
        contentType: row.content_type,
        objectFormat: row.object_format
      },
      maximumBytes: input.request.maximumBytes,
      signal: input.request.signal
    });
    parts.push(input.parse({
      bytes,
      directoryPath: input.request.directoryPath
    }));
  }
  parts.sort((left, right) => left.partIndex - right.partIndex);
  if (parts.some((part, index) =>
    part.partIndex !== index || part.partCount !== parts.length)) {
    throw snapshotError("navigation_state_conflict");
  }
  return parts.flatMap((part) => part.leaves);
}

async function findEffectiveGeneratedObject(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    logicalPath: string;
  }
): Promise<GeneratedObjectRow | null> {
  const rows = await sql<GeneratedObjectRow[]>`
    WITH RECURSIVE lineage AS (
      SELECT root.public_id, root.base_root_public_id, 0 AS depth,
             ARRAY[root.public_id]::text[] AS visited
      FROM focowiki.release_candidates candidate
      JOIN focowiki.release_roots root
        ON root.public_id = candidate.candidate_root_public_id
       AND root.knowledge_base_id = candidate.knowledge_base_id
      WHERE candidate.public_id = ${input.candidatePublicId}
        AND candidate.knowledge_base_id = ${input.knowledgeBaseId}
        AND candidate.state = 'building'
      UNION ALL
      SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
             lineage.visited || base.public_id
      FROM lineage
      JOIN focowiki.release_roots base
        ON base.public_id = lineage.base_root_public_id
       AND base.knowledge_base_id = ${input.knowledgeBaseId}
      WHERE lineage.depth < 63
        AND NOT base.public_id = ANY(lineage.visited)
    ), layered AS (
      SELECT item.logical_path, item.object_id, item.checksum_sha256,
             item.byte_count, lineage.depth, item.deleted
      FROM lineage
      CROSS JOIN LATERAL (
        SELECT entry.logical_path, entry.object_id, entry.checksum_sha256,
               entry.byte_count, false AS deleted
        FROM focowiki.release_catalog_entries entry
        WHERE entry.release_root_public_id = lineage.public_id
          AND entry.knowledge_base_id = ${input.knowledgeBaseId}
          AND entry.logical_path = ${input.logicalPath}
        UNION ALL
        SELECT tombstone.logical_path, NULL::text, NULL::text, NULL::bigint,
               true AS deleted
        FROM focowiki.release_catalog_tombstones tombstone
        WHERE tombstone.release_root_public_id = lineage.public_id
          AND tombstone.knowledge_base_id = ${input.knowledgeBaseId}
          AND tombstone.logical_path = ${input.logicalPath}
      ) item
    ), effective AS MATERIALIZED (
      SELECT layered.*
      FROM layered
      ORDER BY layered.depth
      LIMIT 1
    )
    SELECT entry.logical_path, entry.object_id, object.storage_key,
           entry.checksum_sha256, entry.byte_count,
           object.content_type, object.object_format
    FROM effective entry
    JOIN focowiki.object_registrations object
      ON object.object_id = entry.object_id
     AND object.state = 'verified'
    WHERE NOT entry.deleted
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function readGeneratedObject(
  objects: Pick<StorageVnextImmutableBodyStore, "readVerified">,
  row: GeneratedObjectRow,
  input: { maximumBytes: number; signal?: AbortSignal }
): Promise<Uint8Array> {
  if (row.object_format !== "okf-generated-json-v1") {
    throw snapshotError("invalid_projection_object");
  }
  return objects.readVerified({
    descriptor: {
      objectId: row.object_id,
      storageKey: row.storage_key,
      checksum: row.checksum_sha256,
      byteCount: Number(row.byte_count),
      contentType: row.content_type,
      objectFormat: row.object_format
    },
    maximumBytes: input.maximumBytes,
    ...(input.signal ? { signal: input.signal } : {})
  });
}

function parseProjectionRecords(bytes: Uint8Array): JsonProjectionRecord[] {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw snapshotError("invalid_projection_object");
  }
  try {
    return parseShard(text);
  } catch {
    throw snapshotError("invalid_projection_object");
  }
}

function mapCounts(row: CountRow) {
  return {
    sourceFileCount: Number(row.source_file_count),
    directoryCount: Number(row.directory_count),
    graphNodeCount: Number(row.graph_node_count),
    graphEdgeCount: Number(row.graph_edge_count)
  };
}

function toProjectionShard(
  row: Pick<GeneratedObjectRow, "logical_path">,
  recordCount: number
): EffectiveProjectionShard {
  const match = PUBLIC_PROJECTION_PATH.exec(row.logical_path);
  if (!match?.[1] || !match[2]) throw snapshotError("invalid_projection_shard");
  return {
    projectionKind: match[1],
    shardKey: `${match[1]}/${match[2]}`,
    logicalPath: row.logical_path,
    recordCount
  };
}

function assertPaths(paths: readonly string[], maximum: number): void {
  if (
    paths.length > maximum
    || new Set(paths).size !== paths.length
    || paths.some((path) =>
      !path || Buffer.byteLength(path, "utf8") > 4_096)
  ) throw snapshotError("invalid_input");
}

function assertLimit(value: number, maximum: number): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw snapshotError("invalid_input");
  }
}

function assertId(value: string): void {
  if (!value || Buffer.byteLength(value) > 255) throw snapshotError("invalid_input");
}

type ExtensionPathCursor = { scope: string; logicalPath: string };

function encodeExtensionPathCursor(cursor: ExtensionPathCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeExtensionPathCursor(
  value: string | null,
  scope: string
): ExtensionPathCursor | null {
  if (value === null) return null;
  try {
    const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isRecord(cursor)
      || cursor.scope !== scope
      || typeof cursor.logicalPath !== "string"
      || !cursor.logicalPath
      || Buffer.byteLength(cursor.logicalPath, "utf8") > 4_096
    ) throw new Error("invalid");
    return { scope, logicalPath: cursor.logicalPath };
  } catch {
    throw snapshotError("invalid_extension_path_cursor");
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isObsoleteExtensionNavigationPath(path: string): boolean {
  return /^_(?:index|graph)\/(?:manifest|search|links|tree|graph_node|graph_edge)\/v1\/index-map-[0-9]+\.md$/u.test(path)
    || /^_graph\/by-file\/index-map-[0-9]+\.md$/u.test(path);
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw snapshotError("scope_unavailable");
  return row;
}

function snapshotError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication snapshot error: ${code}`),
    { code }
  );
}
