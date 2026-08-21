import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentArtifactWorkRepository } from
  "../application/document-work-port.js";
import { documentWorkResourceLane } from "../application/document-work-resource-map.js";
import { DOCUMENT_WORK_KINDS } from "../domain/document-work-graph.js";
import { documentFixedWorkPublicId } from "../domain/document-fixed-work-identity.js";
import { completePostgresDocumentWork, updatePostgresDocumentJobSummary } from
  "./postgres-document-work-completion.js";
import { convergePostgresUploadDocumentOperation, failPostgresDocumentOperation }
  from "./postgres-upload-operation-aggregation.js";
import { enqueuePostgresDocumentWebhookEvent } from
  "./postgres-document-webhook-event.js";
import { claimPostgresDocumentArtifactWork } from
  "./postgres-document-work-claim.js";
import { recoverExpiredPostgresDocumentArtifactWork } from
  "./postgres-document-work-recovery.js";
import { completeReadyPostgresProjectionWaiters } from
  "./postgres-projection-waiting-completion.js";
import { releasePostgresDocumentPageCandidates } from
  "./postgres-document-page-candidate-release.js";
import { artifactWorkTransaction as transaction,
  validateArtifactWorkIdentity as validateIdentity,
  validateArtifactWorkPositiveInteger as validatePositiveInteger,
  validateArtifactWorkReceipt as validateReceipt,
  validateArtifactWorkSafeError as validateSafeError,
  validateArtifactWorkSha256 as validateSha256,
  validateArtifactWorkTimestamp as validateTimestamp } from
  "./document-artifact-work-validation.js";

export type PostgresDocumentArtifactWorkRepository =
  DocumentArtifactWorkRepository & {
    completeWithMutation(input:
      Parameters<DocumentArtifactWorkRepository["complete"]>[0] & {
      apply(transaction: DatabaseClient): Promise<void>;
      afterComplete?(transaction: DatabaseClient): Promise<void>;
    }): Promise<boolean>;
    waitForProjectionWithMutation(input: {
      publicId: string;
      workerId: string;
      now: string;
      receipt:
        Parameters<DocumentArtifactWorkRepository["complete"]>[0]["receipt"];
      apply(transaction: DatabaseClient): Promise<void>;
    }): Promise<boolean>;
    completeWaitingProjection(input: { publicId: string; now: string }): Promise<boolean>;
    completeReadyWaitingProjections(input: {
      now: string; limit: number;
      documentJobPublicIds?: readonly string[];
      detectFailures?: boolean;
    }): Promise<number>;
    updateProjectionBacklogLimit(limit: number): void;
  };

export function createPostgresDocumentArtifactWorkRepository(
  sql: DatabaseClient,
  options: { webhookRetentionMilliseconds?: number; projectionBacklogLimit?: number } = {}
): PostgresDocumentArtifactWorkRepository {
  let projectionBacklogLimit = options.projectionBacklogLimit ?? 10_000;
  return {
    async createFixedGraph(input) {
      validateIdentity(input.knowledgeBaseId);
      validateIdentity(input.documentJobPublicId);
      validateIdentity(input.sourceFilePublicId);
      validateIdentity(input.sourceRevisionPublicId);
      validateTimestamp(input.acceptedAt);
      validatePositiveInteger(input.maximumAttempts, "maximum_attempts");
      const rows = DOCUMENT_WORK_KINDS.map((kind) => ({
        public_id: documentFixedWorkPublicId(input.documentJobPublicId, kind),
        work_kind: kind,
        resource_lane: documentWorkResourceLane(kind),
        input_fingerprint_sha256: validateSha256(input.inputFingerprints[kind])
      }));
      await sql`
        INSERT INTO focowiki.document_artifact_work (
          public_id, knowledge_base_id, document_job_public_id,
          source_file_public_id, source_revision_public_id,
          work_kind, resource_lane, input_fingerprint_sha256,
          state, maximum_attempts, next_eligible_at, created_at, updated_at
        )
        SELECT source.public_id, ${input.knowledgeBaseId},
               ${input.documentJobPublicId}, ${input.sourceFilePublicId},
               ${input.sourceRevisionPublicId}, source.work_kind,
               source.resource_lane, source.input_fingerprint_sha256,
               'waiting', ${input.maximumAttempts}, ${input.acceptedAt},
               ${input.acceptedAt}, ${input.acceptedAt}
        FROM jsonb_to_recordset(${sql.json(rows as never)}::jsonb) AS source(
          public_id text, work_kind text, resource_lane text,
          input_fingerprint_sha256 text
        )
        ON CONFLICT (
          knowledge_base_id, source_revision_public_id,
          work_kind, input_fingerprint_sha256
        ) DO NOTHING
      `;
    },

    async claim(input) {
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      validatePositiveInteger(input.limit, "claim_limit");
      validatePositiveInteger(input.leaseDurationMs, "lease_duration", 300_000);
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + input.leaseDurationMs
      ).toISOString();
      return transaction(sql, (tx) => claimPostgresDocumentArtifactWork({
        transaction: tx,
        kind: input.kind,
        resourceLane: input.resourceLane,
        workerId: input.workerId,
        now: input.now,
        limit: input.limit,
        leaseExpiresAt,
        projectionBacklogLimit,
        webhookRetentionMilliseconds: options.webhookRetentionMilliseconds
      }));
    },

    async complete(input) {
      validateIdentity(input.publicId);
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      validateReceipt(input.receipt);
      return transaction(sql, (tx) => completePostgresDocumentWork(tx, input));
    },

    async completeWithMutation(input: Parameters<
      DocumentArtifactWorkRepository["complete"]
    >[0] & {
      apply(transaction: DatabaseClient): Promise<void>;
      afterComplete?(transaction: DatabaseClient): Promise<void>;
    }): Promise<boolean> {
      validateIdentity(input.publicId);
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      validateReceipt(input.receipt);
      return transaction(sql, (tx) => completePostgresDocumentWork(
        tx,
        input,
        () => input.apply(tx as unknown as DatabaseClient),
        input.afterComplete
          ? () => input.afterComplete!(tx as unknown as DatabaseClient)
          : undefined
      ));
    },

    async waitForProjectionWithMutation(input) {
      validateIdentity(input.publicId);
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      return transaction(sql, async (tx) => {
        const rows = await tx<Array<{ document_job_public_id: string }>>`
          SELECT document_job_public_id
          FROM focowiki.document_artifact_work
          WHERE public_id = ${input.publicId}
            AND state = 'running' AND lease_owner = ${input.workerId}
            AND lease_expires_at > ${input.now}
          FOR UPDATE
        `;
        const work = rows[0];
        if (!work) return false;
        await input.apply(tx as unknown as DatabaseClient);
        await tx`
          INSERT INTO focowiki.document_projection_waiting_completions (
            work_public_id, knowledge_base_id, document_job_public_id,
            source_revision_public_id, receipt_key,
            input_fingerprint_sha256, output_fingerprint_sha256,
            receipt, created_at
          )
          SELECT work.public_id, work.knowledge_base_id,
                 work.document_job_public_id, work.source_revision_public_id,
                 ${input.receipt.key}, ${input.receipt.inputFingerprintSha256},
                 ${input.receipt.outputFingerprintSha256},
                 ${tx.json(input.receipt.value as never)}, ${input.now}
          FROM focowiki.document_artifact_work work
          WHERE work.public_id = ${input.publicId}
          ON CONFLICT (work_public_id) DO UPDATE
          SET receipt_key = excluded.receipt_key,
              input_fingerprint_sha256 = excluded.input_fingerprint_sha256,
              output_fingerprint_sha256 = excluded.output_fingerprint_sha256,
              receipt = excluded.receipt,
              created_at = excluded.created_at
        `;
        const updated = await tx<Array<{ public_id: string }>>`
          UPDATE focowiki.document_artifact_work
          SET state = 'waiting_on_projection',
              lease_owner = NULL, lease_expires_at = NULL,
              service_time_milliseconds = service_time_milliseconds
                + greatest(0, floor(extract(epoch FROM (
                  ${input.now}::timestamptz - started_at
                )) * 1000)::bigint),
              ended_at = ${input.now}, updated_at = ${input.now}
          WHERE public_id = ${input.publicId}
            AND state = 'running' AND lease_owner = ${input.workerId}
          RETURNING public_id
        `;
        if (updated.length !== 1) return false;
        await updatePostgresDocumentJobSummary(
          tx,
          work.document_job_public_id,
          input.now
        );
        return true;
      });
    },

    async completeWaitingProjection(input) {
      validateIdentity(input.publicId);
      validateTimestamp(input.now);
      return transaction(sql, async (tx) => {
        const rows = await tx<Array<{
          knowledge_base_id: string;
          document_job_public_id: string;
          source_file_public_id: string;
          source_revision_public_id: string;
          receipt_key: string;
          input_fingerprint_sha256: string;
          output_fingerprint_sha256: string;
          receipt: Record<string, unknown>;
        }>>`
          SELECT work.knowledge_base_id, work.document_job_public_id,
                 work.source_file_public_id, work.source_revision_public_id,
                 pending.receipt_key, pending.input_fingerprint_sha256,
                 pending.output_fingerprint_sha256, pending.receipt
          FROM focowiki.document_artifact_work work
          JOIN focowiki.document_projection_waiting_completions pending
            ON pending.work_public_id = work.public_id
          WHERE work.public_id = ${input.publicId}
            AND work.state = 'waiting_on_projection'
          FOR UPDATE OF work
        `;
        const work = rows[0];
        if (!work) return false;
        const contributions = await tx<Array<{
          total_count: number | string;
          waiting_count: number | string;
        }>>`
          SELECT count(*) AS total_count,
                 count(*) FILTER (WHERE state = 'waiting') AS waiting_count
          FROM focowiki.projection_scope_contributions
          WHERE document_job_public_id = ${work.document_job_public_id}
        `;
        if (Number(contributions[0]?.total_count ?? 0) < 1
          || Number(contributions[0]?.waiting_count ?? 0) > 0) return false;
        await tx`
          INSERT INTO focowiki.document_artifact_receipts (
            public_id, knowledge_base_id, document_job_public_id,
            work_public_id, source_file_public_id, source_revision_public_id,
            receipt_kind, receipt_key, input_fingerprint_sha256,
            output_fingerprint_sha256, receipt, committed_at
          ) VALUES (
            ${`document-receipt-${randomUUID()}`},
            ${work.knowledge_base_id}, ${work.document_job_public_id},
            ${input.publicId}, ${work.source_file_public_id},
            ${work.source_revision_public_id}, 'generated_page',
            ${work.receipt_key}, ${work.input_fingerprint_sha256},
            ${work.output_fingerprint_sha256},
            ${tx.json(work.receipt as never)}, ${input.now}
          )
          ON CONFLICT (
            knowledge_base_id, source_revision_public_id, receipt_kind,
            receipt_key, input_fingerprint_sha256
          ) DO NOTHING
        `;
        const updated = await tx<Array<{ public_id: string }>>`
          UPDATE focowiki.document_artifact_work
          SET state = 'completed', ended_at = ${input.now}, updated_at = ${input.now}
          WHERE public_id = ${input.publicId}
            AND state = 'waiting_on_projection'
          RETURNING public_id
        `;
        if (updated.length !== 1) return false;
        await tx`
          DELETE FROM focowiki.document_projection_waiting_completions
          WHERE work_public_id = ${input.publicId}
        `;
        await updatePostgresDocumentJobSummary(
          tx,
          work.document_job_public_id,
          input.now
        );
        return true;
      });
    },

    async completeReadyWaitingProjections(input) {
      validateTimestamp(input.now);
      validatePositiveInteger(input.limit, "completion_limit", 256);
      return completeReadyPostgresProjectionWaiters({
        sql,
        now: input.now,
        limit: input.limit,
        ...(input.documentJobPublicIds === undefined
          ? {}
          : { documentJobPublicIds: input.documentJobPublicIds }),
        detectFailures: input.detectFailures ?? false,
        ...(options.webhookRetentionMilliseconds === undefined
          ? {}
          : {
              webhookRetentionMilliseconds:
                options.webhookRetentionMilliseconds
            }),
        complete: (publicId) => this.completeWaitingProjection({
          publicId,
          now: input.now
        })
      });
    },

    updateProjectionBacklogLimit(limit) {
      validatePositiveInteger(limit, "projection_backlog_limit", 100_000);
      projectionBacklogLimit = limit;
    },

    async heartbeat(input) {
      validateIdentity(input.publicId);
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      validatePositiveInteger(input.leaseDurationMs, "lease_duration", 300_000);
      const leaseExpiresAt = new Date(
        Date.parse(input.now) + input.leaseDurationMs
      ).toISOString();
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.document_artifact_work
        SET lease_expires_at = ${leaseExpiresAt}, updated_at = ${input.now}
        WHERE public_id = ${input.publicId}
          AND state = 'running' AND lease_owner = ${input.workerId}
          AND lease_expires_at > ${input.now}
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async fail(input) {
      validateIdentity(input.publicId);
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      validateSafeError(input.errorCode, input.safeMessage);
      if (input.nextEligibleAt !== null) validateTimestamp(input.nextEligibleAt);
      return transaction(sql, async (tx) => {
        const rows = await tx<Array<{
          state: "waiting" | "error";
          knowledge_base_id: string;
          document_job_public_id: string;
          operation_public_id: string;
          source_file_public_id: string;
          source_revision_public_id: string;
          work_kind: string;
        }>>`
          UPDATE focowiki.document_artifact_work work
          SET state = CASE
                WHEN ${input.retryable}
                  AND ${input.nextEligibleAt}::timestamptz IS NOT NULL
                  AND work.attempt_count < work.maximum_attempts
                THEN 'waiting' ELSE 'error' END,
              next_eligible_at = coalesce(
                ${input.nextEligibleAt}::timestamptz,
                ${input.now}::timestamptz
              ),
              lease_owner = NULL, lease_expires_at = NULL,
              safe_error_code = ${input.errorCode},
              safe_error_message = ${input.safeMessage},
              retryable = ${input.retryable}, ended_at = ${input.now},
              service_time_milliseconds = service_time_milliseconds
                + greatest(0, floor(extract(epoch FROM (
                  ${input.now}::timestamptz - started_at
                )) * 1000)::bigint),
              updated_at = ${input.now}
          WHERE work.public_id = ${input.publicId}
            AND work.state = 'running' AND work.lease_owner = ${input.workerId}
          RETURNING work.state, work.knowledge_base_id,
                    work.document_job_public_id, work.source_file_public_id,
                    work.source_revision_public_id, work.work_kind,
                    (SELECT job.operation_public_id
                     FROM focowiki.document_processing_jobs job
                     WHERE job.public_id = work.document_job_public_id)
                      AS operation_public_id
        `;
        const work = rows[0];
        if (!work) return null;
        if (work.state === "error") {
          const failedJobs = await tx<Array<{
            revision: number | string;
          }>>`
            UPDATE focowiki.document_processing_jobs
            SET state = 'error', active_work_kinds = '{}'::text[],
                blocking_work_kind = ${work.work_kind},
                safe_error_code = ${input.errorCode},
                safe_error_message = ${input.safeMessage},
                retryable = ${input.retryable}, failure_count = failure_count + 1,
                terminal_at = ${input.now}, revision = revision + 1,
                updated_at = ${input.now}
            WHERE public_id = ${work.document_job_public_id}
              AND state <> 'error'
            RETURNING revision
          `;
          if (options.webhookRetentionMilliseconds !== undefined
            && failedJobs[0]) {
            await enqueuePostgresDocumentWebhookEvent(tx, {
              documentJobPublicId: work.document_job_public_id,
              documentJobRevision: Number(failedJobs[0].revision),
              knowledgeBaseId: work.knowledge_base_id,
              operationPublicId: work.operation_public_id,
              sourceFilePublicId: work.source_file_public_id,
              eventType: "document.error",
              state: "error",
              safeErrorCode: input.errorCode,
              occurredAt: input.now,
              expiresAt: new Date(Date.parse(input.now)
                + options.webhookRetentionMilliseconds).toISOString()
            });
          }
          if (failedJobs[0]) {
            await releasePostgresDocumentPageCandidates({
              transaction: tx as unknown as DatabaseClient,
              knowledgeBaseId: work.knowledge_base_id,
              documentJobPublicId: work.document_job_public_id,
              operationPublicId: work.operation_public_id,
              retainedCandidatePublicIds: [],
              releasedAt: input.now
            });
            await failPostgresDocumentOperation(tx, {
              knowledgeBaseId: work.knowledge_base_id,
              operationPublicId: work.operation_public_id,
              documentJobPublicId: work.document_job_public_id,
              sourceFilePublicId: work.source_file_public_id,
              sourceRevisionPublicId: work.source_revision_public_id,
              errorCode: input.errorCode,
              safeMessage: input.safeMessage,
              completedAt: input.now
            });
            await convergePostgresUploadDocumentOperation(tx, {
              knowledgeBaseId: work.knowledge_base_id,
              operationPublicId: work.operation_public_id,
              completedAt: input.now
            });
          }
          return "error";
        }
        await updatePostgresDocumentJobSummary(
          tx,
          work.document_job_public_id,
          input.now
        );
        return "retrying";
      });
    },

    async defer(input) {
      validateIdentity(input.publicId);
      validateIdentity(input.workerId);
      validateTimestamp(input.now);
      validateTimestamp(input.nextEligibleAt);
      return transaction(sql, async (tx) => {
        const rows = await tx<Array<{ document_job_public_id: string }>>`
          UPDATE focowiki.document_artifact_work
          SET state = 'waiting',
              attempt_count = greatest(attempt_count - 1, 0),
              next_eligible_at = ${input.nextEligibleAt},
              lease_owner = NULL, lease_expires_at = NULL,
              ended_at = NULL, safe_error_code = NULL,
              safe_error_message = NULL, retryable = false,
              updated_at = ${input.now}
          WHERE public_id = ${input.publicId}
            AND state = 'running' AND lease_owner = ${input.workerId}
          RETURNING document_job_public_id
        `;
        const row = rows[0];
        if (!row) return false;
        await tx`
          UPDATE focowiki.document_processing_jobs
          SET total_attempt_count = greatest(total_attempt_count - 1, 0),
              updated_at = ${input.now}
          WHERE public_id = ${row.document_job_public_id}
        `;
        await updatePostgresDocumentJobSummary(
          tx,
          row.document_job_public_id,
          input.now
        );
        return true;
      });
    },

    async recoverExpired(input) {
      validateTimestamp(input.now);
      validateTimestamp(input.retryAt);
      validatePositiveInteger(input.limit, "recovery_limit");
      return transaction(sql, (tx) => recoverExpiredPostgresDocumentArtifactWork({
        transaction: tx,
        now: input.now,
        retryAt: input.retryAt,
        limit: input.limit,
        webhookRetentionMilliseconds: options.webhookRetentionMilliseconds
      }));
    }
  };
}
