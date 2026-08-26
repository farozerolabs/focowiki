import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationJobOutput } from
  "../application/document-publication-job-ports.js";
import { enqueuePostgresDocumentPublicationOutputCleanup } from
  "./postgres-document-publication-output-cleanup.js";
import { replacePostgresDocumentPublicationNavigationManifest } from
  "./postgres-document-publication-navigation-manifest.js";

const OUTPUT_INSERT_BATCH_SIZE = 500;

export async function replacePostgresDocumentPublicationManifest(input: {
  transaction: DatabaseClient;
  jobPublicId: string;
  outputs: readonly DocumentPublicationJobOutput[];
  persistedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  await enqueuePostgresDocumentPublicationOutputCleanup({
    transaction: sql,
    jobPublicId: input.jobPublicId,
    retainedObjectIds: input.outputs.flatMap((output) =>
      output.objectId ? [output.objectId] : []),
    queuedAt: input.persistedAt
  });
  await sql`
    DELETE FROM focowiki.publication_job_outputs
    WHERE job_public_id = ${input.jobPublicId}
  `;
  await replacePostgresDocumentPublicationNavigationManifest({
    transaction: sql,
    jobPublicId: input.jobPublicId,
    outputs: input.outputs,
    persistedAt: input.persistedAt
  });
  const records = input.outputs.map((output, outputOrder) => ({
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
    navigation_mutations: []
  }));
  for (const batch of batches(records)) await sql`
    INSERT INTO focowiki.publication_job_outputs (
      job_public_id, normalized_path, output_order, action,
      logical_path, entry_kind, source_file_public_id,
      source_revision_public_id, object_id, checksum_sha256,
      byte_count, content_type, producer_fingerprint_sha256,
      navigation_mutations, created_at
    )
    SELECT ${input.jobPublicId}, desired.normalized_path,
           desired.output_order, desired.action, desired.logical_path,
           desired.entry_kind, desired.source_file_public_id,
           desired.source_revision_public_id, desired.object_id,
           desired.checksum_sha256, desired.byte_count,
           desired.content_type, desired.producer_fingerprint_sha256,
           desired.navigation_mutations, ${input.persistedAt}
    FROM jsonb_to_recordset(${sql.json(batch as never)}) desired(
      normalized_path text, output_order integer, action text,
      logical_path text, entry_kind text,
      source_file_public_id text, source_revision_public_id text,
      object_id text, checksum_sha256 text, byte_count bigint,
      content_type text, producer_fingerprint_sha256 text,
      navigation_mutations jsonb
    )
  `;
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += OUTPUT_INSERT_BATCH_SIZE) {
    result.push(values.slice(index, index + OUTPUT_INSERT_BATCH_SIZE));
  }
  return result;
}
