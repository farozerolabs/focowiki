import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationActivationRepository } from
  "../application/document-publication-job-ports.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../application/document-publication-renderer-contract.js";
import { activatePostgresDocumentPublicationPages } from
  "./postgres-document-publication-page-activation.js";
import { activatePostgresDocumentPublicationSources } from
  "./postgres-document-publication-source-activation.js";
import { completePostgresDocumentPublicationWork } from
  "./postgres-document-publication-work-activation.js";

const ACTIVATION_STATEMENT_TIMEOUT_MILLISECONDS = 30_000;

export function createPostgresDocumentPublicationActivation(input: {
  sql: DatabaseClient;
  beforeHeadAdvance?: (input: Readonly<{
    jobPublicId: string;
    knowledgeBaseId: string;
    transaction: DatabaseClient;
  }>) => Promise<void>;
}): DocumentPublicationActivationRepository {
  return {
    activate(request) {
      return activateOnce(input, request);
    }
  };
}

async function activateOnce(
  input: Readonly<{
    sql: DatabaseClient;
    beforeHeadAdvance?: (input: Readonly<{
      jobPublicId: string;
      knowledgeBaseId: string;
      transaction: DatabaseClient;
    }>) => Promise<void>;
  }>,
  request: Readonly<{
    jobPublicId: string;
    attemptToken: string;
    activatedAt?: string;
  }>
) {
  return input.sql.begin(async (rawTransaction) => {
    const sql = rawTransaction as unknown as DatabaseClient;
    await sql`SET LOCAL lock_timeout = '30s'`;
    await sql`
      SELECT set_config(
        'statement_timeout',
        ${String(ACTIVATION_STATEMENT_TIMEOUT_MILLISECONDS)},
        true
      )
    `;
    const activatedAt = request.activatedAt
      ? validatedTimestamp(request.activatedAt)
      : await databaseTimestamp(sql);
    const rows = await sql<Array<{
      knowledge_base_id: string;
      base_active_revision: number | string;
      target_readiness_sequence: number | string;
      renderer_contract_version: string;
      manifest_fingerprint_sha256: string | null;
      manifest_attempt_token: string | null;
      attempt_token: string | null;
      attempt_deadline: Date | string | null;
      outcome: "pending" | "committed" | "failed";
    }>>`
      SELECT knowledge_base_id, base_active_revision,
             target_readiness_sequence, renderer_contract_version,
             manifest_fingerprint_sha256, manifest_attempt_token,
             attempt_token, attempt_deadline, outcome
      FROM focowiki.publication_jobs
      WHERE public_id = ${request.jobPublicId}
      FOR UPDATE
    `;
    const job = rows[0];
    if (!job || job.attempt_token !== request.attemptToken) {
      throw activationError("publication_attempt_fenced");
    }
    if (job.outcome === "committed") {
      return committedResult(sql, request.jobPublicId,
        job.knowledge_base_id);
    }
    if (job.outcome !== "pending"
      || !job.attempt_deadline
      || new Date(job.attempt_deadline).getTime() <= Date.parse(activatedAt)
      || !job.manifest_fingerprint_sha256
      || job.manifest_attempt_token !== request.attemptToken) {
      throw activationError("publication_attempt_not_activatable");
    }
    if (job.renderer_contract_version
      !== DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION) {
      throw activationError("publication_renderer_contract_mismatch");
    }
    const heads = await sql<Array<{
      active_revision: number | string;
    }>>`
      SELECT active_revision
      FROM focowiki.knowledge_base_publication_heads
      WHERE knowledge_base_id = ${job.knowledge_base_id}
      FOR UPDATE
    `;
    const head = heads[0];
    if (!head || Number(head.active_revision)
      !== Number(job.base_active_revision)) {
      throw activationError("publication_active_base_changed");
    }
    await assertManifest(sql, request.jobPublicId, request.attemptToken);
    await assertLiveSearchReceipts(sql, request.jobPublicId);
    await advanceReadinessSequence(sql, {
      knowledgeBaseId: job.knowledge_base_id,
      targetReadinessSequence: Number(job.target_readiness_sequence),
      activatedAt
    });
    const pages = await activatePostgresDocumentPublicationPages({
      transaction: sql,
      jobPublicId: request.jobPublicId,
      knowledgeBaseId: job.knowledge_base_id,
      targetReadinessSequence: Number(job.target_readiness_sequence),
      activatedAt
    });
    await activatePostgresDocumentPublicationSources({
      transaction: sql,
      jobPublicId: request.jobPublicId,
      knowledgeBaseId: job.knowledge_base_id,
      targetReadinessSequence: Number(job.target_readiness_sequence),
      activatedAt
    });
    const documentCount = await completePostgresDocumentPublicationWork({
      transaction: sql,
      jobPublicId: request.jobPublicId,
      knowledgeBaseId: job.knowledge_base_id,
      outputFingerprintSha256: job.manifest_fingerprint_sha256,
      activatedAt
    });
    await input.beforeHeadAdvance?.({
      jobPublicId: request.jobPublicId,
      knowledgeBaseId: job.knowledge_base_id,
      transaction: sql
    });
    const nextRevision = Number(head.active_revision) + 1;
    const advanced = await sql<Array<{ active_revision: number | string }>>`
      UPDATE focowiki.knowledge_base_publication_heads
      SET active_revision = ${nextRevision},
          active_readiness_sequence = ${job.target_readiness_sequence},
          active_job_public_id = ${request.jobPublicId},
          updated_at = ${activatedAt}
      WHERE knowledge_base_id = ${job.knowledge_base_id}
        AND active_revision = ${job.base_active_revision}
      RETURNING active_revision
    `;
    if (!advanced[0]) throw activationError("publication_active_base_changed");
    await sql`
      UPDATE focowiki.publication_items item
      SET outcome = 'committed', terminal_at = ${activatedAt},
          safe_error_code = NULL, updated_at = ${activatedAt}
      FROM focowiki.publication_job_items membership
      WHERE membership.job_public_id = ${request.jobPublicId}
        AND membership.item_public_id = item.public_id
        AND item.outcome = 'pending'
    `;
    const completed = await sql<Array<{ public_id: string }>>`
      UPDATE focowiki.publication_jobs
      SET outcome = 'committed', safe_error_code = NULL,
          completed_at = ${activatedAt}, updated_at = ${activatedAt}
      WHERE public_id = ${request.jobPublicId} AND outcome = 'pending'
        AND attempt_token = ${request.attemptToken}
      RETURNING public_id
    `;
    if (completed.length !== 1) {
      throw activationError("publication_attempt_fenced");
    }
    return {
      knowledgeBaseId: job.knowledge_base_id,
      activeRevision: Number(advanced[0].active_revision),
      documentCount,
      putCount: pages.putCount,
      deleteCount: pages.deleteCount
    };
  });
}

async function assertLiveSearchReceipts(
  sql: DatabaseClient,
  jobPublicId: string
): Promise<void> {
  const invalid = await sql<Array<{ public_id: string }>>`
    SELECT item.public_id
    FROM focowiki.publication_job_items membership
    JOIN focowiki.publication_items item
      ON item.public_id = membership.item_public_id
    LEFT JOIN focowiki.search_family_receipts receipt
      ON receipt.knowledge_base_id = item.knowledge_base_id
     AND receipt.source_file_public_id = item.source_file_public_id
     AND receipt.source_revision_public_id = item.source_revision_public_id
     AND receipt.state = 'acknowledged'
    WHERE membership.job_public_id = ${jobPublicId}
      AND item.operation <> 'delete'
    GROUP BY item.public_id
    HAVING count(DISTINCT receipt.family) <> 5
       OR count(DISTINCT receipt.provider_kind) <> 1
       OR NOT bool_and(receipt.family IN (
            'content_metadata', 'content_segments_vectors',
            'semantic_seed_vectors', 'relation_evidence', 'graph_seed'
          ))
    LIMIT 1
  `;
  if (invalid.length > 0) {
    throw activationError("publication_search_receipts_incomplete");
  }
}

async function assertManifest(
  sql: DatabaseClient,
  jobPublicId: string,
  attemptToken: string
): Promise<void> {
  const rows = await sql<Array<{
    output_count: number | string;
    invalid_object_count: number | string;
    duplicate_path_count: number | string;
  }>>`
    SELECT count(*) AS output_count,
           count(*) FILTER (WHERE output.action = 'put' AND (
             registration.object_id IS NULL OR registration.state <> 'verified'
             OR registration.checksum_sha256 <> output.checksum_sha256
             OR registration.byte_count <> output.byte_count
             OR registration.content_type <> output.content_type
           )) AS invalid_object_count,
           count(*) - count(DISTINCT output.normalized_path)
             AS duplicate_path_count
    FROM focowiki.publication_job_outputs output
    LEFT JOIN focowiki.object_registrations registration
      ON registration.object_id = output.object_id
    WHERE output.job_public_id = ${jobPublicId}
  `;
  const manifest = rows[0];
  if (!manifest || Number(manifest.output_count) === 0
    || Number(manifest.invalid_object_count) !== 0
    || Number(manifest.duplicate_path_count) !== 0) {
    throw activationError("publication_manifest_unverified");
  }
  const jobs = await sql<Array<{ manifest_attempt_token: string | null }>>`
    SELECT manifest_attempt_token FROM focowiki.publication_jobs
    WHERE public_id = ${jobPublicId}
  `;
  if (jobs[0]?.manifest_attempt_token !== attemptToken) {
    throw activationError("publication_manifest_fenced");
  }
}

async function advanceReadinessSequence(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    targetReadinessSequence: number;
    activatedAt: string;
  }>
): Promise<void> {
  await sql`
    INSERT INTO focowiki.knowledge_base_sequences (
      knowledge_base_id, current_sequence, updated_at
    ) VALUES (
      ${input.knowledgeBaseId}, ${input.targetReadinessSequence},
      ${input.activatedAt}
    )
    ON CONFLICT (knowledge_base_id) DO UPDATE
    SET current_sequence = greatest(
          knowledge_base_sequences.current_sequence,
          excluded.current_sequence
        ),
        updated_at = excluded.updated_at
  `;
}

async function committedResult(
  sql: DatabaseClient,
  jobPublicId: string,
  knowledgeBaseId: string
) {
  const rows = await sql<Array<{
    active_revision: number | string;
    document_count: number | string;
    put_count: number | string;
    delete_count: number | string;
  }>>`
    SELECT head.active_revision,
           (SELECT count(DISTINCT item.document_job_public_id)
            FROM focowiki.publication_job_items membership
            JOIN focowiki.publication_items item
              ON item.public_id = membership.item_public_id
            WHERE membership.job_public_id = ${jobPublicId}
              AND item.document_job_public_id IS NOT NULL) AS document_count,
           (SELECT count(*) FROM focowiki.publication_job_outputs output
            WHERE output.job_public_id = ${jobPublicId}
              AND output.action = 'put') AS put_count,
           (SELECT count(*) FROM focowiki.publication_job_outputs output
            WHERE output.job_public_id = ${jobPublicId}
              AND output.action = 'delete') AS delete_count
    FROM focowiki.knowledge_base_publication_heads head
    WHERE head.knowledge_base_id = ${knowledgeBaseId}
  `;
  const row = rows[0];
  if (!row) throw activationError("publication_committed_result_missing");
  return {
    knowledgeBaseId,
    activeRevision: Number(row.active_revision),
    documentCount: Number(row.document_count),
    putCount: Number(row.put_count),
    deleteCount: Number(row.delete_count)
  };
}

function activationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document publication activation error: ${code}`), {
    code
  });
}

async function databaseTimestamp(sql: DatabaseClient): Promise<string> {
  const rows = await sql<Array<{ current_time: Date | string }>>`
    SELECT clock_timestamp() AS current_time
  `;
  const value = rows[0]?.current_time;
  if (!value) throw activationError("database_timestamp_missing");
  return new Date(value).toISOString();
}

function validatedTimestamp(value: string): string {
  if (!Number.isFinite(Date.parse(value))) {
    throw activationError("publication_activation_timestamp_invalid");
  }
  return value;
}
