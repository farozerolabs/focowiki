import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { DatabaseClient } from "../../db/client.js";

export const EMPTY_SHADOW_SHA256 = createHash("sha256")
  .update("")
  .digest("hex");

export type DocumentPublicationShadowPageRow = {
  logical_path: string;
  normalized_path: string;
  entry_kind: string;
  source_file_public_id: string | null;
  source_revision_public_id: string | null;
  object_id: string;
  checksum_sha256: string;
  byte_count: number | string;
};

export async function readDocumentPublicationShadowStartSummary(
  sql: DatabaseClient,
  knowledgeBaseId: string
) {
  const rows = await sql<Array<{
    active_path_count: number | string;
    unfinished_work_count: number | string;
    unverified_object_count: number | string;
    candidate_generation_count: number | string;
    target_fact_epoch: number | string;
  }>>`
    SELECT
      (SELECT count(*) FROM focowiki.generated_page_heads head
       WHERE head.knowledge_base_id = ${knowledgeBaseId}) active_path_count,
      (SELECT count(*) FROM focowiki.document_artifact_work work
       WHERE work.knowledge_base_id = ${knowledgeBaseId}
         AND work.state IN ('waiting', 'running', 'waiting_on_projection'))
        unfinished_work_count,
      (SELECT count(*) FROM focowiki.generated_page_heads head
       LEFT JOIN focowiki.object_registrations object
         ON object.object_id = head.object_id
       WHERE head.knowledge_base_id = ${knowledgeBaseId}
         AND (object.object_id IS NULL OR object.state <> 'verified'))
        unverified_object_count,
      (SELECT count(*)
       FROM focowiki.projection_publication_generations generation
       WHERE generation.knowledge_base_id = ${knowledgeBaseId}
         AND generation.state IN ('planned', 'rendering', 'validating', 'ready'))
        candidate_generation_count,
      (SELECT coalesce(max(fact_epoch), 0)
       FROM focowiki.projection_fact_epochs epoch
       WHERE epoch.knowledge_base_id = ${knowledgeBaseId}) target_fact_epoch
  `;
  return {
    activePathCount: Number(rows[0]!.active_path_count),
    unfinishedWorkCount: Number(rows[0]!.unfinished_work_count),
    unverifiedObjectCount: Number(rows[0]!.unverified_object_count),
    candidateGenerationCount: Number(rows[0]!.candidate_generation_count),
    targetFactEpoch: Number(rows[0]!.target_fact_epoch)
  };
}

export async function backfillNonterminalDocumentPublicationFacts(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  now: string
): Promise<void> {
  await sql`
    WITH base AS (
      SELECT coalesce(max(fact_epoch), 0) maximum_fact_epoch
      FROM focowiki.projection_fact_epochs
      WHERE knowledge_base_id = ${knowledgeBaseId}
    ), pending AS (
      SELECT job.public_id mutation_public_id,
             job.source_file_public_id, job.source_revision_public_id,
             CASE
               WHEN operation.operation_kind IN (
                 'source_file_move', 'source_directory_move'
               ) THEN 'move'
               WHEN operation.operation_kind = 'maintenance' THEN 'repair'
               WHEN operation.operation_kind = 'source_replace'
                 OR active.active_source_revision_public_id IS NOT NULL
                 THEN 'replace'
               ELSE 'create'
             END fact_kind,
             row_number() OVER (
               ORDER BY job.accepted_at, job.public_id COLLATE "C"
             ) fact_offset
      FROM focowiki.document_processing_jobs job
      JOIN focowiki.document_artifact_work work
        ON work.document_job_public_id = job.public_id
       AND work.work_kind = 'knowledge_projection'
       AND work.state = 'waiting_on_projection'
      JOIN focowiki.operations operation
        ON operation.public_id = job.operation_public_id
       AND operation.knowledge_base_id = job.knowledge_base_id
      JOIN focowiki.document_projection_records projection
        ON projection.knowledge_base_id = job.knowledge_base_id
       AND projection.source_file_public_id = job.source_file_public_id
       AND projection.source_revision_public_id = job.source_revision_public_id
      LEFT JOIN focowiki.source_file_active_revisions active
        ON active.knowledge_base_id = job.knowledge_base_id
       AND active.source_file_public_id = job.source_file_public_id
      WHERE job.knowledge_base_id = ${knowledgeBaseId}
        AND job.state = 'processing'
        AND NOT EXISTS (
          SELECT 1 FROM focowiki.projection_fact_epochs epoch
          WHERE epoch.knowledge_base_id = job.knowledge_base_id
            AND epoch.mutation_public_id = job.public_id
        )
    )
    INSERT INTO focowiki.projection_fact_epochs (
      knowledge_base_id, fact_epoch, mutation_public_id,
      mutation_group_public_id, source_file_public_id,
      source_revision_public_id, fact_kind, state, created_at
    )
    SELECT ${knowledgeBaseId}, base.maximum_fact_epoch + pending.fact_offset,
           pending.mutation_public_id, pending.mutation_public_id,
           pending.source_file_public_id, pending.source_revision_public_id,
           pending.fact_kind, 'ready', ${now}
    FROM pending CROSS JOIN base
    ON CONFLICT (knowledge_base_id, mutation_public_id) DO NOTHING
  `;
}

export async function failDocumentPublicationShadow(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    generationPublicId: string;
    now: string;
    code: string;
  }>
) {
  await sql`
    UPDATE focowiki.projection_publication_generations
    SET state = 'quarantined', safe_error_code = ${input.code},
        updated_at = ${input.now}
    WHERE public_id = ${input.generationPublicId}
      AND state IN ('rendering', 'validating', 'ready')
  `;
  await sql`
    UPDATE focowiki.projection_cutover_states
    SET writer_mode = 'legacy', safe_error_code = ${input.code},
        revision = revision + 1, updated_at = ${input.now}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
  `;
}

export function mapDocumentPublicationShadowState(state: Readonly<{
  shadow_generation_public_id: string | null;
  shadow_expected_path_count: number | string | null;
  shadow_processed_path_count: number | string;
  shadow_cursor: string | null;
}>) {
  return {
    generationPublicId: state.shadow_generation_public_id!,
    expectedPathCount: Number(state.shadow_expected_path_count ?? 0),
    processedPathCount: Number(state.shadow_processed_path_count),
    cursor: state.shadow_cursor,
    complete: state.shadow_cursor === null
      && Number(state.shadow_processed_path_count)
        === Number(state.shadow_expected_path_count ?? 0)
  };
}

export function documentPublicationShadowPageIdentity(
  row: DocumentPublicationShadowPageRow
) {
  return [row.normalized_path, row.logical_path, row.entry_kind,
    row.source_file_public_id, row.source_revision_public_id, row.object_id,
    row.checksum_sha256, Number(row.byte_count)];
}

export function documentPublicationShadowOwnedDirectoryPath(
  path: string
): string | null {
  const name = posix.basename(path);
  return name === "index.md"
      || /^index-(?:directory|extension)-leaf-[^/]+\.md$/u.test(name)
    ? posix.dirname(path) === "." ? null : posix.dirname(path)
    : null;
}

export function hashDocumentPublicationShadow(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function safeDocumentPublicationShadowErrorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null && "code" in error
    && typeof error.code === "string" ? error.code : "SHADOW_BUILD_FAILED";
  return code.toLocaleLowerCase("en-US").slice(0, 128);
}

export function documentPublicationShadowError(
  code: string
): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
