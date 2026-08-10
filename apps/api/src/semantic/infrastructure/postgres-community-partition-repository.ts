import type { DatabaseClient } from "../../db/client.js";
import type {
  CommunityPartitionClaim,
  CommunityPartitionRepositoryPort
} from "../application/community-ports.js";

type ClaimRow = {
  knowledge_base_id: string;
  semantic_generation_public_id: string;
  public_id: string;
  partition_key: string;
  reason_kind: CommunityPartitionClaim["reasonKind"];
  input_version: string;
  attempt_count: number | string;
  checkpoint: unknown;
  lease_owner: string;
  lease_expires_at: Date | string;
  revision: number | string;
};

export function createPostgresCommunityPartitionRepository(
  sql: DatabaseClient
): CommunityPartitionRepositoryPort {
  return {
    async upsertAssignments(input) {
      assertBatch(input.assignments);
      if (input.assignments.length === 0) return;
      await sql`
        INSERT INTO focowiki.semantic_entity_partitions (
          knowledge_base_id, semantic_generation_public_id, entity_public_id,
          partition_key, input_version
        )
        SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
               item."entityPublicId", item."partitionKey", item."inputVersion"
        FROM jsonb_to_recordset(${sql.json(input.assignments as never)}) AS item(
          "entityPublicId" text, "partitionKey" text, "inputVersion" text
        )
        ON CONFLICT (semantic_generation_public_id, entity_public_id) DO UPDATE SET
          partition_key = excluded.partition_key,
          input_version = excluded.input_version,
          updated_at = now()
        WHERE focowiki.semantic_entity_partitions.knowledge_base_id
          = excluded.knowledge_base_id
      `;
    },
    async enqueueDirty(input) {
      assertBatch(input.partitions);
      if (input.partitions.length === 0) return;
      await sql`
        INSERT INTO focowiki.semantic_dirty_partitions (
          knowledge_base_id, semantic_generation_public_id, public_id,
          partition_key, reason_kind, input_version, state, attempt_count,
          checkpoint, revision
        )
        SELECT ${input.knowledgeBaseId}, ${input.semanticGenerationPublicId},
               item."publicId", item."partitionKey", item."reasonKind",
               item."inputVersion", 'dirty', 0, '{}'::jsonb, 0
        FROM jsonb_to_recordset(${sql.json(input.partitions as never)}) AS item(
          "publicId" text, "partitionKey" text, "reasonKind" text,
          "inputVersion" text
        )
        ON CONFLICT (semantic_generation_public_id, partition_key) DO UPDATE SET
          reason_kind = excluded.reason_kind,
          input_version = excluded.input_version,
          state = 'dirty', attempt_count = 0, checkpoint = '{}'::jsonb,
          lease_owner = NULL, lease_expires_at = NULL,
          next_attempt_at = now(), safe_error_code = NULL,
          revision = focowiki.semantic_dirty_partitions.revision + 1,
          updated_at = now()
        WHERE focowiki.semantic_dirty_partitions.knowledge_base_id
          = excluded.knowledge_base_id
      `;
    },
    async claimNext(input) {
      assertTimestamp(input.now);
      assertTimestamp(input.leaseExpiresAt);
      if (!input.workerId || input.workerId.length > 255) throw repositoryError("invalid_worker");
      const rows = await sql<ClaimRow[]>`
        WITH claimable AS (
          SELECT partition.semantic_generation_public_id, partition.public_id
          FROM focowiki.semantic_dirty_partitions partition
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = partition.knowledge_base_id
           AND generation.public_id = partition.semantic_generation_public_id
           AND (
             generation.generation_role = 'candidate'
               AND generation.state IN ('building', 'validating')
             OR generation.generation_role = 'active'
               AND generation.state = 'active'
           )
           AND generation.deleted_at IS NULL
          WHERE (
            partition.state IN ('dirty', 'failed')
              AND partition.next_attempt_at <= ${input.now}
            OR partition.state = 'processing'
              AND partition.lease_expires_at <= ${input.now}
          )
            AND partition.knowledge_base_id = ${input.knowledgeBaseId}
            AND partition.semantic_generation_public_id
              = ${input.semanticGenerationPublicId}
          ORDER BY partition.next_attempt_at, partition.updated_at,
            partition.public_id COLLATE "C"
          LIMIT 1
          FOR UPDATE OF partition SKIP LOCKED
        )
        UPDATE focowiki.semantic_dirty_partitions partition
        SET state = 'processing', lease_owner = ${input.workerId},
            lease_expires_at = ${input.leaseExpiresAt},
            attempt_count = partition.attempt_count + 1,
            safe_error_code = NULL, revision = partition.revision + 1,
            updated_at = ${input.now}
        FROM claimable
        WHERE partition.semantic_generation_public_id
          = claimable.semantic_generation_public_id
          AND partition.public_id = claimable.public_id
        RETURNING partition.knowledge_base_id,
          partition.semantic_generation_public_id, partition.public_id,
          partition.partition_key, partition.reason_kind,
          partition.input_version, partition.attempt_count,
          partition.checkpoint, partition.lease_owner,
          partition.lease_expires_at, partition.revision
      `;
      return rows[0] ? mapClaim(rows[0]) : null;
    },
    async loadPage(input) {
      assertPageBound(input.maximumEntities, 10_000);
      assertPageBound(input.maximumRelationships, 20_000, true);
      assertPageBound(input.maximumBoundaryRelationships, 10_000, true);
      const cursor = input.claim.checkpoint.entityCursor;
      const entityRows = await sql<Array<{ entity_public_id: string }>>`
        SELECT assignment.entity_public_id
        FROM focowiki.semantic_entity_partitions assignment
        JOIN focowiki.semantic_entities entity
          ON entity.knowledge_base_id = assignment.knowledge_base_id
         AND entity.semantic_generation_public_id
           = assignment.semantic_generation_public_id
         AND entity.public_id = assignment.entity_public_id
         AND entity.deleted_at IS NULL
        WHERE assignment.knowledge_base_id = ${input.claim.knowledgeBaseId}
          AND assignment.semantic_generation_public_id
            = ${input.claim.semanticGenerationPublicId}
          AND assignment.partition_key = ${input.claim.partitionKey}
          AND (${cursor}::text IS NULL
            OR assignment.entity_public_id COLLATE "C" > ${cursor}::text COLLATE "C")
        ORDER BY assignment.entity_public_id COLLATE "C"
        LIMIT ${input.maximumEntities + 1}
      `;
      const entityPublicIds = entityRows.slice(0, input.maximumEntities)
        .map((row) => row.entity_public_id);
      const relationshipLimit = input.maximumRelationships
        + input.maximumBoundaryRelationships;
      const relationshipRows = entityPublicIds.length === 0 ? [] : await sql<Array<{
        public_id: string;
        from_entity_public_id: string;
        to_entity_public_id: string;
        confidence: number | string;
      }>>`
        SELECT relationship.public_id, relationship.from_entity_public_id,
               relationship.to_entity_public_id, relationship.confidence
        FROM focowiki.semantic_relationships relationship
        WHERE relationship.knowledge_base_id = ${input.claim.knowledgeBaseId}
          AND relationship.semantic_generation_public_id
            = ${input.claim.semanticGenerationPublicId}
          AND relationship.deleted_at IS NULL
          AND (relationship.from_entity_public_id = ANY(${entityPublicIds})
            OR relationship.to_entity_public_id = ANY(${entityPublicIds}))
        ORDER BY relationship.public_id COLLATE "C"
        LIMIT ${relationshipLimit + 1}
      `;
      return {
        entityPublicIds,
        relationships: relationshipRows.slice(0, relationshipLimit).map((row) => ({
          publicId: row.public_id,
          fromEntityPublicId: row.from_entity_public_id,
          toEntityPublicId: row.to_entity_public_id,
          weight: Math.max(Number(row.confidence), Number.EPSILON)
        })),
        nextEntityCursor: entityRows.length > input.maximumEntities
          ? entityPublicIds.at(-1) ?? null
          : null,
        relationshipTruncated: relationshipRows.length > relationshipLimit
      };
    },
    async isCurrent(input) {
      const rows = await sql<Array<{ current: boolean }>>`
        SELECT EXISTS (
          SELECT 1 FROM focowiki.semantic_dirty_partitions partition
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = partition.knowledge_base_id
           AND generation.public_id = partition.semantic_generation_public_id
          WHERE partition.knowledge_base_id = ${input.claim.knowledgeBaseId}
            AND partition.semantic_generation_public_id
              = ${input.claim.semanticGenerationPublicId}
            AND partition.public_id = ${input.claim.publicId}
            AND partition.input_version = ${input.claim.inputVersion}
            AND partition.state = 'processing'
            AND partition.lease_owner = ${input.claim.leaseOwner}
            AND partition.revision = ${input.claim.revision}
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
            AND generation.deleted_at IS NULL
        ) AS current
      `;
      return rows[0]?.current === true;
    },
    async saveCheckpoint(input) {
      const state = checkpointState(input.outcome);
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.semantic_dirty_partitions
        SET state = ${state},
            checkpoint = ${sql.json({
              entityCursor: input.entityCursor,
              relationshipTruncated: input.relationshipTruncated
            })},
            lease_owner = NULL, lease_expires_at = NULL,
            next_attempt_at = ${input.nextAttemptAt},
            safe_error_code = ${input.safeCode}, revision = revision + 1,
            updated_at = now()
        WHERE knowledge_base_id = ${input.claim.knowledgeBaseId}
          AND semantic_generation_public_id
            = ${input.claim.semanticGenerationPublicId}
          AND public_id = ${input.claim.publicId}
          AND input_version = ${input.claim.inputVersion}
          AND state = 'processing'
          AND lease_owner = ${input.claim.leaseOwner}
          AND revision = ${input.claim.revision}
        RETURNING public_id
      `;
      return Boolean(rows[0]);
    },
    async replacePartition(input) {
      assertBatch(input.outputs);
      return sql.begin(async (transaction) => {
        const current = await transaction<Array<{ public_id: string }>>`
          SELECT partition.public_id
          FROM focowiki.semantic_dirty_partitions partition
          JOIN focowiki.semantic_generations generation
            ON generation.knowledge_base_id = partition.knowledge_base_id
           AND generation.public_id = partition.semantic_generation_public_id
          WHERE partition.knowledge_base_id = ${input.claim.knowledgeBaseId}
            AND partition.semantic_generation_public_id
              = ${input.claim.semanticGenerationPublicId}
            AND partition.public_id = ${input.claim.publicId}
            AND partition.input_version = ${input.claim.inputVersion}
            AND partition.state = 'processing'
            AND partition.lease_owner = ${input.claim.leaseOwner}
            AND partition.revision = ${input.claim.revision}
            AND (
              generation.generation_role = 'candidate'
                AND generation.state IN ('building', 'validating')
              OR generation.generation_role = 'active'
                AND generation.state = 'active'
            )
          FOR UPDATE OF partition
        `;
        if (!current[0]) throw repositoryError("stale_partition");
        const desiredIds = input.outputs.map((output) => output.communityPublicId);
        const prior = await transaction<Array<{
          public_id: string;
          report_checksum_sha256: string | null;
        }>>`
          SELECT community.public_id, report.report_checksum_sha256
          FROM focowiki.semantic_communities community
          LEFT JOIN focowiki.semantic_community_reports report
            ON report.knowledge_base_id = community.knowledge_base_id
           AND report.semantic_generation_public_id
             = community.semantic_generation_public_id
           AND report.community_public_id = community.public_id
          WHERE community.knowledge_base_id = ${input.claim.knowledgeBaseId}
            AND community.semantic_generation_public_id
              = ${input.claim.semanticGenerationPublicId}
            AND community.source_partition_key = ${input.claim.partitionKey}
          ORDER BY community.public_id COLLATE "C"
        `;
        await transaction`
          DELETE FROM focowiki.semantic_communities
          WHERE knowledge_base_id = ${input.claim.knowledgeBaseId}
            AND semantic_generation_public_id
              = ${input.claim.semanticGenerationPublicId}
            AND source_partition_key = ${input.claim.partitionKey}
            AND public_id <> ALL(${desiredIds})
        `;
        if (input.outputs.length > 0) {
          const rows = input.outputs.map((output) => ({
            ...output,
            partitionKey: `${input.claim.partitionKey}/${output.level}/${
              output.communityPublicId.slice(0, 16)}`,
            reportPublicId: `report-${output.communityPublicId}`
          }));
          await transaction`
            INSERT INTO focowiki.semantic_communities (
              knowledge_base_id, semantic_generation_public_id, public_id,
              source_partition_key, partition_key, level, title, revision
            )
            SELECT ${input.claim.knowledgeBaseId},
                   ${input.claim.semanticGenerationPublicId}, item."communityPublicId",
                   ${input.claim.partitionKey}, item."partitionKey", item.level,
                   NULL, 1
            FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS item(
              "communityPublicId" text, "partitionKey" text, level integer
            )
            ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
              source_partition_key = excluded.source_partition_key,
              partition_key = excluded.partition_key,
              level = excluded.level, deleted_at = NULL,
              revision = CASE WHEN ROW(
                focowiki.semantic_communities.source_partition_key,
                focowiki.semantic_communities.partition_key,
                focowiki.semantic_communities.level
              ) IS DISTINCT FROM ROW(
                excluded.source_partition_key, excluded.partition_key, excluded.level
              ) THEN focowiki.semantic_communities.revision + 1
                ELSE focowiki.semantic_communities.revision END
            WHERE focowiki.semantic_communities.knowledge_base_id
              = excluded.knowledge_base_id
          `;
          await transaction`
            DELETE FROM focowiki.semantic_community_memberships membership
            USING focowiki.semantic_communities community
            WHERE membership.knowledge_base_id = ${input.claim.knowledgeBaseId}
              AND membership.semantic_generation_public_id
                = ${input.claim.semanticGenerationPublicId}
              AND community.knowledge_base_id = membership.knowledge_base_id
              AND community.semantic_generation_public_id
                = membership.semantic_generation_public_id
              AND community.public_id = membership.community_public_id
              AND community.source_partition_key = ${input.claim.partitionKey}
          `;
          const memberships = input.outputs.flatMap((output) =>
            output.entityPublicIds.map((entityPublicId) => ({
              communityPublicId: output.communityPublicId,
              entityPublicId
            }))
          );
          if (memberships.length > 0) await transaction`
            INSERT INTO focowiki.semantic_community_memberships (
              knowledge_base_id, semantic_generation_public_id,
              community_public_id, entity_public_id, membership_weight
            )
            SELECT ${input.claim.knowledgeBaseId},
                   ${input.claim.semanticGenerationPublicId},
                   item."communityPublicId", item."entityPublicId", 1
            FROM jsonb_to_recordset(${transaction.json(memberships as never)}) AS item(
              "communityPublicId" text, "entityPublicId" text
            )
            ON CONFLICT DO NOTHING
          `;
          await transaction`
            INSERT INTO focowiki.semantic_community_reports (
              knowledge_base_id, semantic_generation_public_id, public_id,
              community_public_id, input_graph_version, boundary_version,
              summary, report_checksum_sha256
            )
            SELECT ${input.claim.knowledgeBaseId},
                   ${input.claim.semanticGenerationPublicId}, item."reportPublicId",
                   item."communityPublicId", ${input.claim.inputVersion},
                   ${input.boundaryVersion}, item.summary, item."checksumSha256"
            FROM jsonb_to_recordset(${transaction.json(rows as never)}) AS item(
              "reportPublicId" text, "communityPublicId" text,
              summary text, "checksumSha256" text
            )
            ON CONFLICT (semantic_generation_public_id, public_id) DO UPDATE SET
              input_graph_version = excluded.input_graph_version,
              boundary_version = excluded.boundary_version,
              summary = excluded.summary,
              report_checksum_sha256 = excluded.report_checksum_sha256
            WHERE focowiki.semantic_community_reports.knowledge_base_id
              = excluded.knowledge_base_id
          `;
        }
        const priorChecksums = new Map(prior.map((row) => [
          row.public_id, row.report_checksum_sha256
        ]));
        const unchanged = prior.length === input.outputs.length
          && input.outputs.every((output) =>
            priorChecksums.get(output.communityPublicId) === output.checksumSha256);
        if (unchanged) return "reused" as const;
        return prior.length === 0 ? "created" as const : "updated" as const;
      });
    }
  };
}

function mapClaim(row: ClaimRow): CommunityPartitionClaim {
  const checkpoint = isRecord(row.checkpoint) ? row.checkpoint : {};
  return {
    knowledgeBaseId: row.knowledge_base_id,
    semanticGenerationPublicId: row.semantic_generation_public_id,
    publicId: row.public_id,
    partitionKey: row.partition_key,
    reasonKind: row.reason_kind,
    inputVersion: row.input_version,
    attemptCount: Number(row.attempt_count),
    checkpoint: {
      entityCursor: typeof checkpoint.entityCursor === "string"
        ? checkpoint.entityCursor : null,
      relationshipTruncated: checkpoint.relationshipTruncated === true
    },
    leaseOwner: row.lease_owner,
    leaseExpiresAt: new Date(row.lease_expires_at).toISOString(),
    revision: Number(row.revision)
  };
}

function checkpointState(outcome: Parameters<CommunityPartitionRepositoryPort["saveCheckpoint"]>[0]["outcome"]) {
  switch (outcome) {
    case "continue": return "dirty";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "cancelled";
    case "superseded": return "superseded";
  }
}

function assertBatch(values: readonly unknown[]): void {
  if (values.length > 1_000) throw repositoryError("batch_limit");
}

function assertPageBound(value: number, maximum: number, allowZero = false): void {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > maximum) {
    throw repositoryError("page_limit");
  }
}

function assertTimestamp(value: string): void {
  if (!Number.isFinite(Date.parse(value))) throw repositoryError("invalid_timestamp");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function repositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Community partition repository error: ${code}`), { code });
}
