import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextDeletionPurgePostgresPort,
  StorageVnextDeletionPurgeScope
} from "./deletion-purge.js";

const MAX_PAGE_SIZE = 1_000;
const EXPECTED_MAX_REVISIONS_PER_SOURCE = 3;

export function createPostgresStorageVnextDeletionPurgeRepository(
  sql: DatabaseClient
): StorageVnextDeletionPurgePostgresPort {
  return {
    async readScopePage(input) {
      validateScope(input);
      const limit = assertLimit(input.limit);
      if (input.targetKind === "knowledge_base") {
        const rows = await sql<Array<{ object_id: string }>>`
          WITH referenced AS (
            SELECT owner.object_id
            FROM focowiki.object_owners owner
            WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
            UNION
            SELECT revision.object_id
            FROM focowiki.source_revisions revision
            WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
            UNION
            SELECT shard.object_id
            FROM focowiki.release_shards shard
            WHERE shard.knowledge_base_id = ${input.knowledgeBaseId}
            UNION
            SELECT entry.object_id
            FROM focowiki.release_catalog_entries entry
            WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
          )
          SELECT object_id
          FROM referenced
          WHERE ${input.cursor}::text IS NULL
             OR object_id COLLATE "C" > ${input.cursor}::text COLLATE "C"
          ORDER BY object_id COLLATE "C"
          LIMIT ${limit + 1}
        `;
        return {
          sourceFilePublicIds: [],
          objectIds: rows.slice(0, limit).map((row) => row.object_id),
          nextCursor: rows.length > limit ? rows[limit - 1]!.object_id : null
        };
      }
      const sourceLimit = Math.max(
        1,
        Math.floor(limit / EXPECTED_MAX_REVISIONS_PER_SOURCE)
      );
      const sources = await readDeletedSources(sql, input, sourceLimit + 1);
      const selected = sources.slice(0, sourceLimit);
      const sourceFilePublicIds = selected.map((row) => row.public_id);
      const objectRows = sourceFilePublicIds.length === 0
        ? []
        : await sql<Array<{ object_id: string }>>`
            SELECT object_id COLLATE "C" AS object_id
            FROM focowiki.source_revisions
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND source_file_public_id = ANY(${sourceFilePublicIds}::text[])
            GROUP BY object_id
            ORDER BY object_id COLLATE "C"
          `;
      if (objectRows.length > limit) throw purgeError("object_page_limit_exceeded");
      return {
        sourceFilePublicIds,
        objectIds: objectRows.map((row) => row.object_id),
        nextCursor: sources.length > sourceLimit
          ? sourceFilePublicIds.at(-1) ?? null
          : null
      };
    },

    async purgeSourceGraph(input) {
      validateSourceBatch(input);
      if (input.sourceFilePublicIds.length === 0) return;
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.graph_evidence_refs
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds}::text[])
        `;
        await transaction`
          DELETE FROM focowiki.graph_nodes
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND source_file_public_id = ANY(${input.sourceFilePublicIds}::text[])
        `;
      });
    },

    async purgeKnowledgeBaseGraph(input) {
      validateKnowledgeBaseScope(input);
      await sql`
        DELETE FROM focowiki.graph_nodes
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
      `;
    },

    async purgeSourceRelease(input) {
      validateSourceBatch(input);
      if (input.sourceFilePublicIds.length === 0) return;
      await sql.begin(async (transaction) => {
        const activeReferences = await transaction<Array<{ present: boolean }>>`
          SELECT EXISTS (
            SELECT 1
            FROM focowiki.release_catalog_entries entry
            JOIN focowiki.release_roots root
              ON root.knowledge_base_id = entry.knowledge_base_id
             AND root.public_id = entry.release_root_public_id
            WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
              AND entry.source_file_public_id
                = ANY(${input.sourceFilePublicIds}::text[])
              AND root.root_role = 'active'
          ) AS present
        `;
        if (activeReferences[0]?.present) throw purgeError("release_pending");
        const removed = await transaction<Array<{
          release_root_public_id: string;
          object_id: string;
        }>>`
          DELETE FROM focowiki.release_catalog_entries entry
          USING focowiki.release_roots root
          WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
            AND entry.source_file_public_id
              = ANY(${input.sourceFilePublicIds}::text[])
            AND root.knowledge_base_id = entry.knowledge_base_id
            AND root.public_id = entry.release_root_public_id
            AND root.root_role <> 'active'
          RETURNING entry.release_root_public_id, entry.object_id
        `;
        for (const reference of removed) {
          await transaction`
            DELETE FROM focowiki.object_owners owner
            WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
              AND owner.object_id = ${reference.object_id}
              AND owner.release_root_public_id = ${reference.release_root_public_id}
              AND NOT EXISTS (
                SELECT 1 FROM focowiki.release_catalog_entries entry
                WHERE entry.release_root_public_id = ${reference.release_root_public_id}
                  AND entry.object_id = ${reference.object_id}
              )
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.release_root_shards attached
                JOIN focowiki.release_shards shard
                  ON shard.knowledge_base_id = attached.knowledge_base_id
                 AND shard.public_id = attached.release_shard_public_id
                WHERE attached.release_root_public_id = ${reference.release_root_public_id}
                  AND shard.object_id = ${reference.object_id}
              )
          `;
        }
        await markZeroOwner(transaction, removed.map((item) => item.object_id));
      });
    },

    async purgeKnowledgeBaseRelease(input) {
      validateKnowledgeBaseScope(input);
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.active_snapshots
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_candidates
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
      });
    },

    async releaseSourceOwners(input) {
      validateObjectBatch(input);
      if (input.objectIds.length === 0) return;
      validateIdentifiers(input.sourceFilePublicIds);
      if (input.sourceFilePublicIds.length === 0) return;
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.object_owners owner
          WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
            AND owner.object_id = ANY(${input.objectIds}::text[])
            AND owner.source_revision_public_id IN (
              SELECT revision.public_id
              FROM focowiki.source_revisions revision
              WHERE revision.knowledge_base_id = ${input.knowledgeBaseId}
                AND revision.source_file_public_id
                  = ANY(${input.sourceFilePublicIds}::text[])
            )
        `;
        await markZeroOwner(transaction, input.objectIds);
      });
    },

    async releaseKnowledgeBaseOwners(input) {
      validateKnowledgeBaseScope(input);
      validateIdentifiers(input.objectIds);
      if (input.objectIds.length === 0) return;
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.object_owners
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND object_id = ANY(${input.objectIds}::text[])
        `;
        await markZeroOwner(transaction, input.objectIds);
      });
    },

    async purgeSourceCatalog(input) {
      validateSourceBatch(input);
      await sql.begin(async (transaction) => {
        if (input.sourceFilePublicIds.length > 0) {
          await transaction`
            DELETE FROM focowiki.source_files
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ANY(${input.sourceFilePublicIds}::text[])
              AND deleted_at IS NOT NULL
          `;
        }
        if (input.targetKind === "source_directory" && input.finalPage) {
          const directoryIds = await readDeletedDirectoryIds(transaction, input);
          if (directoryIds.length > 0) {
            await transaction`
              DELETE FROM focowiki.directory_summaries
              WHERE knowledge_base_id = ${input.knowledgeBaseId}
                AND directory_public_id = ANY(${directoryIds}::text[])
            `;
            await transaction`
              DELETE FROM focowiki.source_directories
              WHERE knowledge_base_id = ${input.knowledgeBaseId}
                AND public_id = ANY(${directoryIds}::text[])
                AND deleted_at IS NOT NULL
            `;
          }
        }
        await deletePurgedRegistrations(transaction);
      });
    },

    async purgeKnowledgeBaseCatalog(input) {
      validateKnowledgeBaseScope(input);
      await sql.begin(async (transaction) => {
        await transaction`
          DELETE FROM focowiki.security_audit_events
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.active_snapshots
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_candidates
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_catalog_entries
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.directory_summaries
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.knowledge_base_summaries
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_root_shards
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_shards
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.release_roots
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.source_files
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.source_directories
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
        `;
        await transaction`
          DELETE FROM focowiki.knowledge_bases
          WHERE public_id = ${input.knowledgeBaseId}
            AND deleted_at IS NOT NULL
        `;
        await transaction`
          UPDATE focowiki.object_registrations registration
          SET zero_owner_since = COALESCE(zero_owner_since, now())
          WHERE registration.state = 'verified'
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.object_owners owner
              WHERE owner.object_id = registration.object_id
            )
        `;
        await deletePurgedRegistrations(transaction);
      });
    },

    async verifyDeletionClosure(input) {
      validateScope(input);
      let rows: Array<{ residue_count: number | string }>;
      if (input.targetKind === "knowledge_base") {
        rows = await sql<Array<{ residue_count: number | string }>>`
            SELECT count(*) AS residue_count
            FROM focowiki.knowledge_bases
            WHERE public_id = ${input.knowledgeBaseId}
          `;
      } else if (input.targetKind === "source_directory") {
        const prefix = requiredNormalizedPath(input);
        rows = await sql<Array<{ residue_count: number | string }>>`
          SELECT (
            (SELECT count(*) FROM focowiki.source_files source
             WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
               AND source.normalized_path
                 LIKE ${`${escapeLike(prefix)}/%`} ESCAPE '\\')
            +
            (SELECT count(*) FROM focowiki.source_directories directory
             WHERE directory.knowledge_base_id = ${input.knowledgeBaseId}
               AND (directory.normalized_path = ${prefix}
                 OR directory.normalized_path
                   LIKE ${`${escapeLike(prefix)}/%`} ESCAPE '\\'))
          ) AS residue_count
        `;
      } else {
        rows = await sql<Array<{ residue_count: number | string }>>`
            SELECT (
              (SELECT count(*) FROM focowiki.source_files source
               WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                 AND source.public_id = ${input.targetPublicId})
              +
              (SELECT count(*) FROM focowiki.release_catalog_entries entry
               WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
                 AND entry.source_file_public_id = ${input.targetPublicId})
              +
              (SELECT count(*) FROM focowiki.graph_nodes node
               WHERE node.knowledge_base_id = ${input.knowledgeBaseId}
                 AND node.source_file_public_id = ${input.targetPublicId})
            ) AS residue_count
          `;
      }
      if (Number(rows[0]?.residue_count ?? 0) !== 0) {
        throw purgeError("deletion_residue");
      }
    }
  };
}

async function readDeletedSources(
  sql: DatabaseClient,
  input: StorageVnextDeletionPurgeScope,
  limit: number
): Promise<Array<{ public_id: string }>> {
  if (input.targetKind === "source_file") {
    return sql<Array<{ public_id: string }>>`
      SELECT public_id FROM focowiki.source_files
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND public_id = ${input.targetPublicId}
        AND deleted_at IS NOT NULL
        AND (${input.cursor}::text IS NULL
          OR public_id COLLATE "C" > ${input.cursor}::text COLLATE "C")
      ORDER BY public_id COLLATE "C"
      LIMIT ${limit}
    `;
  }
  const prefix = requiredNormalizedPath(input);
  return sql<Array<{ public_id: string }>>`
    SELECT public_id FROM focowiki.source_files
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND normalized_path LIKE ${`${escapeLike(prefix)}/%`} ESCAPE '\\'
      AND deleted_at IS NOT NULL
      AND (${input.cursor}::text IS NULL
        OR public_id COLLATE "C" > ${input.cursor}::text COLLATE "C")
    ORDER BY public_id COLLATE "C"
    LIMIT ${limit}
  `;
}

async function readDeletedDirectoryIds(
  transaction: TransactionSql,
  input: StorageVnextDeletionPurgeScope
): Promise<string[]> {
  const prefix = requiredNormalizedPath(input);
  const rows = await transaction<Array<{ public_id: string }>>`
    SELECT public_id
    FROM focowiki.source_directories
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND (normalized_path = ${prefix}
        OR normalized_path LIKE ${`${escapeLike(prefix)}/%`} ESCAPE '\\')
      AND deleted_at IS NOT NULL
    ORDER BY length(normalized_path) DESC, public_id COLLATE "C"
  `;
  return rows.map((row) => row.public_id);
}

async function markZeroOwner(
  transaction: TransactionSql,
  objectIds: readonly string[]
): Promise<void> {
  const unique = [...new Set(objectIds)];
  if (unique.length === 0) return;
  await transaction`
    UPDATE focowiki.object_registrations registration
    SET zero_owner_since = COALESCE(zero_owner_since, now())
    WHERE registration.object_id = ANY(${unique}::text[])
      AND registration.state = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
  `;
}

async function deletePurgedRegistrations(transaction: TransactionSql): Promise<void> {
  await transaction`
    DELETE FROM focowiki.object_registrations registration
    WHERE registration.state = 'deleted'
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = registration.object_id
      )
  `;
}

function validateSourceBatch(
  input: StorageVnextDeletionPurgeScope & { sourceFilePublicIds: readonly string[] }
): void {
  validateScope(input);
  if (input.targetKind === "knowledge_base") throw purgeError("scope_conflict");
  validateIdentifiers(input.sourceFilePublicIds);
}

function validateObjectBatch(
  input: StorageVnextDeletionPurgeScope & { objectIds: readonly string[] }
): void {
  validateScope(input);
  if (input.targetKind === "knowledge_base") throw purgeError("scope_conflict");
  validateIdentifiers(input.objectIds);
}

function validateKnowledgeBaseScope(input: StorageVnextDeletionPurgeScope): void {
  validateScope(input);
  if (
    input.targetKind !== "knowledge_base"
    || input.targetPublicId !== input.knowledgeBaseId
  ) throw purgeError("scope_conflict");
}

function validateScope(input: StorageVnextDeletionPurgeScope): void {
  validateIdentifiers([
    input.knowledgeBaseId,
    input.operationPublicId,
    input.targetPublicId,
    ...(input.cursor ? [input.cursor] : [])
  ]);
  if (![
    "source_file",
    "source_directory",
    "knowledge_base"
  ].includes(input.targetKind)) throw purgeError("invalid_input");
}

function validateIdentifiers(values: readonly string[]): void {
  if (values.length > MAX_PAGE_SIZE || values.some((value) =>
    !value || Buffer.byteLength(value) > 255 || value.includes("\0"))) {
    throw purgeError("invalid_input");
  }
}

function requiredNormalizedPath(input: StorageVnextDeletionPurgeScope): string {
  if (
    input.targetKind !== "source_directory"
    || !input.normalizedPath
    || Buffer.byteLength(input.normalizedPath) > 4_096
    || input.normalizedPath.includes("\0")
  ) throw purgeError("invalid_input");
  return input.normalizedPath;
}

function assertLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_SIZE) {
    throw purgeError("invalid_input");
  }
  return value;
}

function escapeLike(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");
}

function purgeError(code: string): Error {
  return Object.assign(new Error(`Storage vNext deletion purge repository error: ${code}`), {
    code
  });
}
