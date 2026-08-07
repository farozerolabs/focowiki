import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import { enqueueStorageVnextCandidateObjectCleanupActions } from
  "../cleanup/postgres-candidate-object-actions.js";
import type { StorageVnextActiveSnapshot } from "../transactions/ports.js";
import { STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE } from
  "../publication/profile.js";
import {
  evaluateStorageVnextObjectFanoutBudget,
  measureStorageVnextObjectFanout
} from "../ownership/object-fanout-budget.js";
import {
  MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS,
  MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES,
  MAX_STORAGE_VNEXT_CANDIDATE_SHARDS,
  MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH,
  type StorageVnextCandidateChangedFact,
  type StorageVnextCandidateDelta,
  type StorageVnextCandidateDependency,
  type StorageVnextReleaseEventSummary,
  type StorageVnextReleaseReadPort,
  type StorageVnextReleaseRoot,
  type StorageVnextReleaseWritePort,
  type StorageVnextShardDescriptor
} from "./ports.js";
import {
  StorageVnextReleaseRepositoryError,
  assertStorageVnextExpectedActive,
  assertStorageVnextReleaseChecksum,
  assertStorageVnextReleasePageLimit,
  assertStorageVnextTimestampOrder,
  decodeStorageVnextReleaseCursor,
  encodeStorageVnextReleaseCursor,
  isStorageVnextReleaseTimestamp,
  mapStorageVnextCandidate,
  mapStorageVnextCatalogEntry,
  mapStorageVnextDirectorySummary,
  mapStorageVnextKnowledgeBaseSummary,
  mapStorageVnextReleaseEvent,
  mapStorageVnextReleaseRoot,
  mapStorageVnextShard,
  storageVnextCandidateValidationPassed,
  storageVnextReleasePage,
  storageVnextReleaseTimestamp,
  storageVnextRootOwnerPublicId,
  storageVnextStaleResult,
  uniqueStorageVnextValues,
  validateStorageVnextActivation,
  validateStorageVnextCandidateCreation,
  validateStorageVnextCandidateValidationReceipt,
  validateStorageVnextCatalogBatch,
  validateStorageVnextCatalogTombstones,
  validateStorageVnextFactBatch,
  validateStorageVnextShardBatch,
  validateStorageVnextSummaries,
  validateStorageVnextTerminalInput,
  type StorageVnextReleaseCandidateRow,
  type StorageVnextReleaseCatalogRow,
  type StorageVnextReleaseDirectorySummaryRow,
  type StorageVnextReleaseEventRow,
  type StorageVnextReleaseKnowledgeBaseSummaryRow,
  type StorageVnextReleaseRootRow,
  type StorageVnextReleaseShardRow
} from "./postgres-contract.js";

export {
  StorageVnextReleaseRepositoryError,
  type StorageVnextReleaseRepositoryErrorCode
} from "./postgres-contract.js";

export type StorageVnextReleaseRepository =
  & StorageVnextReleaseReadPort
  & StorageVnextReleaseWritePort;

const MAX_STORAGE_VNEXT_RELEASE_LINEAGE_DEPTH = 8;
const STORAGE_VNEXT_DIRECTORY_NAVIGATION_SHARD_KIND = "directory_navigation";
const STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND = "extension_navigation";

export type StorageVnextReleaseLifecycleHooks = {
  beforeActivate?(input: {
    transaction: TransactionSql;
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    rollbackExpiresAt: string | null;
    eventExpiresAt: string;
    activatedAt: string;
  }): Promise<void>;
  beforeTerminate?(input: {
    transaction: TransactionSql;
    knowledgeBaseId: string;
    candidatePublicId: string;
    operationPublicId: string;
    outcome: "failed" | "cancelled" | "superseded" | "timed_out";
    reasonCode: string;
    eventExpiresAt: string;
    terminatedAt: string;
  }): Promise<void>;
};

type ReadSql = DatabaseClient | TransactionSql;

export function createPostgresStorageVnextReleaseRepository(
  sql: DatabaseClient,
  options: { lifecycleHooks?: StorageVnextReleaseLifecycleHooks } = {}
): StorageVnextReleaseRepository {
  return {
    async getActiveRoot(knowledgeBaseId) {
      return readRootByRole(sql, knowledgeBaseId, "active");
    },

    async getLiveCandidate(knowledgeBaseId) {
      const rows = await sql<StorageVnextReleaseCandidateRow[]>`
        SELECT public_id, knowledge_base_id, operation_public_id,
               candidate_root_public_id, expected_active_root_public_id,
               expected_active_revision, state, changed_fact_count,
               affected_dependency_count, manifest_checksum_sha256,
               created_at, updated_at
        FROM focowiki.release_candidates
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND state IN ('building', 'validating', 'ready')
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = ${knowledgeBaseId}
              AND knowledge_base.deleted_at IS NULL
          )
        LIMIT 1
      `;
      return rows[0] ? mapStorageVnextCandidate(rows[0]) : null;
    },

    async getRollbackRoot(knowledgeBaseId) {
      const rows = await sql<StorageVnextReleaseRootRow[]>`
        SELECT public_id, knowledge_base_id, root_role,
               manifest_checksum_sha256, navigation_profile_version,
               revision, created_at, expires_at
        FROM focowiki.release_roots
        WHERE knowledge_base_id = ${knowledgeBaseId}
          AND root_role = 'rollback'
          AND expires_at > now()
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = ${knowledgeBaseId}
              AND knowledge_base.deleted_at IS NULL
          )
        LIMIT 1
      `;
      return rows[0] ? mapStorageVnextReleaseRoot(rows[0]) : null;
    },

    async listCandidateChangedFacts(input) {
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const cursor = decodeStorageVnextReleaseCursor(input.cursor, "candidate_fact", input.candidatePublicId);
      const rows = await sql<Array<{
        fact_kind: StorageVnextCandidateChangedFact["kind"];
        fact_public_id: string;
        change_kind: StorageVnextCandidateChangedFact["change"];
      }>>`
        SELECT fact_kind, fact_public_id, change_kind
        FROM focowiki.release_candidate_changed_facts
        WHERE candidate_public_id = ${input.candidatePublicId}
          AND (
            ${cursor?.sort ?? null}::text IS NULL
            OR (fact_kind, fact_public_id) >
               (${cursor?.sort ?? null}::text, ${cursor?.publicId ?? null}::text)
          )
        ORDER BY fact_kind COLLATE "C", fact_public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map((row) => ({
        kind: row.fact_kind,
        publicId: row.fact_public_id,
        change: row.change_kind
      }));
      return storageVnextReleasePage(items, rows.length > limit, (item) => encodeStorageVnextReleaseCursor({
        kind: "candidate_fact",
        scope: input.candidatePublicId,
        sort: item.kind,
        publicId: item.publicId
      }));
    },

    async listCandidateDependencies(input) {
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const cursor = decodeStorageVnextReleaseCursor(
        input.cursor,
        "candidate_dependency",
        input.candidatePublicId
      );
      const rows = await sql<Array<{
        dependency_kind: StorageVnextCandidateDependency["kind"];
        dependency_public_id: string;
        reason_code: string;
      }>>`
        SELECT dependency_kind, dependency_public_id, reason_code
        FROM focowiki.release_candidate_dependencies
        WHERE candidate_public_id = ${input.candidatePublicId}
          AND (
            ${cursor?.sort ?? null}::text IS NULL
            OR (dependency_kind, dependency_public_id) >
               (${cursor?.sort ?? null}::text, ${cursor?.publicId ?? null}::text)
          )
        ORDER BY dependency_kind COLLATE "C", dependency_public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map((row) => ({
        kind: row.dependency_kind,
        publicId: row.dependency_public_id,
        reasonCode: row.reason_code
      }));
      return storageVnextReleasePage(items, rows.length > limit, (item) => encodeStorageVnextReleaseCursor({
        kind: "candidate_dependency",
        scope: input.candidatePublicId,
        sort: item.kind,
        publicId: item.publicId
      }));
    },

    async listCandidateShards(input) {
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const cursor = decodeStorageVnextReleaseCursor(input.cursor, "candidate_shard", input.candidatePublicId);
      const rows = await sql<StorageVnextReleaseShardRow[]>`
        SELECT shard.public_id, shard.logical_kind, shard.first_logical_path,
               shard.last_logical_path, shard.record_count, shard.byte_count,
               shard.checksum_sha256, shard.object_id, attached.ordinal
        FROM focowiki.release_candidates candidate
        JOIN focowiki.release_root_shards attached
          ON attached.knowledge_base_id = candidate.knowledge_base_id
         AND attached.release_root_public_id = candidate.candidate_root_public_id
        JOIN focowiki.release_shards shard
          ON shard.knowledge_base_id = attached.knowledge_base_id
         AND shard.public_id = attached.release_shard_public_id
        WHERE candidate.public_id = ${input.candidatePublicId}
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR shard.public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY shard.public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextShard);
      return storageVnextReleasePage(items, rows.length > limit, (item) => encodeStorageVnextReleaseCursor({
        kind: "candidate_shard",
        scope: input.candidatePublicId,
        sort: "",
        publicId: item.publicId
      }));
    },

    async listRootCatalogEntries(input) {
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const parentPath = input.parentPath;
      const entryType = input.entryType ?? null;
      const query = input.query?.trim().toLocaleLowerCase("en-US") || null;
      const scope = [
        input.knowledgeBaseId,
        input.releaseRootPublicId,
        parentPath ?? "*",
        entryType ?? "*",
        query ?? ""
      ].join(":");
      const cursor = decodeStorageVnextReleaseCursor(input.cursor, "root_catalog", scope);
      const rows = await sql<StorageVnextReleaseCatalogRow[]>`
        SELECT logical_path, entry_kind, source_file_public_id,
               checksum_sha256, object_id, byte_count, ordinal
        FROM focowiki.release_roots root
        CROSS JOIN LATERAL focowiki.resolve_release_catalog(root.public_id) entry
        WHERE root.knowledge_base_id = ${input.knowledgeBaseId}
          AND root.public_id = ${input.releaseRootPublicId}
          AND (${parentPath ?? null}::text IS NULL OR
            CASE
              WHEN strpos(entry.logical_path, '/') = 0 THEN ''
              ELSE regexp_replace(entry.logical_path, '/[^/]+$', '')
            END = ${parentPath ?? null})
          AND (${entryType}::text IS NULL OR
            CASE WHEN entry.entry_kind = 'directory' THEN 'directory' ELSE 'file' END
              = ${entryType})
          AND (${query}::text IS NULL OR strpos(lower(entry.logical_path), ${query}) > 0)
          AND EXISTS (
            SELECT 1 FROM focowiki.knowledge_bases knowledge_base
            WHERE knowledge_base.public_id = ${input.knowledgeBaseId}
              AND knowledge_base.deleted_at IS NULL
          )
          AND (
            entry.source_file_public_id IS NULL
            OR EXISTS (
              SELECT 1 FROM focowiki.source_files source
              WHERE source.knowledge_base_id = ${input.knowledgeBaseId}
                AND source.public_id = entry.source_file_public_id
                AND source.deleted_at IS NULL
            )
          )
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR entry.logical_path COLLATE "C"
              > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY entry.logical_path COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextCatalogEntry);
      return storageVnextReleasePage(items, rows.length > limit, (item) => encodeStorageVnextReleaseCursor({
        kind: "root_catalog",
        scope,
        sort: "",
        publicId: item.logicalPath
      }));
    },

    async listDirectorySummaries(input) {
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const scope = `${input.knowledgeBaseId}:${input.releaseRootPublicId}`;
      const cursor = decodeStorageVnextReleaseCursor(input.cursor, "directory_summary", scope);
      const rows = await sql<StorageVnextReleaseDirectorySummaryRow[]>`
        SELECT directory_public_id, logical_path, first_leaf_path,
               direct_file_count, descendant_file_count, ordinal
        FROM focowiki.release_roots root
        CROSS JOIN LATERAL focowiki.resolve_release_directory_summaries(
          root.public_id
        ) summary
        WHERE root.knowledge_base_id = ${input.knowledgeBaseId}
          AND root.public_id = ${input.releaseRootPublicId}
          AND (${cursor?.publicId ?? null}::text IS NULL
            OR logical_path COLLATE "C"
              > ${cursor?.publicId ?? null}::text COLLATE "C")
        ORDER BY logical_path COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextDirectorySummary);
      return storageVnextReleasePage(items, rows.length > limit, (item) => encodeStorageVnextReleaseCursor({
        kind: "directory_summary",
        scope,
        sort: "",
        publicId: item.logicalPath
      }));
    },

    async getKnowledgeBaseSummary(input) {
      const rows = await sql<StorageVnextReleaseKnowledgeBaseSummaryRow[]>`
        SELECT source_file_count, directory_count, generated_entry_count,
               graph_node_count, graph_edge_count, generated_byte_count
        FROM focowiki.release_roots root
        CROSS JOIN LATERAL focowiki.resolve_release_knowledge_base_summary(
          root.public_id
        ) summary
        WHERE root.knowledge_base_id = ${input.knowledgeBaseId}
          AND root.public_id = ${input.releaseRootPublicId}
      `;
      return rows[0] ? mapStorageVnextKnowledgeBaseSummary(rows[0]) : null;
    },

    async countCandidateOwnedObjects(candidatePublicId) {
      if (!candidatePublicId) {
        throw new StorageVnextReleaseRepositoryError("invalid_input");
      }
      const rows = await sql<Array<{ object_count: number | string }>>`
        SELECT count(DISTINCT owner.object_id) AS object_count
        FROM focowiki.release_candidates candidate
        JOIN focowiki.object_owners owner
          ON owner.knowledge_base_id = candidate.knowledge_base_id
         AND owner.release_root_public_id = candidate.candidate_root_public_id
         AND owner.owner_kind = 'candidate_root'
        WHERE candidate.public_id = ${candidatePublicId}
          AND candidate.state IN ('building', 'validating', 'ready')
      `;
      return Number(rows[0]?.object_count ?? 0);
    },

    async hasCandidateCatalogEntries(candidatePublicId) {
      if (!candidatePublicId) {
        throw new StorageVnextReleaseRepositoryError("invalid_input");
      }
      const rows = await sql<Array<{ present: boolean }>>`
        SELECT EXISTS (
          SELECT 1
          FROM focowiki.release_candidates candidate
          JOIN focowiki.release_catalog_entries entry
            ON entry.knowledge_base_id = candidate.knowledge_base_id
           AND entry.release_root_public_id = candidate.candidate_root_public_id
          WHERE candidate.public_id = ${candidatePublicId}
            AND candidate.state = 'building'
        ) AS present
      `;
      return rows[0]?.present === true;
    },

    async listReleaseEvents(input) {
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const cursor = decodeStorageVnextReleaseCursor(input.cursor, "release_event", input.knowledgeBaseId);
      const rows = await sql<StorageVnextReleaseEventRow[]>`
        SELECT public_id, knowledge_base_id, operation_public_id,
               candidate_public_id, release_root_public_id, outcome,
               result_code, safe_message, revision, created_at, expires_at
        FROM focowiki.release_event_summaries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND expires_at > now()
          AND (
            ${cursor?.sort ?? null}::timestamptz IS NULL
            OR created_at < ${cursor?.sort ?? null}::timestamptz
            OR (
              created_at = ${cursor?.sort ?? null}::timestamptz
              AND public_id COLLATE "C" < ${cursor?.publicId ?? null}::text COLLATE "C"
            )
          )
        ORDER BY created_at DESC, public_id COLLATE "C" DESC
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapStorageVnextReleaseEvent);
      return storageVnextReleasePage(items, rows.length > limit, (item) => encodeStorageVnextReleaseCursor({
        kind: "release_event",
        scope: input.knowledgeBaseId,
        sort: item.createdAt,
        publicId: item.publicId
      }));
    },

    async createCandidate(input) {
      validateStorageVnextCandidateCreation(input);
      return sql.begin(async (transaction) => {
        await lockRelease(transaction, input.knowledgeBaseId);
        await requireIdempotentOperation(transaction, input);
        const active = await readActiveSnapshot(transaction, input.knowledgeBaseId, true);
        assertStorageVnextExpectedActive(active, input);
        const existing = await readCandidateByKnowledgeBase(
          transaction,
          input.knowledgeBaseId,
          true
        );
        if (existing) {
          if (
            existing.public_id === input.publicId
            && existing.operation_public_id === input.operationPublicId
            && existing.candidate_root_public_id === input.candidateRootPublicId
            && existing.expected_active_root_public_id === input.expectedActiveRootPublicId
            && Number(existing.expected_active_revision) === input.expectedActiveRevision
          ) {
            if (existing.state === "building") {
              await persistCandidateFacts(transaction, {
                candidatePublicId: input.publicId,
                knowledgeBaseId: input.knowledgeBaseId,
                changedFacts: input.changedFacts,
                dependencies: input.dependencies
              });
              return requireMappedCandidate(transaction, input.publicId);
            }
            return mapStorageVnextCandidate(existing);
          }
          throw new StorageVnextReleaseRepositoryError("live_candidate_exists");
        }
        await transaction`
          INSERT INTO focowiki.release_roots (
            public_id, knowledge_base_id, base_root_public_id, root_role,
            manifest_checksum_sha256, revision, created_at, expires_at
          ) VALUES (
            ${input.candidateRootPublicId}, ${input.knowledgeBaseId},
            ${input.expectedActiveRootPublicId}, 'candidate',
            NULL, ${input.expectedActiveRevision + 1}, ${input.createdAt}, NULL
          )
        `;
        await transaction`
          INSERT INTO focowiki.release_candidates (
            public_id, knowledge_base_id, operation_public_id,
            candidate_root_public_id, expected_active_root_public_id,
            expected_active_revision, state, changed_fact_count,
            affected_dependency_count, manifest_checksum_sha256,
            created_at, updated_at
          ) VALUES (
            ${input.publicId}, ${input.knowledgeBaseId}, ${input.operationPublicId},
            ${input.candidateRootPublicId}, ${input.expectedActiveRootPublicId},
            ${input.expectedActiveRevision}, 'building', 0, 0, NULL,
            ${input.createdAt}, ${input.createdAt}
          )
        `;
        await persistCandidateFacts(transaction, {
          candidatePublicId: input.publicId,
          knowledgeBaseId: input.knowledgeBaseId,
          changedFacts: input.changedFacts,
          dependencies: input.dependencies
        });
        return requireMappedCandidate(transaction, input.publicId);
      });
    },

    async addCandidateFacts(input) {
      validateStorageVnextFactBatch(input.changedFacts, input.dependencies);
      return sql.begin(async (transaction) => {
        const candidate = await requireWritableCandidate(transaction, input.candidatePublicId);
        await persistCandidateFacts(transaction, {
          candidatePublicId: input.candidatePublicId,
          knowledgeBaseId: candidate.knowledge_base_id,
          changedFacts: input.changedFacts,
          dependencies: input.dependencies
        });
        return requireMappedCandidate(transaction, input.candidatePublicId);
      });
    },

    async addCandidateShards(input) {
      validateStorageVnextShardBatch(input.shards);
      return sql.begin(async (transaction) => {
        const candidate = await requireWritableCandidate(transaction, input.candidatePublicId);
        if (input.shards.length === 0) {
          return {
            createdDescriptorCount: 0,
            reusedDescriptorCount: 0,
            attachedCount: 0
          };
        }
        await requireVerifiedObjects(
          transaction,
          uniqueStorageVnextValues(input.shards.map((shard) => shard.objectId))
        );
        const createdDescriptors = await transaction<Array<{ public_id: string }>>`
          INSERT INTO focowiki.release_shards (
            public_id, knowledge_base_id, logical_kind, first_logical_path,
            last_logical_path, record_count, byte_count, checksum_sha256, object_id
          )
          SELECT * FROM unnest(
            ${input.shards.map((item) => item.publicId)}::text[],
            ${input.shards.map(() => candidate.knowledge_base_id)}::text[],
            ${input.shards.map((item) => item.logicalKind)}::text[],
            ${input.shards.map((item) => item.firstLogicalPath)}::text[],
            ${input.shards.map((item) => item.lastLogicalPath)}::text[],
            ${input.shards.map((item) => item.recordCount)}::bigint[],
            ${input.shards.map((item) => item.byteCount)}::bigint[],
            ${input.shards.map((item) => item.checksum)}::text[],
            ${input.shards.map((item) => item.objectId)}::text[]
          )
          ON CONFLICT (knowledge_base_id, public_id) DO NOTHING
          RETURNING public_id
        `;
        await assertShardDescriptors(transaction, candidate.knowledge_base_id, input.shards);
        const replacedObjects = await transaction<Array<{ object_id: string }>>`
          WITH incoming AS (
            SELECT *
            FROM unnest(
              ${input.shards.map((item) => item.logicalKind)}::text[],
              ${input.shards.map((item) => item.firstLogicalPath)}::text[],
              ${input.shards.map((item) => item.ordinal)}::bigint[],
              ${input.shards.map((item) => item.publicId)}::text[]
            ) AS value(logical_kind, first_logical_path, ordinal, public_id)
          )
          DELETE FROM focowiki.release_root_shards attached
          USING focowiki.release_shards existing
          WHERE attached.release_root_public_id = ${candidate.candidate_root_public_id}
            AND existing.knowledge_base_id = ${candidate.knowledge_base_id}
            AND existing.public_id = attached.release_shard_public_id
            AND EXISTS (
              SELECT 1
              FROM incoming
              WHERE incoming.public_id <> existing.public_id
                AND incoming.logical_kind = existing.logical_kind
                AND incoming.ordinal = attached.ordinal
                AND (
                  incoming.logical_kind NOT IN (
                    ${STORAGE_VNEXT_DIRECTORY_NAVIGATION_SHARD_KIND},
                    ${STORAGE_VNEXT_EXTENSION_NAVIGATION_SHARD_KIND}
                  )
                  OR incoming.first_logical_path = existing.first_logical_path
                )
            )
          RETURNING existing.object_id
        `;
        const attachments = await transaction<Array<{ release_shard_public_id: string }>>`
          INSERT INTO focowiki.release_root_shards (
            knowledge_base_id, release_root_public_id,
            release_shard_public_id, ordinal
          )
          SELECT * FROM unnest(
            ${input.shards.map(() => candidate.knowledge_base_id)}::text[],
            ${input.shards.map(() => candidate.candidate_root_public_id)}::text[],
            ${input.shards.map((item) => item.publicId)}::text[],
            ${input.shards.map((item) => item.ordinal)}::bigint[]
          )
          ON CONFLICT (release_root_public_id, release_shard_public_id) DO NOTHING
          RETURNING release_shard_public_id
        `;
        await attachRootOwners(transaction, {
          knowledgeBaseId: candidate.knowledge_base_id,
          rootPublicId: candidate.candidate_root_public_id,
          kind: "candidate_root",
          objectIds: uniqueStorageVnextValues(input.shards.map((item) => item.objectId))
        });
        await releaseUnusedRootOwners(transaction, {
          knowledgeBaseId: candidate.knowledge_base_id,
          operationPublicId: candidate.operation_public_id,
          rootPublicId: candidate.candidate_root_public_id,
          objectIds: uniqueStorageVnextValues(replacedObjects.map((row) => row.object_id))
        });
        const counts = await transaction<Array<{ total: number | string }>>`
          SELECT count(*) AS total
          FROM focowiki.release_root_shards
          WHERE release_root_public_id = ${candidate.candidate_root_public_id}
        `;
        if (Number(counts[0]?.total ?? 0) > MAX_STORAGE_VNEXT_CANDIDATE_SHARDS) {
          throw new StorageVnextReleaseRepositoryError("candidate_limit_exceeded");
        }
        return {
          createdDescriptorCount: createdDescriptors.length,
          reusedDescriptorCount: input.shards.length - createdDescriptors.length,
          attachedCount: attachments.length
        };
      });
    },

    async addCandidateCatalogEntries(input) {
      validateStorageVnextCatalogBatch(input.entries);
      await sql.begin(async (transaction) => {
        const candidate = await requireWritableCandidate(transaction, input.candidatePublicId);
        if (input.entries.length === 0) return;
        await requireVerifiedObjects(
          transaction,
          uniqueStorageVnextValues(input.entries.map((entry) => entry.objectId))
        );
        const oldObjects = await transaction<Array<{ object_id: string }>>`
          SELECT object_id
          FROM focowiki.release_catalog_entries
          WHERE release_root_public_id = ${candidate.candidate_root_public_id}
            AND logical_path = ANY(${input.entries.map((entry) => entry.logicalPath)})
        `;
        await transaction`
          DELETE FROM focowiki.release_catalog_tombstones
          WHERE release_root_public_id = ${candidate.candidate_root_public_id}
            AND logical_path = ANY(${input.entries.map((entry) => entry.logicalPath)})
        `;
        await transaction`
          INSERT INTO focowiki.release_catalog_entries (
            knowledge_base_id, release_root_public_id, logical_path, entry_kind,
            source_file_public_id, checksum_sha256, object_id, byte_count, ordinal
          )
          SELECT * FROM unnest(
            ${input.entries.map(() => candidate.knowledge_base_id)}::text[],
            ${input.entries.map(() => candidate.candidate_root_public_id)}::text[],
            ${input.entries.map((entry) => entry.logicalPath)}::text[],
            ${input.entries.map((entry) => entry.kind)}::text[],
            ${input.entries.map((entry) => entry.sourceFilePublicId)}::text[],
            ${input.entries.map((entry) => entry.checksum)}::text[],
            ${input.entries.map((entry) => entry.objectId)}::text[],
            ${input.entries.map((entry) => entry.byteCount)}::bigint[],
            ${input.entries.map((entry) => entry.ordinal)}::bigint[]
          )
          ON CONFLICT (release_root_public_id, logical_path) DO UPDATE
          SET entry_kind = EXCLUDED.entry_kind,
              source_file_public_id = EXCLUDED.source_file_public_id,
              checksum_sha256 = EXCLUDED.checksum_sha256,
              object_id = EXCLUDED.object_id,
              byte_count = EXCLUDED.byte_count,
              ordinal = EXCLUDED.ordinal
        `;
        await attachRootOwners(transaction, {
          knowledgeBaseId: candidate.knowledge_base_id,
          rootPublicId: candidate.candidate_root_public_id,
          kind: "candidate_root",
          objectIds: uniqueStorageVnextValues(input.entries.map((entry) => entry.objectId))
        });
        await releaseUnusedRootOwners(transaction, {
          knowledgeBaseId: candidate.knowledge_base_id,
          operationPublicId: candidate.operation_public_id,
          rootPublicId: candidate.candidate_root_public_id,
          objectIds: uniqueStorageVnextValues(oldObjects.map((row) => row.object_id))
        });
      });
    },

    async addCandidateCatalogTombstones(input) {
      validateStorageVnextCatalogTombstones(input.logicalPaths);
      await sql.begin(async (transaction) => {
        const candidate = await requireWritableCandidate(transaction, input.candidatePublicId);
        if (input.logicalPaths.length === 0) return;
        const oldObjects = await transaction<Array<{ object_id: string }>>`
          DELETE FROM focowiki.release_catalog_entries
          WHERE release_root_public_id = ${candidate.candidate_root_public_id}
            AND logical_path = ANY(${input.logicalPaths})
          RETURNING object_id
        `;
        await transaction`
          INSERT INTO focowiki.release_catalog_tombstones (
            knowledge_base_id, release_root_public_id, logical_path
          )
          SELECT * FROM unnest(
            ${input.logicalPaths.map(() => candidate.knowledge_base_id)}::text[],
            ${input.logicalPaths.map(() => candidate.candidate_root_public_id)}::text[],
            ${input.logicalPaths}::text[]
          )
          ON CONFLICT (release_root_public_id, logical_path) DO NOTHING
        `;
        await releaseUnusedRootOwners(transaction, {
          knowledgeBaseId: candidate.knowledge_base_id,
          operationPublicId: candidate.operation_public_id,
          rootPublicId: candidate.candidate_root_public_id,
          objectIds: uniqueStorageVnextValues(oldObjects.map((row) => row.object_id))
        });
      });
    },

    async replaceCandidateSummaries(input) {
      validateStorageVnextSummaries(input.directories, input.knowledgeBase);
      await sql.begin(async (transaction) => {
        const candidate = await requireWritableCandidate(transaction, input.candidatePublicId);
        await transaction`
          DELETE FROM focowiki.directory_summaries
          WHERE release_root_public_id = ${candidate.candidate_root_public_id}
        `;
        for (
          let offset = 0;
          offset < input.directories.length;
          offset += MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
        ) {
          const directories = input.directories.slice(
            offset,
            offset + MAX_STORAGE_VNEXT_RELEASE_WRITE_BATCH
          );
          await transaction`
            INSERT INTO focowiki.directory_summaries (
              knowledge_base_id, release_root_public_id, directory_public_id,
              logical_path, first_leaf_path, direct_file_count,
              descendant_file_count, ordinal
            )
            SELECT * FROM unnest(
              ${directories.map(() => candidate.knowledge_base_id)}::text[],
              ${directories.map(() => candidate.candidate_root_public_id)}::text[],
              ${directories.map((item) => item.directoryPublicId)}::text[],
              ${directories.map((item) => item.logicalPath)}::text[],
              ${directories.map((item) => item.firstLeafPath)}::text[],
              ${directories.map((item) => item.directFileCount)}::bigint[],
              ${directories.map((item) => item.descendantFileCount)}::bigint[],
              ${directories.map((item) => item.ordinal)}::bigint[]
            )
          `;
        }
        await transaction`
          INSERT INTO focowiki.knowledge_base_summaries (
            release_root_public_id, knowledge_base_id, source_file_count,
            directory_count, generated_entry_count, graph_node_count,
            graph_edge_count, generated_byte_count
          ) VALUES (
            ${candidate.candidate_root_public_id}, ${candidate.knowledge_base_id},
            ${input.knowledgeBase.sourceFileCount}, ${input.knowledgeBase.directoryCount},
            ${input.knowledgeBase.generatedEntryCount}, ${input.knowledgeBase.graphNodeCount},
            ${input.knowledgeBase.graphEdgeCount}, ${input.knowledgeBase.generatedByteCount}
          )
          ON CONFLICT (release_root_public_id) DO UPDATE
          SET source_file_count = EXCLUDED.source_file_count,
              directory_count = EXCLUDED.directory_count,
              generated_entry_count = EXCLUDED.generated_entry_count,
              graph_node_count = EXCLUDED.graph_node_count,
              graph_edge_count = EXCLUDED.graph_edge_count,
              generated_byte_count = EXCLUDED.generated_byte_count
        `;
      });
    },

    async markCandidateValidating(input) {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.release_candidates
        SET state = 'validating', updated_at = now()
        WHERE public_id = ${input.candidatePublicId}
          AND state = 'building'
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async recordCandidateValidation(input) {
      validateStorageVnextCandidateValidationReceipt(input);
      if (!storageVnextCandidateValidationPassed(input)) return false;
      return sql.begin(async (transaction) => {
        const candidate = await requireCandidate(
          transaction,
          input.candidatePublicId,
          true
        );
        if (candidate.state !== "validating") return false;
        await requireCandidateObjectsReady(
          transaction,
          candidate.candidate_root_public_id
        );
        const actuals = await readCandidateValidationActuals(transaction, {
          knowledgeBaseId: candidate.knowledge_base_id,
          candidatePublicId: candidate.public_id,
          candidateRootPublicId: candidate.candidate_root_public_id,
          searchProjectionPublicId: input.searchProjectionPublicId
        });
        if (
          !actuals
          || actuals.searchRole !== "candidate"
          || actuals.searchState !== "ready"
          || actuals.objectOwnerCount !== input.objectOwnerCount
          || actuals.searchDocumentCount !== input.searchDocumentCount
          || actuals.graphNodeCount !== input.graphNodeCount
          || actuals.graphEdgeCount !== input.graphEdgeCount
          || actuals.linkCount !== input.linkCount
          || actuals.generatedEntryCount !== input.generatedEntryCount
        ) {
          return false;
        }
        const objectFanout = evaluateStorageVnextObjectFanoutBudget(
          await measureStorageVnextObjectFanout(transaction, {
            knowledgeBaseId: candidate.knowledge_base_id,
            candidateRootPublicId: candidate.candidate_root_public_id
          })
        );
        if (!objectFanout.passed) return false;
        const roots = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.release_roots
          SET manifest_checksum_sha256 = ${input.manifestChecksum},
              navigation_profile_version = ${input.navigationProfileVersion}
          WHERE knowledge_base_id = ${candidate.knowledge_base_id}
            AND public_id = ${candidate.candidate_root_public_id}
            AND root_role = 'candidate'
          RETURNING public_id
        `;
        if (roots.length !== 1) {
          throw new StorageVnextReleaseRepositoryError("scope_conflict");
        }
        const rows = await transaction<Array<{ candidate_public_id: string }>>`
          INSERT INTO focowiki.release_candidate_validations (
            candidate_public_id, knowledge_base_id,
            manifest_checksum_sha256, search_projection_public_id,
            object_owner_count, search_document_count,
            graph_node_count, graph_edge_count, link_count,
            generated_entry_count, navigation_profile_version,
            object_validation_passed,
            search_validation_passed, graph_validation_passed,
            link_validation_passed, count_validation_passed,
            path_validation_passed, validated_at
          ) VALUES (
            ${candidate.public_id}, ${candidate.knowledge_base_id},
            ${input.manifestChecksum}, ${input.searchProjectionPublicId},
            ${input.objectOwnerCount}, ${input.searchDocumentCount},
            ${input.graphNodeCount}, ${input.graphEdgeCount}, ${input.linkCount},
            ${input.generatedEntryCount}, ${input.navigationProfileVersion},
            ${input.objectValidationPassed},
            ${input.searchValidationPassed}, ${input.graphValidationPassed},
            ${input.linkValidationPassed}, ${input.countValidationPassed},
            ${input.pathValidationPassed}, ${input.validatedAt}
          )
          ON CONFLICT (candidate_public_id) DO UPDATE
          SET manifest_checksum_sha256 = EXCLUDED.manifest_checksum_sha256,
              search_projection_public_id = EXCLUDED.search_projection_public_id,
              object_owner_count = EXCLUDED.object_owner_count,
              search_document_count = EXCLUDED.search_document_count,
              graph_node_count = EXCLUDED.graph_node_count,
              graph_edge_count = EXCLUDED.graph_edge_count,
              link_count = EXCLUDED.link_count,
              generated_entry_count = EXCLUDED.generated_entry_count,
              navigation_profile_version = EXCLUDED.navigation_profile_version,
              object_validation_passed = EXCLUDED.object_validation_passed,
              search_validation_passed = EXCLUDED.search_validation_passed,
              graph_validation_passed = EXCLUDED.graph_validation_passed,
              link_validation_passed = EXCLUDED.link_validation_passed,
              count_validation_passed = EXCLUDED.count_validation_passed,
              path_validation_passed = EXCLUDED.path_validation_passed,
              validated_at = EXCLUDED.validated_at
          RETURNING candidate_public_id
        `;
        return rows.length === 1;
      });
    },

    async markCandidateReady(input) {
      assertStorageVnextReleaseChecksum(input.manifestChecksum);
      return sql.begin(async (transaction) => {
        const candidate = await requireCandidate(transaction, input.candidatePublicId, true);
        if (candidate.state === "ready") {
          return candidate.manifest_checksum_sha256 === input.manifestChecksum;
        }
        if (candidate.state !== "validating") return false;
        const validations = await transaction<Array<{ candidate_public_id: string }>>`
          SELECT candidate_public_id
          FROM focowiki.release_candidate_validations
          WHERE candidate_public_id = ${candidate.public_id}
            AND knowledge_base_id = ${candidate.knowledge_base_id}
            AND manifest_checksum_sha256 = ${input.manifestChecksum}
            AND navigation_profile_version = ${STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE}
          FOR UPDATE
        `;
        if (validations.length !== 1) return false;
        const actual = await candidateCounts(transaction, input.candidatePublicId);
        if (
          actual.changedFacts !== Number(candidate.changed_fact_count)
          || actual.dependencies !== Number(candidate.affected_dependency_count)
        ) {
          throw new StorageVnextReleaseRepositoryError("scope_conflict");
        }
        await transaction`
          UPDATE focowiki.release_roots
          SET manifest_checksum_sha256 = ${input.manifestChecksum}
          WHERE knowledge_base_id = ${candidate.knowledge_base_id}
            AND public_id = ${candidate.candidate_root_public_id}
            AND root_role = 'candidate'
            AND navigation_profile_version = ${STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE}
        `;
        const rows = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.release_candidates
          SET state = 'ready', manifest_checksum_sha256 = ${input.manifestChecksum},
              updated_at = now()
          WHERE public_id = ${input.candidatePublicId}
            AND state = 'validating'
          RETURNING public_id
        `;
        return rows.length === 1;
      });
    },

    async activateCandidate(input) {
      validateStorageVnextActivation(input);
      return sql.begin(async (transaction) => {
        await lockRelease(transaction, input.knowledgeBaseId);
        const active = await readActiveSnapshot(transaction, input.knowledgeBaseId, true);
        const candidate = await readCandidateByPublicId(
          transaction,
          input.candidatePublicId,
          true
        );
        if (!candidate) {
          const event = await readCandidateEvent(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            candidatePublicId: input.candidatePublicId,
            outcome: "activated"
          });
          if (event && active && event.release_root_public_id === active.releaseRootPublicId) {
            return {
              outcome: "activated" as const,
              snapshot: active,
              rollbackRootPublicId: null
            };
          }
          return storageVnextStaleResult(active);
        }
        if (candidate.knowledge_base_id !== input.knowledgeBaseId) {
          throw new StorageVnextReleaseRepositoryError("scope_conflict");
        }
        if (
          (active?.releaseRootPublicId ?? null) !== input.expectedActiveRootPublicId
          || (active?.revision ?? 0) !== input.expectedActiveRevision
          || candidate.expected_active_root_public_id !== input.expectedActiveRootPublicId
          || Number(candidate.expected_active_revision) !== input.expectedActiveRevision
        ) {
          return storageVnextStaleResult(active);
        }
        if (candidate.state !== "ready" || !candidate.manifest_checksum_sha256) {
          return { outcome: "not_ready" as const };
        }
        const validations = await transaction<Array<{
          search_projection_public_id: string;
          search_document_count: number | string;
          object_owner_count: number | string;
        }>>`
          SELECT validation.search_projection_public_id,
                 validation.search_document_count,
                 validation.object_owner_count
          FROM focowiki.release_candidate_validations validation
          JOIN focowiki.release_roots root
            ON root.knowledge_base_id = validation.knowledge_base_id
           AND root.public_id = ${candidate.candidate_root_public_id}
          WHERE validation.candidate_public_id = ${candidate.public_id}
            AND validation.knowledge_base_id = ${input.knowledgeBaseId}
            AND validation.manifest_checksum_sha256 = ${candidate.manifest_checksum_sha256}
            AND validation.search_projection_public_id = ${input.searchProjectionPublicId}
            AND validation.navigation_profile_version = ${STORAGE_VNEXT_CURRENT_NAVIGATION_PROFILE}
            AND root.root_role = 'candidate'
            AND root.manifest_checksum_sha256 = validation.manifest_checksum_sha256
            AND root.navigation_profile_version = validation.navigation_profile_version
          FOR UPDATE OF validation, root
        `;
        const validation = validations[0];
        if (!validation) return { outcome: "not_ready" as const };
        const search = await transaction<Array<{
          public_id: string;
          projection_role: string;
          state: string;
          document_count: number | string;
        }>>`
          SELECT public_id, projection_role, state, document_count
          FROM focowiki.search_projections
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.searchProjectionPublicId}
          FOR UPDATE
        `;
        if (
          search[0]?.projection_role !== "candidate"
          || search[0]?.state !== "ready"
          || Number(search[0]?.document_count) !== Number(validation.search_document_count)
        ) {
          return { outcome: "not_ready" as const };
        }
        await requireCandidateObjectsReady(transaction, candidate.candidate_root_public_id);
        const ownerCounts = await transaction<Array<{ owner_count: number | string }>>`
          SELECT count(DISTINCT object_id) AS owner_count
          FROM focowiki.object_owners
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_root_public_id = ${candidate.candidate_root_public_id}
            AND owner_kind = 'candidate_root'
        `;
        if (Number(ownerCounts[0]?.owner_count ?? 0) !== Number(validation.object_owner_count)) {
          return { outcome: "not_ready" as const };
        }
        const previousRollback = await readRootByRole(
          transaction,
          input.knowledgeBaseId,
          "rollback",
          true
        );
        if (active && !input.rollbackExpiresAt) {
          throw new StorageVnextReleaseRepositoryError("invalid_input");
        }
        if (previousRollback) {
          if (!previousRollback.expiresAt) {
            throw new StorageVnextReleaseRepositoryError("scope_conflict");
          }
          const retired = await retireRollbackRoot(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            rootPublicId: previousRollback.publicId,
            expectedActiveRootPublicId: active?.releaseRootPublicId ?? null,
            cleanupOperationPublicId: candidate.operation_public_id
          });
          if (!retired) {
            return {
              outcome: "rollback_pending" as const,
              rollbackRootPublicId: previousRollback.publicId,
              expiresAt: previousRollback.expiresAt
            };
          }
        }
        const maintenanceActivation = await isMaintenanceOperation(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          operationPublicId: candidate.operation_public_id
        });
        if (
          active
          && maintenanceActivation
          && await releaseLineageDepth(
            transaction,
            input.knowledgeBaseId,
            active.releaseRootPublicId
          ) > 1
        ) {
          await compactActiveReleaseLineage(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            activeRootPublicId: active.releaseRootPublicId,
            minimumDepth: 2,
            cleanupOperationPublicId: candidate.operation_public_id
          });
        }
        await options.lifecycleHooks?.beforeActivate?.({
          transaction,
          knowledgeBaseId: input.knowledgeBaseId,
          candidatePublicId: candidate.public_id,
          operationPublicId: candidate.operation_public_id,
          rollbackExpiresAt: input.rollbackExpiresAt,
          eventExpiresAt: input.eventExpiresAt,
          activatedAt: input.activatedAt
        });
        await transaction`SET CONSTRAINTS focowiki.release_roots_role_key DEFERRED`;
        if (active) {
          await transaction`
            UPDATE focowiki.release_roots
            SET root_role = 'rollback', expires_at = ${input.rollbackExpiresAt}
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ${active.releaseRootPublicId}
              AND root_role = 'active'
          `;
          await transaction`
            UPDATE focowiki.object_owners
            SET owner_kind = 'rollback_root'
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND release_root_public_id = ${active.releaseRootPublicId}
              AND owner_kind = 'active_root'
          `;
        }
        await transaction`
          UPDATE focowiki.release_roots
          SET root_role = 'active', expires_at = NULL,
              base_root_public_id = CASE
                WHEN ${maintenanceActivation} THEN NULL
                ELSE base_root_public_id
              END
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${candidate.candidate_root_public_id}
            AND root_role = 'candidate'
        `;
        await transaction`
          UPDATE focowiki.object_owners
          SET owner_kind = 'active_root'
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_root_public_id = ${candidate.candidate_root_public_id}
            AND owner_kind = 'candidate_root'
        `;
        const revision = input.expectedActiveRevision + 1;
        const snapshotWrites = await transaction<Array<{ knowledge_base_id: string }>>`
          INSERT INTO focowiki.active_snapshots (
            knowledge_base_id, release_root_public_id,
            search_projection_public_id, manifest_checksum_sha256,
            revision, activated_by_operation_public_id, publicly_visible_at
          ) VALUES (
            ${input.knowledgeBaseId}, ${candidate.candidate_root_public_id},
            ${input.searchProjectionPublicId}, ${candidate.manifest_checksum_sha256},
            ${revision}, ${candidate.operation_public_id}, ${input.activatedAt}
          )
          ON CONFLICT (knowledge_base_id) DO UPDATE
          SET release_root_public_id = EXCLUDED.release_root_public_id,
              search_projection_public_id = EXCLUDED.search_projection_public_id,
              manifest_checksum_sha256 = EXCLUDED.manifest_checksum_sha256,
              revision = EXCLUDED.revision,
              activated_by_operation_public_id = EXCLUDED.activated_by_operation_public_id,
              publicly_visible_at = EXCLUDED.publicly_visible_at
          WHERE focowiki.active_snapshots.release_root_public_id
                  IS NOT DISTINCT FROM ${input.expectedActiveRootPublicId}
            AND focowiki.active_snapshots.revision = ${input.expectedActiveRevision}
          RETURNING knowledge_base_id
        `;
        if (snapshotWrites.length !== 1) {
          throw new StorageVnextReleaseRepositoryError("stale_active_root");
        }
        if (
          active?.searchProjectionPublicId
          && active.searchProjectionPublicId !== input.searchProjectionPublicId
        ) {
          await transaction`
            DELETE FROM focowiki.search_projections
            WHERE knowledge_base_id = ${input.knowledgeBaseId}
              AND public_id = ${active.searchProjectionPublicId}
              AND projection_role = 'active'
          `;
        }
        await transaction`
          UPDATE focowiki.search_projections
          SET projection_role = 'active', updated_at = ${input.activatedAt}
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ${input.searchProjectionPublicId}
            AND projection_role = 'candidate'
            AND state = 'ready'
        `;
        await writeReleaseEvent(transaction, {
          publicId: input.eventPublicId,
          knowledgeBaseId: input.knowledgeBaseId,
          operationPublicId: candidate.operation_public_id,
          candidatePublicId: candidate.public_id,
          releaseRootPublicId: candidate.candidate_root_public_id,
          outcome: "activated",
          resultCode: "release_activated",
          safeMessage: null,
          revision,
          createdAt: input.activatedAt,
          expiresAt: input.eventExpiresAt
        });
        await transaction`
          DELETE FROM focowiki.release_candidates
          WHERE public_id = ${candidate.public_id}
        `;
        const snapshot = await readActiveSnapshot(transaction, input.knowledgeBaseId, false);
        if (!snapshot) throw new StorageVnextReleaseRepositoryError("scope_conflict");
        return {
          outcome: "activated" as const,
          snapshot,
          rollbackRootPublicId: active?.releaseRootPublicId ?? null
        };
      });
    },

    async terminateCandidate(input) {
      validateStorageVnextTerminalInput(input);
      return sql.begin(async (transaction) => {
        await lockRelease(transaction, input.knowledgeBaseId);
        const candidate = await readCandidateByPublicId(
          transaction,
          input.candidatePublicId,
          true
        );
        if (!candidate) {
          const event = await readCandidateEvent(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            candidatePublicId: input.candidatePublicId,
            outcome: input.outcome
          });
          return event?.public_id === input.eventPublicId
            && event.result_code === input.reasonCode
            && event.safe_message === input.safeMessage;
        }
        if (candidate.knowledge_base_id !== input.knowledgeBaseId) {
          throw new StorageVnextReleaseRepositoryError("scope_conflict");
        }
        await options.lifecycleHooks?.beforeTerminate?.({
          transaction,
          knowledgeBaseId: input.knowledgeBaseId,
          candidatePublicId: candidate.public_id,
          operationPublicId: candidate.operation_public_id,
          outcome: input.outcome,
          reasonCode: input.reasonCode,
          eventExpiresAt: input.eventExpiresAt,
          terminatedAt: input.terminatedAt
        });
        const searches = await transaction<Array<{
          search_projection_public_id: string;
        }>>`
          SELECT search_projection_public_id
          FROM focowiki.release_candidate_validations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND candidate_public_id = ${candidate.public_id}
          FOR UPDATE
        `;
        await transaction`
          UPDATE focowiki.release_candidates
          SET state = ${input.outcome}, reason_code = ${input.reasonCode},
              updated_at = ${input.terminatedAt}
          WHERE public_id = ${input.candidatePublicId}
        `;
        await writeReleaseEvent(transaction, {
          publicId: input.eventPublicId,
          knowledgeBaseId: input.knowledgeBaseId,
          operationPublicId: candidate.operation_public_id,
          candidatePublicId: candidate.public_id,
          releaseRootPublicId: candidate.candidate_root_public_id,
          outcome: input.outcome,
          resultCode: input.reasonCode,
          safeMessage: input.safeMessage,
          revision: Number(candidate.expected_active_revision),
          createdAt: input.terminatedAt,
          expiresAt: input.eventExpiresAt
        });
        await transaction`
          DELETE FROM focowiki.release_candidates
          WHERE public_id = ${candidate.public_id}
        `;
        const searchProjectionPublicIds = uniqueStorageVnextValues([
          candidate.public_id,
          ...searches.map((search) => search.search_projection_public_id)
        ]);
        await transaction`
          DELETE FROM focowiki.search_projections
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND public_id = ANY(${searchProjectionPublicIds})
            AND projection_role = 'candidate'
        `;
        await deleteRootAndReleaseObjects(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          rootPublicId: candidate.candidate_root_public_id
        });
        return true;
      });
    },

    async expireRollbackRoot(input) {
      assertStorageVnextTimestampOrder(input.expiredBefore, input.eventExpiresAt);
      return sql.begin(async (transaction) => {
        await lockRelease(transaction, input.knowledgeBaseId);
        const rows = await transaction<StorageVnextReleaseRootRow[]>`
          SELECT public_id, knowledge_base_id, root_role,
                 manifest_checksum_sha256, navigation_profile_version,
                 revision, created_at, expires_at
          FROM focowiki.release_roots
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND root_role = 'rollback'
            AND expires_at <= ${input.expiredBefore}
          FOR UPDATE
        `;
        const root = rows[0];
        if (!root) return null;
        const activation = await transaction<StorageVnextReleaseEventRow[]>`
          SELECT public_id, knowledge_base_id, operation_public_id,
                 candidate_public_id, release_root_public_id, outcome,
                 result_code, safe_message, revision, created_at, expires_at
          FROM focowiki.release_event_summaries
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND release_root_public_id = ${root.public_id}
            AND outcome = 'activated'
          ORDER BY created_at DESC
          LIMIT 1
        `;
        const candidatePublicId = activation[0]?.candidate_public_id ?? root.public_id;
        const operationPublicId = activation[0]?.operation_public_id ?? root.public_id;
        const retired = await retireRollbackRoot(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          rootPublicId: root.public_id,
          expectedActiveRootPublicId: null,
          cleanupOperationPublicId: operationPublicId
        });
        if (!retired) {
          throw new StorageVnextReleaseRepositoryError("scope_conflict");
        }
        await writeReleaseEvent(transaction, {
          publicId: input.eventPublicId,
          knowledgeBaseId: input.knowledgeBaseId,
          operationPublicId,
          candidatePublicId,
          releaseRootPublicId: root.public_id,
          outcome: "rollback_expired",
          resultCode: "rollback_expired",
          safeMessage: null,
          revision: Number(root.revision),
          createdAt: input.expiredBefore,
          expiresAt: input.eventExpiresAt
        });
        return root.public_id;
      });
    },

    async deleteExpiredReleaseEvents(input) {
      if (!isStorageVnextReleaseTimestamp(input.expiredBefore)) {
        throw new StorageVnextReleaseRepositoryError("invalid_input");
      }
      const limit = assertStorageVnextReleasePageLimit(input.limit);
      const rows = await sql<Array<{ public_id: string }>>`
        WITH expired AS (
          SELECT public_id
          FROM focowiki.release_event_summaries
          WHERE expires_at <= ${input.expiredBefore}
          ORDER BY expires_at, public_id
          LIMIT ${limit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM focowiki.release_event_summaries summary
        USING expired
        WHERE summary.public_id = expired.public_id
        RETURNING summary.public_id
      `;
      return rows.length;
    }
  };
}

async function readRootByRole(
  sql: ReadSql,
  knowledgeBaseId: string,
  role: "active" | "candidate" | "rollback",
  lock = false
): Promise<StorageVnextReleaseRoot | null> {
  const rows = await sql<StorageVnextReleaseRootRow[]>`
    SELECT public_id, knowledge_base_id, root_role,
           manifest_checksum_sha256, navigation_profile_version,
           revision, created_at, expires_at
    FROM focowiki.release_roots
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND root_role = ${role}
      AND EXISTS (
        SELECT 1 FROM focowiki.knowledge_bases knowledge_base
        WHERE knowledge_base.public_id = ${knowledgeBaseId}
          AND knowledge_base.deleted_at IS NULL
      )
    LIMIT 1
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return rows[0] ? mapStorageVnextReleaseRoot(rows[0]) : null;
}

async function readCandidateByKnowledgeBase(
  sql: ReadSql,
  knowledgeBaseId: string,
  lock: boolean
): Promise<StorageVnextReleaseCandidateRow | null> {
  const rows = await sql<StorageVnextReleaseCandidateRow[]>`
    SELECT public_id, knowledge_base_id, operation_public_id,
           candidate_root_public_id, expected_active_root_public_id,
           expected_active_revision, state, changed_fact_count,
           affected_dependency_count, manifest_checksum_sha256,
           created_at, updated_at
    FROM focowiki.release_candidates
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND state IN ('building', 'validating', 'ready')
    LIMIT 1
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return rows[0] ?? null;
}

async function readCandidateByPublicId(
  sql: ReadSql,
  publicId: string,
  lock: boolean
): Promise<StorageVnextReleaseCandidateRow | null> {
  const rows = await sql<StorageVnextReleaseCandidateRow[]>`
    SELECT public_id, knowledge_base_id, operation_public_id,
           candidate_root_public_id, expected_active_root_public_id,
           expected_active_revision, state, changed_fact_count,
           affected_dependency_count, manifest_checksum_sha256,
           created_at, updated_at
    FROM focowiki.release_candidates
    WHERE public_id = ${publicId}
      AND state IN ('building', 'validating', 'ready')
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  return rows[0] ?? null;
}

async function requireCandidate(
  sql: ReadSql,
  publicId: string,
  lock: boolean
): Promise<StorageVnextReleaseCandidateRow> {
  const candidate = await readCandidateByPublicId(sql, publicId, lock);
  if (!candidate) throw new StorageVnextReleaseRepositoryError("scope_conflict");
  return candidate;
}

async function requireWritableCandidate(
  sql: ReadSql,
  publicId: string
): Promise<StorageVnextReleaseCandidateRow> {
  const candidate = await requireCandidate(sql, publicId, true);
  if (candidate.state !== "building") {
    throw new StorageVnextReleaseRepositoryError("candidate_not_writable");
  }
  return candidate;
}

async function requireMappedCandidate(
  sql: ReadSql,
  publicId: string
): Promise<StorageVnextCandidateDelta> {
  return mapStorageVnextCandidate(await requireCandidate(sql, publicId, false));
}

async function readActiveSnapshot(
  sql: ReadSql,
  knowledgeBaseId: string,
  lock: boolean
): Promise<StorageVnextActiveSnapshot | null> {
  const rows = await sql<Array<{
    knowledge_base_id: string;
    release_root_public_id: string;
    search_projection_public_id: string;
    manifest_checksum_sha256: string;
    navigation_profile_version: number | string;
    revision: number | string;
    activated_by_operation_public_id: string;
    publicly_visible_at: Date | string;
  }>>`
    SELECT snapshot.knowledge_base_id, snapshot.release_root_public_id,
           snapshot.search_projection_public_id,
           snapshot.manifest_checksum_sha256,
           root.navigation_profile_version,
           snapshot.revision, snapshot.activated_by_operation_public_id,
           snapshot.publicly_visible_at
    FROM focowiki.active_snapshots snapshot
    JOIN focowiki.release_roots root
      ON root.knowledge_base_id = snapshot.knowledge_base_id
     AND root.public_id = snapshot.release_root_public_id
    WHERE snapshot.knowledge_base_id = ${knowledgeBaseId}
    ${lock ? sql`FOR UPDATE` : sql``}
  `;
  const row = rows[0];
  return row ? {
    knowledgeBaseId: row.knowledge_base_id,
    releaseRootPublicId: row.release_root_public_id,
    searchProjectionPublicId: row.search_projection_public_id,
    manifestChecksum: row.manifest_checksum_sha256,
    navigationProfileVersion: Number(row.navigation_profile_version),
    revision: Number(row.revision),
    activatedByOperationPublicId: row.activated_by_operation_public_id,
    publiclyVisibleAt: storageVnextReleaseTimestamp(row.publicly_visible_at)
  } : null;
}

async function requireIdempotentOperation(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    idempotency: { key: string; requestHash: string };
  }
): Promise<void> {
  const rows = await sql<Array<{ public_id: string }>>`
    SELECT operation.public_id
    FROM focowiki.operations operation
    JOIN focowiki.operation_idempotency replay
      ON replay.knowledge_base_id = operation.knowledge_base_id
     AND replay.operation_public_id = operation.public_id
    WHERE operation.knowledge_base_id = ${input.knowledgeBaseId}
      AND operation.public_id = ${input.operationPublicId}
      AND operation.state IN ('accepted', 'validating', 'processing', 'publishing')
      AND replay.idempotency_key = ${input.idempotency.key}
      AND replay.request_hash = ${input.idempotency.requestHash}
    FOR UPDATE OF operation
  `;
  if (!rows[0]) throw new StorageVnextReleaseRepositoryError("scope_conflict");
}

async function persistCandidateFacts(
  sql: ReadSql,
  input: {
    candidatePublicId: string;
    knowledgeBaseId: string;
    changedFacts: readonly StorageVnextCandidateChangedFact[];
    dependencies: readonly StorageVnextCandidateDependency[];
  }
): Promise<void> {
  if (input.changedFacts.length > 0) {
    await sql`
      INSERT INTO focowiki.release_candidate_changed_facts (
        knowledge_base_id, candidate_public_id, fact_kind,
        fact_public_id, change_kind
      )
      SELECT * FROM unnest(
        ${input.changedFacts.map(() => input.knowledgeBaseId)}::text[],
        ${input.changedFacts.map(() => input.candidatePublicId)}::text[],
        ${input.changedFacts.map((fact) => fact.kind)}::text[],
        ${input.changedFacts.map((fact) => fact.publicId)}::text[],
        ${input.changedFacts.map((fact) => fact.change)}::text[]
      )
      ON CONFLICT (candidate_public_id, fact_kind, fact_public_id) DO UPDATE
      SET change_kind = EXCLUDED.change_kind
    `;
  }
  if (input.dependencies.length > 0) {
    await sql`
      INSERT INTO focowiki.release_candidate_dependencies (
        knowledge_base_id, candidate_public_id, dependency_kind,
        dependency_public_id, reason_code
      )
      SELECT * FROM unnest(
        ${input.dependencies.map(() => input.knowledgeBaseId)}::text[],
        ${input.dependencies.map(() => input.candidatePublicId)}::text[],
        ${input.dependencies.map((dependency) => dependency.kind)}::text[],
        ${input.dependencies.map((dependency) => dependency.publicId)}::text[],
        ${input.dependencies.map((dependency) => dependency.reasonCode)}::text[]
      )
      ON CONFLICT (candidate_public_id, dependency_kind, dependency_public_id) DO UPDATE
      SET reason_code = EXCLUDED.reason_code
    `;
  }
  const counts = await candidateCounts(sql, input.candidatePublicId);
  if (
    counts.changedFacts > MAX_STORAGE_VNEXT_CANDIDATE_CHANGED_FACTS
    || counts.dependencies > MAX_STORAGE_VNEXT_CANDIDATE_DEPENDENCIES
  ) {
    throw new StorageVnextReleaseRepositoryError("candidate_limit_exceeded");
  }
  await sql`
    UPDATE focowiki.release_candidates
    SET changed_fact_count = ${counts.changedFacts},
        affected_dependency_count = ${counts.dependencies},
        updated_at = now()
    WHERE public_id = ${input.candidatePublicId}
  `;
}

async function candidateCounts(sql: ReadSql, candidatePublicId: string) {
  const rows = await sql<Array<{
    changed_facts: number | string;
    dependencies: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.release_candidate_changed_facts
        WHERE candidate_public_id = ${candidatePublicId}) AS changed_facts,
      (SELECT count(*) FROM focowiki.release_candidate_dependencies
        WHERE candidate_public_id = ${candidatePublicId}) AS dependencies
  `;
  return {
    changedFacts: Number(rows[0]?.changed_facts ?? 0),
    dependencies: Number(rows[0]?.dependencies ?? 0)
  };
}

async function requireVerifiedObjects(sql: ReadSql, objectIds: string[]): Promise<void> {
  if (objectIds.length === 0) return;
  const rows = await sql<Array<{ object_id: string }>>`
    SELECT object_id
    FROM focowiki.object_registrations
    WHERE object_id = ANY(${objectIds})
      AND state = 'verified'
  `;
  if (rows.length !== objectIds.length) {
    throw new StorageVnextReleaseRepositoryError("object_not_verified");
  }
}

async function assertShardDescriptors(
  sql: ReadSql,
  knowledgeBaseId: string,
  shards: readonly StorageVnextShardDescriptor[]
): Promise<void> {
  const rows = await sql<StorageVnextReleaseShardRow[]>`
    SELECT public_id, logical_kind, first_logical_path, last_logical_path,
           record_count, byte_count, checksum_sha256, object_id, 0 AS ordinal
    FROM focowiki.release_shards
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND public_id = ANY(${shards.map((shard) => shard.publicId)})
  `;
  const byId = new Map(rows.map((row) => [row.public_id, row]));
  for (const shard of shards) {
    const row = byId.get(shard.publicId);
    if (
      !row
      || row.logical_kind !== shard.logicalKind
      || row.first_logical_path !== shard.firstLogicalPath
      || row.last_logical_path !== shard.lastLogicalPath
      || Number(row.record_count) !== shard.recordCount
      || Number(row.byte_count) !== shard.byteCount
      || row.checksum_sha256 !== shard.checksum
      || row.object_id !== shard.objectId
    ) {
      throw new StorageVnextReleaseRepositoryError("descriptor_conflict");
    }
  }
}

async function attachRootOwners(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    rootPublicId: string;
    kind: "active_root" | "candidate_root" | "rollback_root";
    objectIds: string[];
  }
): Promise<void> {
  if (input.objectIds.length === 0) return;
  await sql`
    INSERT INTO focowiki.object_owners (
      public_id, knowledge_base_id, object_id, owner_kind,
      release_root_public_id
    )
    SELECT * FROM unnest(
      ${input.objectIds.map((objectId) => storageVnextRootOwnerPublicId(objectId, input.rootPublicId))}::text[],
      ${input.objectIds.map(() => input.knowledgeBaseId)}::text[],
      ${input.objectIds}::text[],
      ${input.objectIds.map(() => input.kind)}::text[],
      ${input.objectIds.map(() => input.rootPublicId)}::text[]
    )
    ON CONFLICT DO NOTHING
  `;
  await sql`
    UPDATE focowiki.object_registrations
    SET zero_owner_since = NULL
    WHERE object_id = ANY(${input.objectIds})
  `;
}

async function releaseUnusedRootOwners(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    operationPublicId: string;
    rootPublicId: string;
    objectIds: string[];
  }
): Promise<void> {
  if (input.objectIds.length === 0) return;
  await sql`
    DELETE FROM focowiki.object_owners owner
    WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
      AND owner.release_root_public_id = ${input.rootPublicId}
      AND owner.object_id = ANY(${input.objectIds})
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.release_catalog_entries entry
        WHERE entry.release_root_public_id = ${input.rootPublicId}
          AND entry.object_id = owner.object_id
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.release_root_shards attached
        JOIN focowiki.release_shards shard
          ON shard.knowledge_base_id = attached.knowledge_base_id
         AND shard.public_id = attached.release_shard_public_id
        WHERE attached.release_root_public_id = ${input.rootPublicId}
          AND shard.object_id = owner.object_id
      )
  `;
  await markZeroOwnerObjects(sql, input.objectIds);
  await enqueueStorageVnextCandidateObjectCleanupActions(sql as TransactionSql, {
    knowledgeBaseId: input.knowledgeBaseId,
    operationPublicId: input.operationPublicId,
    candidateRootPublicId: input.rootPublicId,
    objectIds: input.objectIds
  });
}

async function requireCandidateObjectsReady(sql: ReadSql, rootPublicId: string) {
  const rows = await sql<Array<{ invalid_count: number | string }>>`
    SELECT count(*) AS invalid_count
    FROM focowiki.object_owners owner
    LEFT JOIN focowiki.object_registrations object
      ON object.object_id = owner.object_id
    WHERE owner.release_root_public_id = ${rootPublicId}
      AND owner.owner_kind = 'candidate_root'
      AND (object.object_id IS NULL OR object.state <> 'verified')
  `;
  if (Number(rows[0]?.invalid_count ?? 0) > 0) {
    throw new StorageVnextReleaseRepositoryError("object_not_verified");
  }
}

async function readCandidateValidationActuals(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    candidatePublicId: string;
    candidateRootPublicId: string;
    searchProjectionPublicId: string;
  }
): Promise<{
  objectOwnerCount: number;
  searchDocumentCount: number;
  searchRole: string;
  searchState: string;
  graphNodeCount: number;
  graphEdgeCount: number;
  linkCount: number;
  generatedEntryCount: number;
} | null> {
  const rows = await sql<Array<{
    object_owner_count: number | string;
    search_document_count: number | string;
    projection_role: string;
    state: string;
    graph_node_count: number | string | null;
    graph_edge_count: number | string | null;
    link_count: number | string;
    generated_entry_count: number | string | null;
  }>>`
    SELECT
      (SELECT count(DISTINCT owner.object_id)
       FROM focowiki.object_owners owner
       WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
         AND owner.release_root_public_id = ${input.candidateRootPublicId}
         AND owner.owner_kind = 'candidate_root') AS object_owner_count,
      search.document_count AS search_document_count,
      search.projection_role,
      search.state,
      summary.graph_node_count,
      summary.graph_edge_count,
      (SELECT count(*)
       FROM focowiki.release_candidate_dependencies dependency
       WHERE dependency.candidate_public_id = ${input.candidatePublicId}
         AND dependency.dependency_kind = 'link') AS link_count,
      summary.generated_entry_count
    FROM focowiki.search_projections search
    LEFT JOIN focowiki.knowledge_base_summaries summary
      ON summary.knowledge_base_id = search.knowledge_base_id
     AND summary.release_root_public_id = ${input.candidateRootPublicId}
    WHERE search.knowledge_base_id = ${input.knowledgeBaseId}
      AND search.public_id = ${input.searchProjectionPublicId}
    FOR UPDATE OF search
  `;
  const row = rows[0];
  return row ? {
    objectOwnerCount: Number(row.object_owner_count),
    searchDocumentCount: Number(row.search_document_count),
    searchRole: row.projection_role,
    searchState: row.state,
    graphNodeCount: Number(row.graph_node_count ?? 0),
    graphEdgeCount: Number(row.graph_edge_count ?? 0),
    linkCount: Number(row.link_count),
    generatedEntryCount: Number(row.generated_entry_count ?? 0)
  } : null;
}

async function deleteRootAndReleaseObjects(
  sql: ReadSql,
  input: { knowledgeBaseId: string; rootPublicId: string }
): Promise<string[]> {
  const rows = await sql<Array<{ object_id: string }>>`
    SELECT object_id
    FROM focowiki.object_owners
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND release_root_public_id = ${input.rootPublicId}
    FOR UPDATE
  `;
  await sql`
    DELETE FROM focowiki.release_roots
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.rootPublicId}
  `;
  await sql`
    DELETE FROM focowiki.release_shards shard
    WHERE shard.knowledge_base_id = ${input.knowledgeBaseId}
      AND NOT EXISTS (
      SELECT 1 FROM focowiki.release_root_shards attached
      WHERE attached.knowledge_base_id = shard.knowledge_base_id
        AND attached.release_shard_public_id = shard.public_id
    )
  `;
  await markZeroOwnerObjects(sql, rows.map((row) => row.object_id));
  return rows.map((row) => row.object_id);
}

async function retireRollbackRoot(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    rootPublicId: string;
    expectedActiveRootPublicId: string | null;
    cleanupOperationPublicId?: string;
  }
): Promise<boolean> {
  const children = await sql<Array<{
    public_id: string;
    root_role: string;
  }>>`
    SELECT public_id, root_role
    FROM focowiki.release_roots
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND base_root_public_id = ${input.rootPublicId}
    FOR UPDATE
  `;
  if (children.length === 0) {
    await deleteRootAndReleaseObjects(sql, input);
    return true;
  }
  const child = children[0];
  if (
    children.length !== 1
    || child?.root_role !== "active"
    || (
      input.expectedActiveRootPublicId !== null
      && child.public_id !== input.expectedActiveRootPublicId
    )
  ) return false;
  const depth = await releaseLineageDepth(
    sql,
    input.knowledgeBaseId,
    child.public_id
  );
  if (depth >= MAX_STORAGE_VNEXT_RELEASE_LINEAGE_DEPTH) {
    await compactActiveReleaseLineage(sql, {
      knowledgeBaseId: input.knowledgeBaseId,
      activeRootPublicId: child.public_id,
      ...(input.cleanupOperationPublicId
        ? { cleanupOperationPublicId: input.cleanupOperationPublicId }
        : {})
    });
    return true;
  }
  await sql`
    UPDATE focowiki.release_roots
    SET root_role = 'base', expires_at = NULL
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.rootPublicId}
      AND root_role = 'rollback'
  `;
  await sql`
    UPDATE focowiki.object_owners
    SET owner_kind = 'active_root'
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND release_root_public_id = ${input.rootPublicId}
      AND owner_kind = 'rollback_root'
  `;
  return true;
}

async function releaseLineageDepth(
  sql: ReadSql,
  knowledgeBaseId: string,
  rootPublicId: string
): Promise<number> {
  const rows = await sql<Array<{ depth: number | string }>>`
    WITH RECURSIVE lineage AS (
      SELECT root.public_id, root.base_root_public_id, 1::bigint AS depth,
             ARRAY[root.public_id]::text[] AS visited
      FROM focowiki.release_roots root
      WHERE root.knowledge_base_id = ${knowledgeBaseId}
        AND root.public_id = ${rootPublicId}
      UNION ALL
      SELECT base.public_id, base.base_root_public_id, lineage.depth + 1,
             lineage.visited || base.public_id
      FROM lineage
      JOIN focowiki.release_roots base
        ON base.knowledge_base_id = ${knowledgeBaseId}
       AND base.public_id = lineage.base_root_public_id
      WHERE lineage.depth < ${MAX_STORAGE_VNEXT_RELEASE_LINEAGE_DEPTH + 1}
        AND NOT base.public_id = ANY(lineage.visited)
    )
    SELECT coalesce(max(depth), 0) AS depth FROM lineage
  `;
  return Number(rows[0]?.depth ?? 0);
}

async function compactActiveReleaseLineage(
  sql: ReadSql,
  input: {
    knowledgeBaseId: string;
    activeRootPublicId: string;
    minimumDepth?: number;
    cleanupOperationPublicId?: string;
  }
): Promise<void> {
  const minimumDepth = input.minimumDepth ?? MAX_STORAGE_VNEXT_RELEASE_LINEAGE_DEPTH;
  const lineage = await sql<Array<{ public_id: string; depth: number | string }>>`
    WITH RECURSIVE roots AS (
      SELECT root.public_id, root.base_root_public_id, 0::bigint AS depth,
             ARRAY[root.public_id]::text[] AS visited
      FROM focowiki.release_roots root
      WHERE root.knowledge_base_id = ${input.knowledgeBaseId}
        AND root.public_id = ${input.activeRootPublicId}
        AND root.root_role = 'active'
      UNION ALL
      SELECT base.public_id, base.base_root_public_id, roots.depth + 1,
             roots.visited || base.public_id
      FROM roots
      JOIN focowiki.release_roots base
        ON base.knowledge_base_id = ${input.knowledgeBaseId}
       AND base.public_id = roots.base_root_public_id
      WHERE roots.depth < ${MAX_STORAGE_VNEXT_RELEASE_LINEAGE_DEPTH}
        AND NOT base.public_id = ANY(roots.visited)
    )
    SELECT public_id, depth FROM roots ORDER BY depth
  `;
  if (lineage.length < minimumDepth) {
    throw new StorageVnextReleaseRepositoryError("scope_conflict");
  }
  const objectRows = await sql<Array<{ object_id: string }>>`
    SELECT DISTINCT object_id
    FROM (
      SELECT entry.object_id
      FROM focowiki.resolve_release_catalog(${input.activeRootPublicId}) entry
      UNION
      SELECT shard.object_id
      FROM focowiki.resolve_release_shards(${input.activeRootPublicId}) shard
    ) object
  `;
  await sql`
    INSERT INTO focowiki.release_catalog_entries (
      knowledge_base_id, release_root_public_id, logical_path, entry_kind,
      source_file_public_id, checksum_sha256, object_id, byte_count, ordinal
    )
    SELECT ${input.knowledgeBaseId}, ${input.activeRootPublicId},
           entry.logical_path, entry.entry_kind,
           entry.source_file_public_id, entry.checksum_sha256,
           entry.object_id, entry.byte_count, entry.ordinal
    FROM focowiki.resolve_release_catalog(${input.activeRootPublicId}) entry
    WHERE NOT entry.root_owned
    ON CONFLICT (release_root_public_id, logical_path) DO NOTHING
  `;
  await sql`
    DELETE FROM focowiki.release_catalog_tombstones
    WHERE release_root_public_id = ${input.activeRootPublicId}
  `;
  await sql`
    INSERT INTO focowiki.directory_summaries (
      knowledge_base_id, release_root_public_id, directory_public_id,
      logical_path, first_leaf_path, direct_file_count,
      descendant_file_count, ordinal
    )
    SELECT ${input.knowledgeBaseId}, ${input.activeRootPublicId},
           summary.directory_public_id, summary.logical_path,
           summary.first_leaf_path, summary.direct_file_count,
           summary.descendant_file_count, summary.ordinal
    FROM focowiki.resolve_release_directory_summaries(
      ${input.activeRootPublicId}
    ) summary
    WHERE NOT summary.root_owned
    ON CONFLICT (release_root_public_id, logical_path) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.knowledge_base_summaries (
      release_root_public_id, knowledge_base_id, source_file_count,
      directory_count, generated_entry_count, graph_node_count,
      graph_edge_count, generated_byte_count
    )
    SELECT ${input.activeRootPublicId}, ${input.knowledgeBaseId},
           summary.source_file_count, summary.directory_count,
           summary.generated_entry_count, summary.graph_node_count,
           summary.graph_edge_count, summary.generated_byte_count
    FROM focowiki.resolve_release_knowledge_base_summary(
      ${input.activeRootPublicId}
    ) summary
    ON CONFLICT (release_root_public_id) DO NOTHING
  `;
  await sql`
    INSERT INTO focowiki.release_root_shards (
      knowledge_base_id, release_root_public_id,
      release_shard_public_id, ordinal
    )
    SELECT ${input.knowledgeBaseId}, ${input.activeRootPublicId},
           shard.public_id, shard.ordinal
    FROM focowiki.resolve_release_shards(${input.activeRootPublicId}) shard
    WHERE NOT shard.root_owned
    ON CONFLICT DO NOTHING
  `;
  await attachRootOwners(sql, {
    knowledgeBaseId: input.knowledgeBaseId,
    rootPublicId: input.activeRootPublicId,
    kind: "active_root",
    objectIds: objectRows.map((row) => row.object_id)
  });
  await sql`
    UPDATE focowiki.release_roots
    SET base_root_public_id = NULL
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.activeRootPublicId}
      AND root_role = 'active'
  `;
  const retiredObjectIds: string[] = [];
  for (const root of lineage.slice(1)) {
    retiredObjectIds.push(...await deleteRootAndReleaseObjects(sql, {
      knowledgeBaseId: input.knowledgeBaseId,
      rootPublicId: root.public_id
    }));
  }
  if (input.cleanupOperationPublicId) {
    await enqueueStorageVnextCandidateObjectCleanupActions(sql as TransactionSql, {
      knowledgeBaseId: input.knowledgeBaseId,
      operationPublicId: input.cleanupOperationPublicId,
      candidateRootPublicId: input.activeRootPublicId,
      objectIds: retiredObjectIds
    });
  }
}

async function isMaintenanceOperation(
  sql: ReadSql,
  input: { knowledgeBaseId: string; operationPublicId: string }
): Promise<boolean> {
  const rows = await sql<Array<{ operation_kind: string }>>`
    SELECT operation_kind
    FROM focowiki.operations
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND public_id = ${input.operationPublicId}
    LIMIT 1
  `;
  return rows[0]?.operation_kind === "maintenance";
}

async function markZeroOwnerObjects(sql: ReadSql, objectIds: string[]) {
  if (objectIds.length === 0) return;
  await sql`
    UPDATE focowiki.object_registrations object
    SET zero_owner_since = coalesce(zero_owner_since, now())
    WHERE object.object_id = ANY(${uniqueStorageVnextValues(objectIds)})
      AND object.state = 'verified'
      AND NOT EXISTS (
        SELECT 1 FROM focowiki.object_owners owner
        WHERE owner.object_id = object.object_id
      )
  `;
}

async function readCandidateEvent(
  sql: ReadSql,
  input: { knowledgeBaseId: string; candidatePublicId: string; outcome: string }
): Promise<StorageVnextReleaseEventRow | null> {
  const rows = await sql<StorageVnextReleaseEventRow[]>`
    SELECT public_id, knowledge_base_id, operation_public_id,
           candidate_public_id, release_root_public_id, outcome,
           result_code, safe_message, revision, created_at, expires_at
    FROM focowiki.release_event_summaries
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND candidate_public_id = ${input.candidatePublicId}
      AND outcome = ${input.outcome}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

async function writeReleaseEvent(
  sql: ReadSql,
  event: StorageVnextReleaseEventSummary
): Promise<void> {
  await sql`
    INSERT INTO focowiki.release_event_summaries (
      public_id, knowledge_base_id, operation_public_id,
      candidate_public_id, release_root_public_id, outcome,
      result_code, safe_message, revision, created_at, expires_at
    ) VALUES (
      ${event.publicId}, ${event.knowledgeBaseId}, ${event.operationPublicId},
      ${event.candidatePublicId}, ${event.releaseRootPublicId}, ${event.outcome},
      ${event.resultCode}, ${event.safeMessage}, ${event.revision},
      ${event.createdAt}, ${event.expiresAt}
    )
    ON CONFLICT (knowledge_base_id, candidate_public_id, outcome) DO NOTHING
  `;
}

async function lockRelease(sql: ReadSql, knowledgeBaseId: string): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended('focowiki:storage-vnext:release:' || ${knowledgeBaseId}, 0)
    )
  `;
}
