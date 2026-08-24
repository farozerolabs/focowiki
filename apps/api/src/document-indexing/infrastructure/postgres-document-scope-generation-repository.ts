import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentScopeGenerationRepository } from
  "../application/document-publication-repository-ports.js";
import { documentLeaseGeneration } from
  "../domain/document-publication-identifiers.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import {
  persistDocumentScopeGenerationOutput,
  reuseCompletedDocumentScopeGenerationOutput
} from "./postgres-document-scope-generation-output.js";
import {
  supersedeDocumentScopeGenerationSiblings,
  transitionFailedDocumentScopeGeneration
} from "./postgres-document-scope-generation-failure.js";
import {
  recomputeDocumentScopeGeneration,
  recoverDocumentScopeGenerationResourceFailure
} from "./postgres-document-scope-generation-resource-recovery.js";
import { createPostgresDocumentScopeSnapshotMemberRepository } from
  "./postgres-document-scope-snapshot-members.js";
import { createPostgresDocumentScopeGenerationHeartbeat } from
  "./postgres-document-scope-generation-heartbeat.js";

export function createPostgresDocumentScopeGenerationRepository(
  sql: DatabaseClient
): DocumentScopeGenerationRepository {
  const snapshotMembers = createPostgresDocumentScopeSnapshotMemberRepository(sql);
  const heartbeat = createPostgresDocumentScopeGenerationHeartbeat(sql);
  return {
    ...snapshotMembers,
    ...heartbeat,
    async create(input): Promise<void> {
      const rows = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.projection_scope_generations (
          public_id, publication_generation_public_id, knowledge_base_id,
          scope_identity, scope_kind, scope_key, scope_generation,
          input_snapshot_fingerprint_sha256, next_eligible_at,
          created_at, updated_at
        ) VALUES (
          ${assertRepositoryIdentity(input.publicId, "public_id")},
          ${input.publicationGenerationId},
          ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
          ${assertScopeIdentity(input.scopeIdentity)}, ${input.scopeKind},
          ${assertScopeKey(input.scopeKey)}, ${input.scopeGeneration},
          ${assertRepositorySha256(
            input.inputSnapshotFingerprintSha256,
            "input_snapshot_fingerprint"
          )}, ${assertRepositoryTimestamp(input.createdAt, "created_at")},
          ${input.createdAt},
          ${input.createdAt}
        )
        ON CONFLICT (public_id) DO UPDATE SET public_id = excluded.public_id
        WHERE projection_scope_generations.publication_generation_public_id
                = excluded.publication_generation_public_id
          AND projection_scope_generations.knowledge_base_id
                = excluded.knowledge_base_id
          AND projection_scope_generations.scope_identity
                = excluded.scope_identity
          AND projection_scope_generations.scope_generation
                = excluded.scope_generation
          AND projection_scope_generations.input_snapshot_fingerprint_sha256
                = excluded.input_snapshot_fingerprint_sha256
        RETURNING public_id
      `;
      if (!rows[0]) throw repositoryContractError("scope_generation_conflict");
    },

    async claim(input) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const expiresAt = new Date(Date.parse(now)
        + assertRepositoryPositiveInteger(
          input.leaseDurationMs,
          "lease_duration",
          300_000
        )).toISOString();
      return sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.projection_scheduler_credits (
            knowledge_base_id, lane, waiting_count,
            oldest_waiting_at, updated_at
          )
          SELECT scope.knowledge_base_id, 'scope', count(*),
                 min(scope.created_at), ${now}
          FROM focowiki.projection_scope_generations scope
          JOIN focowiki.projection_publication_generations generation
            ON generation.public_id = scope.publication_generation_public_id
           AND generation.state IN ('planned', 'rendering', 'validating', 'ready')
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.public_id = scope.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE scope.state = 'waiting'
            AND scope.next_eligible_at <= ${now}
          GROUP BY scope.knowledge_base_id
          ON CONFLICT (knowledge_base_id, lane) DO UPDATE
          SET waiting_count = excluded.waiting_count,
              oldest_waiting_at = excluded.oldest_waiting_at,
              updated_at = excluded.updated_at
        `;
        const rows = await transaction<Array<{
          public_id: string;
          knowledge_base_id: string;
          publication_generation_public_id: string;
          scope_identity: string;
          scope_kind: string;
          scope_generation: number | string;
          target_fact_epoch: number | string;
          active_fact_epoch: number | string;
          lease_generation: number | string;
          consecutive_lease_loss_count: number | string;
        }>>`
          WITH eligible AS (
            SELECT scope.public_id, scope.knowledge_base_id,
                   row_number() OVER (
                     PARTITION BY scope.knowledge_base_id
                     ORDER BY scope.created_at, scope.public_id COLLATE "C"
                   ) AS knowledge_base_rank,
                   credit.last_selected_at
            FROM focowiki.projection_scope_generations scope
            JOIN focowiki.projection_publication_generations generation
              ON generation.public_id = scope.publication_generation_public_id
             AND generation.state IN (
               'planned', 'rendering', 'validating', 'ready'
             )
            JOIN focowiki.projection_scheduler_credits credit
              ON credit.knowledge_base_id = scope.knowledge_base_id
             AND credit.lane = 'scope'
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.public_id = scope.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
            LEFT JOIN focowiki.projection_cutover_states cutover
              ON cutover.knowledge_base_id = scope.knowledge_base_id
            WHERE scope.state = 'waiting'
              AND scope.next_eligible_at <= ${now}
              AND (cutover.knowledge_base_id IS NULL
                OR cutover.writer_mode = 'coherent')
              AND NOT EXISTS (
                SELECT 1
                FROM focowiki.projection_scope_generation_dependencies dependency
                JOIN focowiki.projection_scope_generations prerequisite
                  ON prerequisite.public_id
                       = dependency.depends_on_scope_generation_public_id
                WHERE dependency.scope_generation_public_id = scope.public_id
                  AND prerequisite.state <> 'completed'
              )
          ), claimable AS (
            SELECT scope.public_id, scope.knowledge_base_id,
                   scope.publication_generation_public_id,
                   scope.scope_identity, scope.scope_kind,
                   scope.scope_generation, generation.target_fact_epoch,
                   head.active_fact_epoch
            FROM focowiki.projection_scope_generations scope
            JOIN eligible ON eligible.public_id = scope.public_id
            JOIN focowiki.projection_publication_generations generation
              ON generation.public_id
                   = scope.publication_generation_public_id
             AND generation.state IN (
               'planned', 'rendering', 'validating', 'ready'
             )
            JOIN focowiki.knowledge_base_projection_heads head
              ON head.knowledge_base_id = scope.knowledge_base_id
            ORDER BY eligible.knowledge_base_rank,
                     eligible.last_selected_at NULLS FIRST,
                     eligible.knowledge_base_id COLLATE "C",
                     scope.next_eligible_at, scope.created_at,
                     scope.public_id COLLATE "C"
            FOR UPDATE OF scope SKIP LOCKED
            LIMIT ${assertRepositoryPositiveInteger(input.limit, "limit", 256)}
          )
          UPDATE focowiki.projection_scope_generations scope
          SET state = 'running',
              lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")},
              lease_generation = lease_generation + 1,
              lease_expires_at = ${expiresAt}, heartbeat_at = ${now},
              updated_at = ${now}
          FROM claimable
          WHERE scope.public_id = claimable.public_id
          RETURNING scope.public_id, scope.knowledge_base_id,
                    scope.publication_generation_public_id,
                    scope.scope_identity, scope.scope_kind,
                    scope.scope_generation, claimable.target_fact_epoch,
                    claimable.active_fact_epoch, scope.lease_generation,
                    scope.consecutive_lease_loss_count
        `;
        if (rows.length > 0) {
          const selectedKnowledgeBases = [...new Set(rows.map((row) =>
            row.knowledge_base_id))];
          await transaction`
            UPDATE focowiki.projection_scheduler_credits credit
            SET last_selected_at = ${now}, updated_at = ${now},
                waiting_count = (
                  SELECT count(*)
                  FROM focowiki.projection_scope_generations scope
                  JOIN focowiki.projection_publication_generations generation
                    ON generation.public_id
                         = scope.publication_generation_public_id
                   AND generation.state IN (
                     'planned', 'rendering', 'validating', 'ready'
                   )
                  WHERE scope.knowledge_base_id = credit.knowledge_base_id
                    AND scope.state = 'waiting'
                ),
                oldest_waiting_at = (
                  SELECT min(scope.created_at)
                  FROM focowiki.projection_scope_generations scope
                  JOIN focowiki.projection_publication_generations generation
                    ON generation.public_id
                         = scope.publication_generation_public_id
                   AND generation.state IN (
                     'planned', 'rendering', 'validating', 'ready'
                   )
                  WHERE scope.knowledge_base_id = credit.knowledge_base_id
                    AND scope.state = 'waiting'
                )
            WHERE credit.lane = 'scope'
              AND credit.knowledge_base_id IN ${transaction(selectedKnowledgeBases)}
          `;
        }
        return rows.map((row) => ({
          publicId: row.public_id,
          leaseGeneration: documentLeaseGeneration(
            Number(row.lease_generation)
          ),
          knowledgeBaseId: row.knowledge_base_id,
          publicationGenerationPublicId:
            row.publication_generation_public_id,
          scopeKind: row.scope_kind,
          safeScopeKeyHash: hashIdentity([row.scope_identity]),
          targetFactEpoch: Number(row.target_fact_epoch),
          activeFactEpoch: Number(row.active_fact_epoch),
          scopeGeneration: Number(row.scope_generation),
          leaseLossCount: Number(row.consecutive_lease_loss_count)
        }));
      });
    },

    async fail(input) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const publicId = assertRepositoryIdentity(input.publicId, "public_id");
      const workerId = assertRepositoryIdentity(input.workerId, "worker_id");
      const errorCode = assertSafeErrorCode(input.errorCode);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          publication_generation_public_id: string;
          knowledge_base_id: string;
          scope_identity: string;
          resource_failure_started_at: Date | string | null;
          consecutive_lease_loss_count: number | string;
        }>>`
          SELECT publication_generation_public_id, knowledge_base_id,
                 scope_identity, resource_failure_started_at,
                 consecutive_lease_loss_count
          FROM focowiki.projection_scope_generations
          WHERE public_id = ${publicId}
            AND state = 'running'
            AND lease_owner = ${workerId}
            AND lease_generation = ${input.leaseGeneration}
          FOR UPDATE
        `;
        const scope = rows[0];
        if (!scope) return null;
        if (input.recoveryAction === "inspect_or_reclaim") {
          const nextLossCount = Number(scope.consecutive_lease_loss_count) + 1;
          if (nextLossCount >= 2) {
            await transaction`
              UPDATE focowiki.projection_scope_generations
              SET consecutive_lease_loss_count = 2,
                  progress_evidence = jsonb_build_object(
                    'safeErrorCode', (${errorCode})::text,
                    'recoveryClass', 'lease_loss',
                    'outcome', 'superseded'
                  ), updated_at = ${now}
              WHERE public_id = ${publicId}
            `;
            await recomputeDocumentScopeGeneration(
              transaction as unknown as DatabaseClient,
              {
                generationPublicId: scope.publication_generation_public_id,
                knowledgeBaseId: scope.knowledge_base_id,
                errorCode,
                now
              }
            );
            return "superseded" as const;
          }
          await transaction`
            UPDATE focowiki.projection_scope_generations
            SET state = 'waiting', lease_owner = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL,
                consecutive_lease_loss_count = ${nextLossCount},
                next_eligible_at = ${now}, updated_at = ${now},
                progress_evidence = jsonb_build_object(
                  'safeErrorCode', (${errorCode})::text,
                  'recoveryClass', 'lease_loss',
                  'outcome', 'reclaim'
                )
            WHERE public_id = ${publicId}
          `;
          return "waiting" as const;
        }
        if (input.recoveryAction === "retry_infrastructure") {
          return recoverDocumentScopeGenerationResourceFailure(
            transaction as unknown as DatabaseClient,
            {
              publicId,
              generationPublicId: scope.publication_generation_public_id,
              knowledgeBaseId: scope.knowledge_base_id,
              resourceFailureStartedAt: scope.resource_failure_started_at,
              errorCode,
              now
            }
          );
        }
        if (input.recoveryAction === "recompute_scope") {
          await recomputeDocumentScopeGeneration(
            transaction as unknown as DatabaseClient,
            {
              generationPublicId: scope.publication_generation_public_id,
              knowledgeBaseId: scope.knowledge_base_id,
              errorCode,
              now
            }
          );
          return "superseded" as const;
        }
        if (input.recoveryAction === "quarantine") {
          await transitionFailedDocumentScopeGeneration(
            transaction as unknown as DatabaseClient,
            { publicId, state: "quarantined", errorCode, now }
          );
          await supersedeDocumentScopeGenerationSiblings(
            transaction as unknown as DatabaseClient,
            scope.publication_generation_public_id,
            publicId,
            now
          );
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'quarantined', safe_error_code = ${errorCode},
                updated_at = ${now}
            WHERE public_id = ${scope.publication_generation_public_id}
              AND state IN ('planned', 'rendering', 'validating', 'ready')
          `;
          await transaction`
            INSERT INTO focowiki.projection_invariant_diagnostics (
              public_id, knowledge_base_id, generation_public_id,
              invariant_code, safe_evidence, created_at
            ) VALUES (
              ${`projection-invariant-${hashIdentity([
                scope.publication_generation_public_id,
                scope.scope_identity,
                errorCode
              ])}`}, ${scope.knowledge_base_id},
              ${scope.publication_generation_public_id}, ${errorCode},
              ${transaction.json({
                scopeIdentity: scope.scope_identity,
                leaseGeneration: Number(input.leaseGeneration)
              } as never)}, ${now}
            ) ON CONFLICT (public_id) DO NOTHING
          `;
          return "quarantined" as const;
        }
        if (input.recoveryAction === "terminal") {
          await transitionFailedDocumentScopeGeneration(
            transaction as unknown as DatabaseClient,
            { publicId, state: "error", errorCode, now }
          );
          await supersedeDocumentScopeGenerationSiblings(
            transaction as unknown as DatabaseClient,
            scope.publication_generation_public_id,
            publicId,
            now
          );
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'quarantined', safe_error_code = ${errorCode},
                updated_at = ${now}
            WHERE public_id = ${scope.publication_generation_public_id}
              AND state IN ('planned', 'rendering', 'validating', 'ready')
          `;
          return "error" as const;
        }
        await transitionFailedDocumentScopeGeneration(
          transaction as unknown as DatabaseClient,
          { publicId, state: "waiting", errorCode, now }
        );
        return "waiting" as const;
      });
    },

    async recoverExpired(input) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{
          public_id: string;
          publication_generation_public_id: string;
          knowledge_base_id: string;
          consecutive_lease_loss_count: number | string;
        }>>`
          WITH expired AS (
            SELECT public_id
            FROM focowiki.projection_scope_generations
            WHERE state = 'running' AND lease_expires_at <= ${now}
            ORDER BY lease_expires_at, public_id COLLATE "C"
            FOR UPDATE SKIP LOCKED
            LIMIT ${limit}
          )
          UPDATE focowiki.projection_scope_generations scope
          SET state = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
              heartbeat_at = NULL, next_eligible_at = ${now},
              consecutive_lease_loss_count = least(
                2, consecutive_lease_loss_count + 1
              ),
              progress_evidence = jsonb_build_object(
                'safeErrorCode', 'scope_generation_lease_lost',
                'recoveryClass', 'lease_loss',
                'outcome', CASE WHEN consecutive_lease_loss_count >= 1
                  THEN 'supersede' ELSE 'reclaim' END
              ), updated_at = ${now}
          FROM expired
          WHERE scope.public_id = expired.public_id
          RETURNING scope.public_id,
                    scope.publication_generation_public_id,
                    scope.knowledge_base_id,
                    scope.consecutive_lease_loss_count
        `;
        const generations = new Map(rows.filter((row) =>
          Number(row.consecutive_lease_loss_count) >= 2).map((row) => [
            row.publication_generation_public_id,
            row.knowledge_base_id
          ]));
        for (const [generationPublicId, knowledgeBaseId] of generations) {
          await recomputeDocumentScopeGeneration(
            transaction as unknown as DatabaseClient,
            {
              generationPublicId,
              knowledgeBaseId,
              errorCode: "scope_generation_lease_lost",
              now
            }
          );
        }
        return rows.length;
      }) as Promise<number>;
    },

    async reuseCompletedOutput(input): Promise<boolean> {
      return reuseCompletedDocumentScopeGenerationOutput(sql, input);
    },

    async persistOutput(input): Promise<void> {
      await persistDocumentScopeGenerationOutput(sql, input);
    }
  };
}

function assertSafeErrorCode(value: string): string {
  if (!/^[A-Za-z0-9_]{1,128}$/u.test(value)) {
    throw repositoryContractError("scope_generation_error_code_invalid");
  }
  return value;
}

function assertScopeIdentity(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 2048) {
    throw repositoryContractError("scope_identity_invalid");
  }
  return value;
}

function assertScopeKey(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 4096) {
    throw repositoryContractError("scope_key_invalid");
  }
  return value;
}

function hashIdentity(parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
