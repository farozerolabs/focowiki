import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationJobOutput } from
  "../application/document-publication-job-ports.js";
import {
  assertRepositorySha256,
  repositoryContractError
} from "./document-repository-validation.js";

const MAXIMUM_MANIFEST_METADATA_BYTES = 65_536;
const MAXIMUM_PATH_BYTES = 4_096;

export function validateDocumentPublicationJobOutputs(
  outputs: readonly DocumentPublicationJobOutput[]
): readonly DocumentPublicationJobOutput[] {
  const paths = new Set<string>();
  return [...outputs].sort((left, right) =>
    Buffer.compare(Buffer.from(left.normalizedPath),
      Buffer.from(right.normalizedPath))
  ).map((output) => {
    const normalizedPath = validatePath(output.normalizedPath);
    const logicalPath = validatePath(output.logicalPath);
    if (!normalizedPath || !logicalPath
      || normalizedPath !== normalizedPath.toLocaleLowerCase("en-US")
      || paths.has(normalizedPath)) {
      throw repositoryContractError("publication_output_path_invalid");
    }
    paths.add(normalizedPath);
    assertRepositorySha256(output.producerFingerprintSha256,
      "producer_fingerprint");
    assertJsonSize(output.navigationMutations);
    return { ...output, normalizedPath, logicalPath };
  });
}

export async function enqueuePostgresDocumentPublicationOutputCleanup(input: {
  transaction: DatabaseClient;
  jobPublicId: string;
  retainedObjectIds: readonly string[];
  queuedAt: string;
}): Promise<number> {
  const sql = input.transaction;
  const retainedObjectIds = [...new Set(input.retainedObjectIds)].sort();
  const rows = await sql<Array<{ object_id: string }>>`
    WITH candidates AS (
      SELECT DISTINCT output.object_id
      FROM focowiki.publication_job_outputs output
      WHERE output.job_public_id = ${input.jobPublicId}
        AND output.action = 'put' AND output.object_id IS NOT NULL
        AND NOT (output.object_id = ANY(${retainedObjectIds}::text[]))
        AND NOT EXISTS (
          SELECT 1
          FROM focowiki.publication_job_outputs retained
          JOIN focowiki.publication_jobs retained_job
            ON retained_job.public_id = retained.job_public_id
           AND retained_job.outcome = 'pending'
          WHERE retained.object_id = output.object_id
            AND retained.job_public_id <> ${input.jobPublicId}
        )
    ), marked AS (
      UPDATE focowiki.object_registrations registration
      SET zero_owner_since = coalesce(
            registration.zero_owner_since, ${input.queuedAt}
          )
      FROM candidates
      WHERE registration.object_id = candidates.object_id
        AND registration.state = 'verified'
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.object_owners owner
          WHERE owner.object_id = registration.object_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.source_revisions revision
          WHERE revision.object_id = registration.object_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.generated_page_heads head
          WHERE head.object_id = registration.object_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.upload_entries entry
          WHERE entry.object_id = registration.object_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.embedding_artifacts artifact
          WHERE artifact.object_id = registration.object_id
        )
      RETURNING registration.object_id
    ), inserted AS (
      INSERT INTO focowiki.cleanup_actions (
        public_id, knowledge_base_id, action_kind, cleanup_plane,
        resource_kind, resource_public_id, required, priority,
        sequence_number, idempotency_key, request_hash, checkpoint,
        state, attempt_count, maximum_attempts, not_before,
        created_at, updated_at
      )
      SELECT 'cleanup-publication-job-output-' || md5(
               ${input.jobPublicId} || chr(31) || marked.object_id
             ), job.knowledge_base_id, 'zero_owner_object',
             'object_storage', 'zero_owner_object', marked.object_id,
             true, 40,
             row_number() OVER (ORDER BY marked.object_id COLLATE "C")::integer,
             'publication-job-output:' || marked.object_id,
             md5(marked.object_id),
             jsonb_build_object(
               'schemaVersion', 'publication-job-output-v1'
             ),
             'queued', 0, 8, ${input.queuedAt},
             ${input.queuedAt}, ${input.queuedAt}
      FROM marked
      JOIN focowiki.publication_jobs job
        ON job.public_id = ${input.jobPublicId}
      WHERE NOT EXISTS (
        SELECT 1 FROM focowiki.cleanup_actions existing
        WHERE existing.action_kind = 'zero_owner_object'
          AND existing.resource_public_id = marked.object_id
          AND existing.state IN ('queued', 'running', 'retry')
      )
      ON CONFLICT ON CONSTRAINT cleanup_actions_idempotency_key DO NOTHING
      RETURNING resource_public_id AS object_id
    )
    SELECT object_id FROM inserted ORDER BY object_id COLLATE "C"
  `;
  return rows.length;
}

function validatePath(value: string | null): string | null {
  if (value === null) return null;
  const path = value.normalize("NFC").trim();
  if (!path || Buffer.byteLength(path, "utf8") > MAXIMUM_PATH_BYTES
    || path.startsWith("/") || path.split("/").includes("..")) {
    throw repositoryContractError("publication_path_invalid");
  }
  return path;
}

function assertJsonSize(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (serialized === undefined
    || Buffer.byteLength(serialized, "utf8")
      > MAXIMUM_MANIFEST_METADATA_BYTES) {
    throw repositoryContractError("publication_navigation_mutations_invalid");
  }
}
