import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentPublicationJob,
  DocumentPublicationJobRepository
} from "../application/document-publication-job-ports.js";
import { fingerprintDocumentPublicationOutputs } from
  "../application/document-publication-manifest.js";
import { createDocumentPublicationSettingsSnapshot } from
  "../application/document-publication-settings-snapshot.js";
import {
  DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS,
  DOCUMENT_PUBLICATION_ITEM_LIMIT,
  DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS,
  freezeDocumentPublicationMembership,
  publicationRetryDelayMilliseconds
} from "../domain/document-publication-job.js";
import {
  assertRepositoryIdentity,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";
import {
  createPostgresDocumentPublicationItem,
  mapDocumentPublicationItem,
  supersedeOlderPostgresDocumentPublicationItems,
  updatePostgresDocumentPublicationPendingHead,
  type DocumentPublicationItemRow
} from "./postgres-document-publication-item-repository.js";
import {
  enqueuePostgresDocumentPublicationOutputCleanup,
  validateDocumentPublicationJobOutputs
} from "./postgres-document-publication-output-cleanup.js";
import { failPostgresDocumentPublicationJob } from
  "./postgres-document-publication-job-failure.js";
import {
  releasePostgresDocumentPublicationAttempt,
  renewPostgresDocumentPublicationAttempt,
  terminalizeExhaustedPostgresPublicationAttempts
} from "./postgres-document-publication-attempt-lease.js";
const MAXIMUM_SETTINGS_SNAPSHOT_BYTES = 65_536;
type JobRow = {
  public_id: string;
  knowledge_base_id: string;
  base_active_revision: number | string;
  target_readiness_sequence: number | string;
  renderer_contract_version: string;
  settings_snapshot: Readonly<Record<string, unknown>>;
  outcome: DocumentPublicationJob["outcome"];
  attempt_owner: string | null;
  attempt_token: string | null;
  attempt_started_at: Date | string | null;
  attempt_deadline: Date | string | null;
  attempt_count: number | string;
  manifest_fingerprint_sha256: string | null;
  created_at: Date | string;
};
export function createPostgresDocumentPublicationJobRepository(
  sql: DatabaseClient
): DocumentPublicationJobRepository {
  return {
    async createItem(input) {
      return createPostgresDocumentPublicationItem(sql, input);
    },
    async admitOne(input) {
      const rendererContractVersion = assertContractVersion(
        input.rendererContractVersion
      );
      const suppliedSettingsSnapshot = input.settingsSnapshot ?? {};
      const publicId = `publication-job-${randomUUID()}`;
      const admitted = await sql.begin(async (rawTransaction) => {
        const transaction = rawTransaction as unknown as DatabaseClient;
        const now = await repositoryTimestamp(transaction, input.now);
        const candidates = await transaction<Array<{
          knowledge_base_id: string;
        }>>`
          SELECT head.knowledge_base_id
          FROM focowiki.knowledge_base_publication_heads head
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.public_id = head.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          LEFT JOIN focowiki.publication_jobs active_job
            ON active_job.knowledge_base_id = head.knowledge_base_id
           AND active_job.outcome = 'pending'
          WHERE head.pending_item_count > 0
            AND active_job.public_id IS NULL
            AND (
              head.pending_item_count >= ${DOCUMENT_PUBLICATION_ITEM_LIMIT}
              OR head.oldest_pending_at <= ${now}::timestamptz
                   - interval '1 second'
              OR head.latest_pending_at <= ${now}::timestamptz
                   - interval '100 milliseconds'
            )
          ORDER BY head.oldest_pending_at,
                   head.knowledge_base_id COLLATE "C"
          LIMIT 1
          FOR UPDATE OF head SKIP LOCKED
        `;
        const knowledgeBaseId = candidates[0]?.knowledge_base_id;
        if (!knowledgeBaseId) return null;
        const heads = await transaction<Array<{
          active_revision: number | string;
          pending_item_count: number | string;
        }>>`
          SELECT active_revision, pending_item_count
          FROM focowiki.knowledge_base_publication_heads
          WHERE knowledge_base_id = ${knowledgeBaseId}
          FOR UPDATE
        `;
        if (!heads[0]) {
          throw repositoryContractError("publication_head_missing");
        }
        const supersededCount =
          await supersedeOlderPostgresDocumentPublicationItems(
          transaction, knowledgeBaseId, now
        );
        const items = await transaction<DocumentPublicationItemRow[]>`
          SELECT public_id, mutation_public_id, knowledge_base_id,
                 document_job_public_id, source_file_public_id,
                 source_revision_public_id, operation, prior_logical_path,
                 next_logical_path, affected_evidence, readiness_sequence,
                 outcome, created_at
          FROM focowiki.publication_items
          WHERE knowledge_base_id = ${knowledgeBaseId}
            AND outcome = 'pending'
            AND NOT EXISTS (
              SELECT 1 FROM focowiki.publication_job_items membership
              WHERE membership.item_public_id = publication_items.public_id
            )
          ORDER BY readiness_sequence, public_id COLLATE "C"
          LIMIT ${DOCUMENT_PUBLICATION_ITEM_LIMIT}
          FOR UPDATE SKIP LOCKED
        `;
        const frozen = freezeDocumentPublicationMembership(
          items.map(mapDocumentPublicationItem)
        );
        if (frozen.length === 0) return null;
        const settingsSnapshot = createDocumentPublicationSettingsSnapshot({
          supplied: suppliedSettingsSnapshot,
          rendererContractVersion,
          items: frozen
        });
        assertJsonSize(settingsSnapshot, MAXIMUM_SETTINGS_SNAPSHOT_BYTES,
          "publication_settings_snapshot_invalid");
        const targetReadinessSequence = Math.max(...frozen.map(
          (item) => item.readinessSequence
        ));
        await transaction`
          INSERT INTO focowiki.publication_jobs (
            public_id, knowledge_base_id, base_active_revision,
            target_readiness_sequence, renderer_contract_version,
            settings_snapshot, next_eligible_at, created_at, updated_at
          ) VALUES (
            ${publicId}, ${knowledgeBaseId},
            ${Number(heads[0].active_revision)}, ${targetReadinessSequence},
            ${rendererContractVersion}, ${transaction.json(
              settingsSnapshot as never
            )}, ${now}, ${now}, ${now}
          )
        `;
        const memberships = frozen.map((item, membershipOrder) => ({
          item_public_id: item.publicId,
          membership_order: membershipOrder
        }));
        await transaction`
          INSERT INTO focowiki.publication_job_items (
            job_public_id, item_public_id, membership_order, created_at
          )
          SELECT ${publicId}, desired.item_public_id,
                 desired.membership_order, ${now}
          FROM jsonb_to_recordset(${transaction.json(memberships as never)})
            AS desired(item_public_id text, membership_order integer)
        `;
        const remainingCount = Math.max(0,
          Number(heads[0].pending_item_count)
            - supersededCount - frozen.length);
        await updatePostgresDocumentPublicationPendingHead({
          transaction,
          knowledgeBaseId,
          remainingCount,
          updatedAt: now
        });
        return publicId;
      });
      return admitted ? readJob(sql, admitted) : null;
    },

    readJob(publicId) {
      return readJob(sql, assertRepositoryIdentity(publicId, "job_public_id"));
    },

    async readNonterminalJob(knowledgeBaseId) {
      const rows = await sql<Array<{ public_id: string }>>`
        SELECT public_id FROM focowiki.publication_jobs
        WHERE knowledge_base_id = ${assertRepositoryIdentity(
          knowledgeBaseId, "knowledge_base_id"
        )} AND outcome = 'pending'
        LIMIT 1
      `;
      return rows[0] ? readJob(sql, rows[0].public_id) : null;
    },
    async claimOne(input) {
      const workerId = assertRepositoryIdentity(input.workerId, "worker_id");
      const attemptToken = `publication-attempt-${randomUUID()}`;
      const claimed = await sql.begin(async (rawTransaction) => {
        const transaction = rawTransaction as unknown as DatabaseClient;
        const now = await repositoryTimestamp(transaction, input.now);
        const deadline = new Date(Date.parse(now)
          + DOCUMENT_PUBLICATION_ATTEMPT_MILLISECONDS).toISOString();
        await terminalizeExhaustedPostgresPublicationAttempts(transaction, now);
        const rows = await transaction<Array<{ public_id: string }>>`
          SELECT job.public_id
          FROM focowiki.publication_jobs job
          JOIN focowiki.knowledge_bases knowledge_base
            ON knowledge_base.public_id = job.knowledge_base_id
           AND knowledge_base.deleted_at IS NULL
          WHERE job.outcome = 'pending'
            AND job.attempt_count < ${DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS}
            AND job.next_eligible_at <= ${now}
            AND (job.attempt_token IS NULL OR job.attempt_deadline <= ${now})
          ORDER BY job.next_eligible_at, job.created_at,
                   job.knowledge_base_id COLLATE "C", job.public_id COLLATE "C"
          LIMIT 1
          FOR UPDATE OF job SKIP LOCKED
        `;
        if (!rows[0]) return null;
        const updated = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.publication_jobs
          SET attempt_owner = ${workerId}, attempt_token = ${attemptToken},
              attempt_started_at = ${now}, attempt_deadline = ${deadline},
              attempt_count = attempt_count + 1,
              manifest_fingerprint_sha256 = NULL,
              manifest_attempt_token = NULL,
              safe_error_code = NULL, updated_at = ${now}
          WHERE public_id = ${rows[0].public_id} AND outcome = 'pending'
          RETURNING public_id
        `;
        return updated[0]?.public_id ?? null;
      });
      return claimed ? readJob(sql, claimed) : null;
    },
    async renewAttempt(input) {
      const jobPublicId = assertRepositoryIdentity(
        input.jobPublicId, "job_public_id"
      );
      const attemptToken = assertRepositoryIdentity(
        input.attemptToken, "attempt_token"
      );
      return renewPostgresDocumentPublicationAttempt({
        sql,
        jobPublicId,
        attemptToken,
        renewedAt: await repositoryTimestamp(sql, input.renewedAt)
      });
    },
    async releaseAttempt(input) {
      const jobPublicId = assertRepositoryIdentity(
        input.jobPublicId, "job_public_id"
      );
      const attemptToken = assertRepositoryIdentity(
        input.attemptToken, "attempt_token"
      );
      return releasePostgresDocumentPublicationAttempt({
        sql,
        jobPublicId,
        attemptToken,
        releasedAt: await repositoryTimestamp(sql, input.releasedAt)
      });
    },
    async persistManifest(input) {
      const jobPublicId = assertRepositoryIdentity(
        input.jobPublicId, "job_public_id"
      );
      const attemptToken = assertRepositoryIdentity(
        input.attemptToken, "attempt_token"
      );
      const fingerprint = assertRepositorySha256(
        input.fingerprintSha256, "manifest_fingerprint"
      );
      const outputs = validateDocumentPublicationJobOutputs(input.outputs);
      if (fingerprintDocumentPublicationOutputs(outputs) !== fingerprint) {
        throw repositoryContractError("publication_manifest_fingerprint_invalid");
      }
      return sql.begin(async (rawTransaction) => {
        const transaction = rawTransaction as unknown as DatabaseClient;
        const persistedAt = await repositoryTimestamp(
          transaction, input.persistedAt
        );
        const jobs = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.publication_jobs
          WHERE public_id = ${jobPublicId} AND outcome = 'pending'
            AND attempt_token = ${attemptToken}
            AND attempt_deadline > ${persistedAt}
          FOR UPDATE
        `;
        if (!jobs[0]) return false;
        await enqueuePostgresDocumentPublicationOutputCleanup({
          transaction,
          jobPublicId,
          retainedObjectIds: outputs.flatMap((output) =>
            output.objectId ? [output.objectId] : []),
          queuedAt: persistedAt
        });
        await transaction`
          DELETE FROM focowiki.publication_job_outputs
          WHERE job_public_id = ${jobPublicId}
        `;
        if (outputs.length > 0) {
          const records = outputs.map((output, outputOrder) => ({
            normalized_path: output.normalizedPath,
            output_order: outputOrder,
            action: output.action,
            logical_path: output.logicalPath,
            entry_kind: output.entryKind,
            source_file_public_id: output.sourceFilePublicId,
            source_revision_public_id: output.sourceRevisionPublicId,
            object_id: output.objectId,
            checksum_sha256: output.checksumSha256,
            byte_count: output.byteCount,
            content_type: output.contentType,
            producer_fingerprint_sha256: output.producerFingerprintSha256,
            navigation_mutations: output.navigationMutations
          }));
          await transaction`
            INSERT INTO focowiki.publication_job_outputs (
              job_public_id, normalized_path, output_order, action,
              logical_path, entry_kind, source_file_public_id,
              source_revision_public_id, object_id, checksum_sha256,
              byte_count, content_type, producer_fingerprint_sha256,
              navigation_mutations, created_at
            )
            SELECT ${jobPublicId}, desired.normalized_path,
                   desired.output_order, desired.action, desired.logical_path,
                   desired.entry_kind, desired.source_file_public_id,
                   desired.source_revision_public_id, desired.object_id,
                   desired.checksum_sha256, desired.byte_count,
                   desired.content_type, desired.producer_fingerprint_sha256,
                   desired.navigation_mutations, ${persistedAt}
            FROM jsonb_to_recordset(${transaction.json(records as never)})
              AS desired(
                normalized_path text, output_order integer, action text,
                logical_path text, entry_kind text,
                source_file_public_id text, source_revision_public_id text,
                object_id text, checksum_sha256 text, byte_count bigint,
                content_type text, producer_fingerprint_sha256 text,
                navigation_mutations jsonb
              )
          `;
        }
        const updated = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.publication_jobs
          SET manifest_fingerprint_sha256 = ${fingerprint},
              manifest_attempt_token = ${attemptToken}, updated_at = ${persistedAt}
          WHERE public_id = ${jobPublicId} AND outcome = 'pending'
            AND attempt_token = ${attemptToken}
            AND attempt_deadline > ${persistedAt}
          RETURNING public_id
        `;
        return updated.length === 1;
      });
    },

    async failAttempt(input) {
      const jobPublicId = assertRepositoryIdentity(
        input.jobPublicId, "job_public_id"
      );
      const attemptToken = assertRepositoryIdentity(
        input.attemptToken, "attempt_token"
      );
      const errorCode = assertRepositoryIdentity(input.errorCode, "error_code");
      return sql.begin(async (rawTransaction) => {
        const transaction = rawTransaction as unknown as DatabaseClient;
        const failedAt = await repositoryTimestamp(transaction, input.failedAt);
        const rows = await transaction<Array<{ attempt_count: number | string }>>`
          SELECT attempt_count FROM focowiki.publication_jobs
          WHERE public_id = ${jobPublicId} AND outcome = 'pending'
            AND attempt_token = ${attemptToken}
            AND attempt_deadline > ${failedAt}
          FOR UPDATE
        `;
        const attemptCount = rows[0] ? Number(rows[0].attempt_count) : null;
        if (attemptCount === null) return "fenced" as const;
        if (input.retryable
          && attemptCount < DOCUMENT_PUBLICATION_MAXIMUM_ATTEMPTS) {
          const retryAt = new Date(Date.parse(failedAt)
            + publicationRetryDelayMilliseconds(attemptCount)).toISOString();
          await transaction`
            UPDATE focowiki.publication_jobs
            SET attempt_owner = NULL, attempt_token = NULL,
                attempt_started_at = NULL, attempt_deadline = NULL,
                manifest_fingerprint_sha256 = NULL,
                manifest_attempt_token = NULL,
                next_eligible_at = ${retryAt}, safe_error_code = ${errorCode},
                updated_at = ${failedAt}
            WHERE public_id = ${jobPublicId} AND outcome = 'pending'
              AND attempt_token = ${attemptToken}
          `;
          return "retrying" as const;
        }
        await failPostgresDocumentPublicationJob({
          transaction,
          jobPublicId,
          errorCode,
          failedAt
        });
        return "failed" as const;
      });
    }
  };
}

async function readJob(
  sql: DatabaseClient,
  publicId: string
): Promise<DocumentPublicationJob | null> {
  const jobs = await sql<JobRow[]>`
    SELECT public_id, knowledge_base_id, base_active_revision,
           target_readiness_sequence, renderer_contract_version,
           settings_snapshot, outcome, attempt_owner, attempt_token,
           attempt_started_at, attempt_deadline, attempt_count,
           manifest_fingerprint_sha256, created_at
    FROM focowiki.publication_jobs
    WHERE public_id = ${publicId}
  `;
  const job = jobs[0];
  if (!job) return null;
  const items = await sql<DocumentPublicationItemRow[]>`
    SELECT item.public_id, item.mutation_public_id, item.knowledge_base_id,
           item.document_job_public_id, item.source_file_public_id,
           item.source_revision_public_id, item.operation,
           item.prior_logical_path, item.next_logical_path,
           item.affected_evidence, item.readiness_sequence,
           item.outcome, item.created_at
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    WHERE membership.job_public_id = ${publicId}
    ORDER BY membership.membership_order
  `;
  return {
    publicId: job.public_id,
    knowledgeBaseId: job.knowledge_base_id,
    baseActiveRevision: Number(job.base_active_revision),
    targetReadinessSequence: Number(job.target_readiness_sequence),
    rendererContractVersion: job.renderer_contract_version,
    settingsSnapshot: job.settings_snapshot,
    outcome: job.outcome,
    attemptOwner: job.attempt_owner,
    attemptToken: job.attempt_token,
    attemptStartedAt: timestamp(job.attempt_started_at),
    attemptDeadline: timestamp(job.attempt_deadline),
    attemptCount: Number(job.attempt_count),
    manifestFingerprintSha256: job.manifest_fingerprint_sha256,
    deterministicEventTime: timestamp(job.created_at)!,
    items: Object.freeze(items.map(mapDocumentPublicationItem))
  };
}

function assertContractVersion(value: string): string {
  const result = assertRepositoryIdentity(value, "renderer_contract_version");
  if (Buffer.byteLength(result, "utf8") > 128) {
    throw repositoryContractError("invalid_renderer_contract_version");
  }
  return result;
}

function assertJsonSize(
  value: unknown,
  maximumBytes: number,
  code: string
): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined
    || Buffer.byteLength(serialized, "utf8") > maximumBytes) {
    throw repositoryContractError(code);
  }
}

function timestamp(value: Date | string | null): string | null {
  if (value === null) return null;
  return new Date(value).toISOString();
}

async function repositoryTimestamp(
  sql: DatabaseClient,
  override?: string
): Promise<string> {
  if (override !== undefined) {
    return assertRepositoryTimestamp(override, "repository_timestamp");
  }
  const rows = await sql<Array<{ current_time: Date | string }>>`
    SELECT clock_timestamp() AS current_time
  `;
  const value = rows[0]?.current_time;
  if (!value) throw repositoryContractError("database_timestamp_missing");
  return new Date(value).toISOString();
}
