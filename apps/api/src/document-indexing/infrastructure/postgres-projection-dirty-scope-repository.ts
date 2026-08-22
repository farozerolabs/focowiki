import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER } from
  "../domain/document-projection-limits.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import { createPostgresProjectionScopeLease } from
  "./postgres-projection-scope-lease.js";

export const PROJECTION_DIRTY_SCOPE_KINDS = [
  "source", "relation", "directory", "graph", "_index", "_graph", "root"
] as const;
export type ProjectionDirtyScopeKind =
  (typeof PROJECTION_DIRTY_SCOPE_KINDS)[number];

type ProjectionDirtyScopeMarkInput = {
  knowledgeBaseId: string;
  kind: ProjectionDirtyScopeKind;
  key: string;
  requiredSequence: number;
  nextEligibleAt: string;
  coalesceMilliseconds?: number;
};

export function mergeDirtyScopeSequence(input: {
  currentRequiredSequence: number;
  currentCompletedSequence: number;
  incomingRequiredSequence: number;
}) {
  const requiredSequence = Math.max(
    input.currentRequiredSequence,
    input.incomingRequiredSequence
  );
  if (![input.currentRequiredSequence, input.currentCompletedSequence,
    input.incomingRequiredSequence].every(Number.isSafeInteger)
    || input.currentRequiredSequence < 1
    || input.incomingRequiredSequence < 1
    || input.currentCompletedSequence < 0
    || input.currentCompletedSequence > requiredSequence) {
    throw repositoryContractError("invalid_dirty_scope_sequence");
  }
  return {
    requiredSequence,
    completedSequence: input.currentCompletedSequence,
    state: input.currentCompletedSequence >= requiredSequence
      ? "completed" as const : "waiting" as const
  };
}

export function createPostgresProjectionDirtyScopeRepository(sql: DatabaseClient) {
  const lease = createPostgresProjectionScopeLease(sql);
  async function markWithSequence(input: ProjectionDirtyScopeMarkInput): Promise<{
    publicId: string;
    requiredSequence: number;
  }> {
      if (!PROJECTION_DIRTY_SCOPE_KINDS.includes(input.kind)) {
        throw repositoryContractError("invalid_scope_kind");
      }
      const key = assertScopeKey(input.key);
      const requiredSequence = assertRepositoryPositiveInteger(
        input.requiredSequence,
        "required_sequence"
      );
      const identity = createHash("sha256").update(JSON.stringify([
        input.knowledgeBaseId, input.kind, key
      ])).digest("hex");
      const nextEligibleAt = assertRepositoryTimestamp(
        input.nextEligibleAt,
        "next_eligible_at"
      );
      const coalesceMilliseconds = input.coalesceMilliseconds ?? 50;
      if (!Number.isSafeInteger(coalesceMilliseconds)
        || coalesceMilliseconds < 25 || coalesceMilliseconds > 100) {
        throw repositoryContractError("invalid_scope_coalesce_window");
      }
      const coalesceUntil = new Date(
        Date.parse(nextEligibleAt) + coalesceMilliseconds
      ).toISOString();
      const rows = await sql<Array<{
        public_id: string;
        required_sequence: number | string;
      }>>`
        INSERT INTO focowiki.projection_dirty_scopes (
          public_id, knowledge_base_id, scope_kind, scope_key,
          required_sequence, completed_sequence, state, next_eligible_at,
          coalesce_until
        ) VALUES (
          ${`dirty-scope-${identity}`},
          ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
          ${input.kind}, ${key}, ${requiredSequence}, 0, 'waiting',
          ${nextEligibleAt}, ${coalesceUntil}
        )
        ON CONFLICT (knowledge_base_id, scope_kind, scope_key) DO UPDATE
        SET required_sequence = greatest(
              projection_dirty_scopes.required_sequence,
              excluded.required_sequence
            ),
            state = CASE
              WHEN projection_dirty_scopes.state = 'running'
                AND projection_dirty_scopes.lease_expires_at > ${nextEligibleAt}
              THEN 'running'
              ELSE 'waiting'
            END,
            next_eligible_at = CASE
              WHEN projection_dirty_scopes.state = 'running'
                AND projection_dirty_scopes.lease_expires_at > ${nextEligibleAt}
              THEN projection_dirty_scopes.next_eligible_at
              ELSE least(projection_dirty_scopes.next_eligible_at,
                         excluded.next_eligible_at)
            END,
            coalesce_until = greatest(
              projection_dirty_scopes.coalesce_until,
              excluded.coalesce_until
            ),
            attempt_count = CASE
              WHEN projection_dirty_scopes.state = 'running'
                AND projection_dirty_scopes.lease_expires_at > ${nextEligibleAt}
              THEN projection_dirty_scopes.attempt_count ELSE 0 END,
            lease_owner = CASE
              WHEN projection_dirty_scopes.state = 'running'
                AND projection_dirty_scopes.lease_expires_at > ${nextEligibleAt}
              THEN projection_dirty_scopes.lease_owner ELSE NULL END,
            lease_expires_at = CASE
              WHEN projection_dirty_scopes.state = 'running'
                AND projection_dirty_scopes.lease_expires_at > ${nextEligibleAt}
              THEN projection_dirty_scopes.lease_expires_at ELSE NULL END,
            heartbeat_at = CASE
              WHEN projection_dirty_scopes.state = 'running'
                AND projection_dirty_scopes.lease_expires_at > ${nextEligibleAt}
              THEN projection_dirty_scopes.heartbeat_at ELSE NULL END,
            safe_error_code = NULL,
            safe_error_message = NULL,
            retryable = false,
            updated_at = ${nextEligibleAt}
        RETURNING public_id, required_sequence
      `;
      return {
        publicId: rows[0]!.public_id,
        requiredSequence: Number(rows[0]!.required_sequence)
      };
  }

  return {
    async mark(input: ProjectionDirtyScopeMarkInput): Promise<string> {
      return (await markWithSequence(input)).publicId;
    },

    markWithSequence,

    async claim(input: {
      workerId: string;
      now: string;
      leaseDurationMs: number;
      limit: number;
    }): Promise<ReadonlyArray<{
      publicId: string;
      knowledgeBaseId: string;
      kind: ProjectionDirtyScopeKind;
      key: string;
      requiredSequence: number;
      renderedSequence: number;
      deterministicEventTime: string;
      leaseGeneration: number;
      leaseExpiresAt: string;
    }>> {
      const now = assertRepositoryTimestamp(input.now, "now");
      const leaseDurationMs = assertRepositoryPositiveInteger(
        input.leaseDurationMs,
        "lease_duration",
        300_000
      );
      const rows = await sql<Array<{
        public_id: string;
        knowledge_base_id: string;
        scope_kind: ProjectionDirtyScopeKind;
        scope_key: string;
        required_sequence: number | string;
        rendered_sequence: number | string;
        deterministic_event_time: Date | string;
        lease_generation: number | string;
        lease_expires_at: Date | string;
      }>>`
        WITH claimable AS (
          SELECT scope.public_id,
                 coalesce(slice.rendered_sequence, scope.required_sequence)
                   AS rendered_sequence,
                 scope.coalesce_until AS deterministic_event_time
          FROM focowiki.projection_dirty_scopes scope
          LEFT JOIN focowiki.projection_cutover_states cutover
            ON cutover.knowledge_base_id = scope.knowledge_base_id
          CROSS JOIN LATERAL (
            SELECT max(covered.required_sequence) AS rendered_sequence
            FROM (
              SELECT contribution.required_sequence
              FROM focowiki.projection_scope_contributions contribution
              WHERE contribution.scope_public_id = scope.public_id
                AND contribution.state = 'waiting'
                AND contribution.required_sequence <= scope.required_sequence
              ORDER BY contribution.required_sequence,
                       contribution.public_id COLLATE "C"
              LIMIT ${MAXIMUM_PROJECTION_SCOPE_CONTRIBUTORS_PER_RENDER}
            ) covered
          ) slice
          WHERE scope.state = 'waiting' AND scope.next_eligible_at <= ${now}
            AND coalesce(cutover.writer_mode, 'legacy')
                  IN ('legacy', 'shadow')
            AND scope.coalesce_until <= ${now}
            AND scope.attempt_count < scope.maximum_attempts
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.projection_scope_outputs output
              JOIN focowiki.projection_scope_receipts receipt
                ON receipt.scope_public_id = output.scope_public_id
               AND receipt.rendered_sequence = output.rendered_sequence
              JOIN focowiki.projection_scope_contributions contribution
                ON contribution.public_id = receipt.contribution_public_id
              JOIN focowiki.document_processing_jobs job
                ON job.knowledge_base_id = contribution.knowledge_base_id
               AND job.public_id = contribution.document_job_public_id
              JOIN focowiki.document_artifact_work projection_work
                ON projection_work.knowledge_base_id = job.knowledge_base_id
               AND projection_work.document_job_public_id = job.public_id
               AND projection_work.work_kind = 'knowledge_projection'
               AND projection_work.state = 'completed'
              WHERE output.scope_public_id = scope.public_id
                AND (
                  jsonb_array_length(output.pages) > 0
                  OR cardinality(output.removed_normalized_paths) > 0
                  OR jsonb_array_length(output.navigation_mutations) > 0
                )
                AND job.state NOT IN (
                  'available', 'error', 'cancelled', 'superseded'
                )
            )
          ORDER BY scope.oldest_waiting_contribution_at NULLS LAST,
                   scope.waiting_contribution_count DESC,
                   scope.next_eligible_at,
                   scope.public_id
          FOR UPDATE OF scope SKIP LOCKED
          LIMIT ${assertRepositoryPositiveInteger(input.limit, "limit", 256)}
        )
        UPDATE focowiki.projection_dirty_scopes scope
        SET state = 'running',
            lease_owner = ${assertRepositoryIdentity(input.workerId, "worker_id")},
            lease_expires_at = ${new Date(Date.parse(now) + leaseDurationMs).toISOString()},
            lease_generation = lease_generation + 1,
            heartbeat_at = ${now},
            attempt_count = attempt_count + 1,
            updated_at = ${now}
        FROM claimable
        WHERE scope.public_id = claimable.public_id
        RETURNING scope.public_id, scope.knowledge_base_id,
                  scope.scope_kind, scope.scope_key, scope.required_sequence,
                  claimable.rendered_sequence,
                  claimable.deterministic_event_time,
                  scope.lease_generation, scope.lease_expires_at
      `;
      return rows.map((row) => ({
        publicId: row.public_id,
        knowledgeBaseId: row.knowledge_base_id,
        kind: row.scope_kind,
        key: row.scope_key,
        requiredSequence: Number(row.required_sequence),
        renderedSequence: Number(row.rendered_sequence),
        deterministicEventTime: new Date(row.deterministic_event_time)
          .toISOString(),
        leaseGeneration: Number(row.lease_generation),
        leaseExpiresAt: new Date(row.lease_expires_at).toISOString()
      }));
    },

    ...lease,

    async cover(input: {
      knowledgeBaseId: string;
      scopes: readonly { kind: ProjectionDirtyScopeKind; key: string }[];
      renderedSequence: number;
      now: string;
    }): Promise<number> {
      const renderedSequence = assertRepositoryPositiveInteger(
        input.renderedSequence,
        "rendered_sequence"
      );
      const unique = [...new Map(input.scopes.map((scope) => {
        if (!PROJECTION_DIRTY_SCOPE_KINDS.includes(scope.kind)) {
          throw repositoryContractError("invalid_scope_kind");
        }
        const key = assertScopeKey(scope.key);
        return [`${scope.kind}\0${key}`, { kind: scope.kind, key }];
      })).values()];
      if (unique.length < 1 || unique.length > 10_000) {
        throw repositoryContractError("invalid_scope_count");
      }
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.projection_dirty_scopes scope
        SET completed_sequence = greatest(
              scope.completed_sequence,
              least(scope.required_sequence, ${renderedSequence})
            ),
            state = CASE
              WHEN greatest(
                scope.completed_sequence,
                least(scope.required_sequence, ${renderedSequence})
              ) >= scope.required_sequence
              THEN 'completed' ELSE 'waiting'
            END,
            attempt_count = 0,
            lease_owner = NULL, lease_expires_at = NULL,
            heartbeat_at = NULL,
            next_eligible_at = ${assertRepositoryTimestamp(input.now, "now")},
            safe_error_code = NULL, safe_error_message = NULL,
            retryable = false,
            updated_at = ${input.now}
        FROM jsonb_to_recordset(${sql.json(unique as never)}::jsonb) AS desired(
          kind text, key text
        )
        WHERE scope.knowledge_base_id = ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")}
          AND scope.scope_kind = desired.kind
          AND scope.scope_key = desired.key
        RETURNING scope.public_id
      `;
      if (rows.length !== unique.length) {
        throw repositoryContractError("dirty_scope_coverage_missing");
      }
      return rows.length;
    },

    async compactTerminalHistory(input: {
      before: string;
      limit: number;
    }): Promise<{ contributions: number; storageMetrics: number }> {
      const before = assertRepositoryTimestamp(input.before, "before");
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 1_000);
      const removedContributions = await sql<Array<{ public_id: string }>>`
        WITH removable AS (
          SELECT contribution.public_id
          FROM focowiki.projection_scope_contributions contribution
          JOIN focowiki.document_processing_jobs job
            ON job.knowledge_base_id = contribution.knowledge_base_id
           AND job.public_id = contribution.document_job_public_id
          LEFT JOIN focowiki.source_file_active_revisions active
            ON active.knowledge_base_id = contribution.knowledge_base_id
           AND active.source_file_public_id = contribution.source_file_public_id
          WHERE contribution.state = 'acknowledged'
            AND contribution.acknowledged_at <= ${before}
            AND job.state IN (
              'available', 'error', 'cancelled', 'superseded', 'deleting'
            )
            AND active.active_source_revision_public_id
              IS DISTINCT FROM contribution.source_revision_public_id
          ORDER BY contribution.acknowledged_at, contribution.public_id
          FOR UPDATE OF contribution SKIP LOCKED
          LIMIT ${limit}
        )
        DELETE FROM focowiki.projection_scope_contributions contribution
        USING removable
        WHERE contribution.public_id = removable.public_id
        RETURNING contribution.public_id
      `;
      const removedMetrics = await sql<Array<{
        scope_public_id: string;
        rendered_sequence: number | string;
      }>>`
        WITH removable AS (
          SELECT metric.scope_public_id, metric.rendered_sequence
          FROM focowiki.projection_scope_storage_metrics metric
          JOIN focowiki.projection_dirty_scopes scope
            ON scope.public_id = metric.scope_public_id
          WHERE metric.created_at <= ${before}
            AND metric.rendered_sequence < scope.completed_sequence
            AND NOT EXISTS (
              SELECT 1
              FROM focowiki.projection_scope_receipts receipt
              WHERE receipt.scope_public_id = metric.scope_public_id
                AND receipt.rendered_sequence = metric.rendered_sequence
            )
          ORDER BY metric.created_at, metric.scope_public_id,
                   metric.rendered_sequence
          FOR UPDATE OF metric SKIP LOCKED
          LIMIT ${limit}
        )
        DELETE FROM focowiki.projection_scope_storage_metrics metric
        USING removable
        WHERE metric.scope_public_id = removable.scope_public_id
          AND metric.rendered_sequence = removable.rendered_sequence
        RETURNING metric.scope_public_id, metric.rendered_sequence
      `;
      return {
        contributions: removedContributions.length,
        storageMetrics: removedMetrics.length
      };
    }
  };
}

function assertScopeKey(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 2_048) {
    throw repositoryContractError("invalid_scope_key");
  }
  return normalized;
}
