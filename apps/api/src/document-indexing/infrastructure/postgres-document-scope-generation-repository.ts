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

export function createPostgresDocumentScopeGenerationRepository(
  sql: DatabaseClient
): DocumentScopeGenerationRepository {
  return {
    async create(input): Promise<void> {
      const rows = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.projection_scope_generations (
          public_id, publication_generation_public_id, knowledge_base_id,
          scope_identity, scope_kind, scope_key, scope_generation,
          input_snapshot_fingerprint_sha256, created_at, updated_at
        ) VALUES (
          ${assertRepositoryIdentity(input.publicId, "public_id")},
          ${input.publicationGenerationId},
          ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
          ${assertScopeIdentity(input.scopeIdentity)}, ${input.scopeKind},
          ${assertScopeKey(input.scopeKey)}, ${input.scopeGeneration},
          ${assertRepositorySha256(
            input.inputSnapshotFingerprintSha256,
            "input_snapshot_fingerprint"
          )},
          ${assertRepositoryTimestamp(input.createdAt, "created_at")},
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
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.public_id = scope.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE scope.state = 'waiting'
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
        }>>`
          WITH eligible AS (
            SELECT scope.public_id, scope.knowledge_base_id,
                   row_number() OVER (
                     PARTITION BY scope.knowledge_base_id
                     ORDER BY scope.created_at, scope.public_id COLLATE "C"
                   ) AS knowledge_base_rank,
                   credit.last_selected_at
            FROM focowiki.projection_scope_generations scope
            JOIN focowiki.projection_scheduler_credits credit
              ON credit.knowledge_base_id = scope.knowledge_base_id
             AND credit.lane = 'scope'
            JOIN focowiki.knowledge_bases knowledge_base
              ON knowledge_base.public_id = scope.knowledge_base_id
             AND knowledge_base.deleted_at IS NULL
            LEFT JOIN focowiki.projection_cutover_states cutover
              ON cutover.knowledge_base_id = scope.knowledge_base_id
            WHERE scope.state = 'waiting'
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
            JOIN focowiki.knowledge_base_projection_heads head
              ON head.knowledge_base_id = scope.knowledge_base_id
            ORDER BY eligible.knowledge_base_rank,
                     eligible.last_selected_at NULLS FIRST,
                     eligible.knowledge_base_id COLLATE "C",
                     scope.created_at, scope.public_id COLLATE "C"
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
                    claimable.active_fact_epoch, scope.lease_generation
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
                  WHERE scope.knowledge_base_id = credit.knowledge_base_id
                    AND scope.state = 'waiting'
                ),
                oldest_waiting_at = (
                  SELECT min(created_at)
                  FROM focowiki.projection_scope_generations scope
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
          scopeGeneration: Number(row.scope_generation)
        }));
      });
    },

    async heartbeat(input) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const expiresAt = new Date(Date.parse(now)
        + assertRepositoryPositiveInteger(
          input.leaseDurationMs,
          "lease_duration",
          300_000
        )).toISOString();
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.projection_scope_generations
        SET heartbeat_at = ${now}, lease_expires_at = ${expiresAt},
            updated_at = ${now}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(
            input.workerId,
            "worker_id"
          )}
          AND lease_generation = ${input.leaseGeneration}
          AND lease_expires_at > ${now}
        RETURNING public_id
      `;
      return rows.length === 1;
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
        }>>`
          SELECT publication_generation_public_id, knowledge_base_id,
                 scope_identity
          FROM focowiki.projection_scope_generations
          WHERE public_id = ${publicId}
            AND state = 'running'
            AND lease_owner = ${workerId}
            AND lease_generation = ${input.leaseGeneration}
          FOR UPDATE
        `;
        const scope = rows[0];
        if (!scope) return null;
        if (input.recoveryAction === "recompute_scope") {
          await transaction`
            UPDATE focowiki.projection_scope_generations
            SET state = 'superseded', lease_owner = NULL,
                lease_expires_at = NULL, heartbeat_at = NULL,
                updated_at = ${now}
            WHERE publication_generation_public_id
                    = ${scope.publication_generation_public_id}
              AND state IN ('waiting', 'running', 'error')
          `;
          await transaction`
            UPDATE focowiki.projection_fact_epochs epoch
            SET state = 'ready'
            FROM focowiki.projection_generation_documents document
            WHERE document.generation_public_id
                    = ${scope.publication_generation_public_id}
              AND epoch.knowledge_base_id = ${scope.knowledge_base_id}
              AND epoch.mutation_public_id = document.mutation_public_id
              AND epoch.fact_epoch = document.fact_epoch
              AND epoch.state = 'included'
          `;
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'obsolete', safe_error_code = ${errorCode},
                completed_at = ${now}, updated_at = ${now}
            WHERE public_id = ${scope.publication_generation_public_id}
              AND state IN ('planned', 'rendering', 'validating', 'ready')
          `;
          return "superseded" as const;
        }
        if (input.recoveryAction === "quarantine") {
          await transitionFailedScope(transaction as unknown as DatabaseClient, {
            publicId, state: "quarantined", errorCode, now
          });
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
          await transitionFailedScope(transaction as unknown as DatabaseClient, {
            publicId, state: "error", errorCode, now
          });
          await transaction`
            UPDATE focowiki.projection_publication_generations
            SET state = 'quarantined', safe_error_code = ${errorCode},
                updated_at = ${now}
            WHERE public_id = ${scope.publication_generation_public_id}
              AND state IN ('planned', 'rendering', 'validating', 'ready')
          `;
          return "error" as const;
        }
        await transitionFailedScope(transaction as unknown as DatabaseClient, {
          publicId, state: "waiting", errorCode, now
        });
        return "waiting" as const;
      });
    },

    async recoverExpired(input) {
      const now = assertRepositoryTimestamp(input.now, "now");
      const rows = await sql<Array<{ public_id: string }>>`
        WITH expired AS (
          SELECT public_id
          FROM focowiki.projection_scope_generations
          WHERE state = 'running' AND lease_expires_at <= ${now}
          ORDER BY lease_expires_at, public_id COLLATE "C"
          FOR UPDATE SKIP LOCKED
          LIMIT ${assertRepositoryPositiveInteger(input.limit, "limit", 256)}
        )
        UPDATE focowiki.projection_scope_generations scope
        SET state = 'waiting', lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL, updated_at = ${now}
        FROM expired
        WHERE scope.public_id = expired.public_id
        RETURNING scope.public_id
      `;
      return rows.length;
    },

    async persistSnapshotMembers(input): Promise<number> {
      const records = validateMembers(input.members);
      return sql.begin(async (transaction) => {
        const waiting = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.projection_scope_generations
          WHERE public_id = ${assertRepositoryIdentity(
            input.scopeGenerationPublicId,
            "scope_generation_public_id"
          )} AND state = 'waiting'
          FOR UPDATE
        `;
        if (!waiting[0]) {
          throw repositoryContractError("scope_snapshot_not_mutable");
        }
        const rows = await transaction<Array<{ member_public_id: string }>>`
          INSERT INTO focowiki.projection_scope_snapshot_members (
            scope_generation_public_id, member_kind, member_public_id,
            member_version, member_order
          )
          SELECT ${input.scopeGenerationPublicId}, desired.member_kind,
                 desired.member_public_id, desired.member_version,
                 desired.member_order
          FROM jsonb_to_recordset(${transaction.json(records as never)}::jsonb)
            AS desired(
              member_kind text, member_public_id text,
              member_version text, member_order integer
            )
          ON CONFLICT (
            scope_generation_public_id, member_kind, member_public_id
          ) DO UPDATE SET member_version = excluded.member_version
          WHERE projection_scope_snapshot_members.member_version
                  = excluded.member_version
            AND projection_scope_snapshot_members.member_order
                  = excluded.member_order
          RETURNING member_public_id
        `;
        if (rows.length !== records.length) {
          throw repositoryContractError("scope_snapshot_member_conflict");
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

async function transitionFailedScope(
  sql: DatabaseClient,
  input: Readonly<{
    publicId: string;
    state: "waiting" | "error" | "quarantined";
    errorCode: string;
    now: string;
  }>
): Promise<void> {
  await sql`
    UPDATE focowiki.projection_scope_generations
    SET state = ${input.state}, lease_owner = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL,
        updated_at = ${input.now},
        validation_evidence = jsonb_build_object(
          'safeErrorCode', (${input.errorCode})::text
        )
    WHERE public_id = ${input.publicId}
  `;
}

function assertSafeErrorCode(value: string): string {
  if (!/^[A-Za-z0-9_]{1,128}$/u.test(value)) {
    throw repositoryContractError("scope_generation_error_code_invalid");
  }
  return value;
}

function validateMembers(input: readonly {
  kind: string;
  publicId: string;
  version: string;
  order: number;
}[]) {
  if (input.length > 10_000) {
    throw repositoryContractError("scope_snapshot_member_limit");
  }
  const records = input.map((member) => ({
    member_kind: member.kind,
    member_public_id: assertRepositoryIdentity(member.publicId, "member_public_id"),
    member_version: assertRepositoryIdentity(member.version, "member_version"),
    member_order: member.order
  }));
  if (new Set(records.map((item) => item.member_order)).size !== records.length
    || records.some((item) => !Number.isSafeInteger(item.member_order)
      || item.member_order < 0)) {
    throw repositoryContractError("scope_snapshot_member_order_invalid");
  }
  return records;
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
