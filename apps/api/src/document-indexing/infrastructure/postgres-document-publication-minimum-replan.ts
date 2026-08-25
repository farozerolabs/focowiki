import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import { monotonicDocumentPublicationTargetFactEpoch } from
  "../application/document-publication-window.js";
import { createPostgresDocumentPublicationGeneration } from
  "./postgres-document-publication-generation-identity.js";

export async function createMinimumCompatiblePublicationReplacement(
  sql: DatabaseClient,
  input: Readonly<{
    generationPublicId: string;
    rendererContractVersion: string;
    supersessionReason: string;
    recoveredAt: string;
    recoverObsoleteStranded?: boolean;
  }>
): Promise<Readonly<{
  replacementGenerationPublicId: string;
  factCount: number;
  supersededScopeCount: number;
}> | null> {
  const generations = await sql<Array<{
    public_id: string;
    knowledge_base_id: string;
    target_fact_epoch: number | string;
    deterministic_changed_at: Date | string;
    active_generation_public_id: string | null;
    active_fact_epoch: number | string;
    head_version: number | string;
  }>>`
    SELECT generation.public_id, generation.knowledge_base_id,
           generation.target_fact_epoch, generation.deterministic_changed_at,
           head.active_generation_public_id, head.active_fact_epoch,
           head.head_version
    FROM focowiki.projection_publication_generations generation
    JOIN focowiki.knowledge_base_projection_heads head
      ON head.knowledge_base_id = generation.knowledge_base_id
    WHERE generation.public_id = ${input.generationPublicId}
      AND (
        generation.state IN ('planned', 'rendering', 'validating', 'ready')
        OR (
          ${input.recoverObsoleteStranded === true}
          AND generation.state = 'obsolete'
          AND generation.recovery_evidence->>'outcome'
                = 'minimum_replacement_planned'
          AND NOT EXISTS (
            SELECT 1
            FROM focowiki.projection_publication_generations live
            WHERE live.knowledge_base_id = generation.knowledge_base_id
              AND live.state IN ('planned', 'rendering', 'validating', 'ready')
          )
        )
      )
      AND head.active_generation_public_id IS DISTINCT FROM generation.public_id
    FOR UPDATE OF generation, head
  `;
  const generation = generations[0];
  if (!generation) return null;
  const documents = await sql<Array<{
    mutation_public_id: string;
    document_job_public_id: string | null;
    source_file_public_id: string;
    source_revision_public_id: string;
    fact_epoch: number | string;
  }>>`
    SELECT mutation_public_id, document_job_public_id,
           source_file_public_id, source_revision_public_id, fact_epoch
    FROM focowiki.projection_generation_documents
    WHERE generation_public_id = ${generation.public_id}
    ORDER BY fact_epoch, mutation_public_id COLLATE "C"
    FOR UPDATE
  `;
  if (documents.length === 0) {
    throw minimumReplanError("publication_replacement_documents_missing");
  }
  const targetFactEpoch = monotonicDocumentPublicationTargetFactEpoch(
    Number(generation.target_fact_epoch),
    Number(generation.active_fact_epoch)
  );
  const identity = createHash("sha256").update(JSON.stringify({
    supersededGenerationPublicId: generation.public_id,
    knowledgeBaseId: generation.knowledge_base_id,
    base: generation.active_generation_public_id,
    headVersion: Number(generation.head_version),
    targetFactEpoch,
    rendererContractVersion: input.rendererContractVersion,
    documents: documents.map((document) => [
      document.mutation_public_id,
      document.document_job_public_id,
      document.source_revision_public_id,
      Number(document.fact_epoch)
    ])
  })).digest("hex");
  await sql`
    UPDATE focowiki.projection_publication_generations
    SET state = 'obsolete', safe_error_code = ${input.supersessionReason},
        supersession_reason = ${input.supersessionReason},
        completed_at = ${input.recoveredAt}, updated_at = ${input.recoveredAt}
    WHERE public_id = ${generation.public_id}
  `;
  const replacement = await createPostgresDocumentPublicationGeneration(sql, {
    knowledgeBaseId: generation.knowledge_base_id,
    baseGenerationPublicId: generation.active_generation_public_id,
    targetFactEpoch,
    rendererContractVersion: input.rendererContractVersion,
    deterministicChangedAt: new Date(generation.deterministic_changed_at)
      .toISOString(),
    inputFingerprintSha256: identity,
    createdAt: input.recoveredAt,
    recoverySupersedesGenerationPublicId: generation.public_id
  });
  if (!replacement) {
    throw minimumReplanError("publication_replacement_not_created");
  }
  const replacementGenerationPublicId = replacement.generationPublicId;
  await sql`
    INSERT INTO focowiki.projection_generation_documents (
      generation_public_id, mutation_public_id, document_job_public_id,
      source_file_public_id, source_revision_public_id, fact_epoch
    )
    SELECT ${replacementGenerationPublicId}, mutation_public_id,
           document_job_public_id, source_file_public_id,
           source_revision_public_id, fact_epoch
    FROM focowiki.projection_generation_documents
    WHERE generation_public_id = ${generation.public_id}
    ON CONFLICT (generation_public_id, mutation_public_id) DO NOTHING
  `;
  await sql`
    UPDATE focowiki.projection_fact_epochs epoch
    SET state = 'included'
    FROM focowiki.projection_generation_documents document
    WHERE document.generation_public_id = ${generation.public_id}
      AND epoch.knowledge_base_id = ${generation.knowledge_base_id}
      AND epoch.mutation_public_id = document.mutation_public_id
      AND epoch.fact_epoch = document.fact_epoch
      AND epoch.state IN ('ready', 'included')
  `;
  const superseded = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.projection_scope_generations
    SET state = 'superseded', lease_owner = NULL,
        lease_generation = lease_generation + 1,
        lease_expires_at = NULL, heartbeat_at = NULL,
        updated_at = ${input.recoveredAt}
    WHERE publication_generation_public_id = ${generation.public_id}
      AND state IN ('waiting', 'running', 'error', 'quarantined')
    RETURNING public_id
  `;
  await sql`
    UPDATE focowiki.projection_publication_generations
    SET state = 'obsolete', safe_error_code = ${input.supersessionReason},
        supersession_reason = ${input.supersessionReason},
        superseded_by_generation_public_id =
          ${replacementGenerationPublicId},
        recovery_evidence = jsonb_build_object(
          'replacementGenerationPublicId',
            (${replacementGenerationPublicId})::text,
          'replacementRendererContractVersion',
            (${input.rendererContractVersion})::text,
          'outcome', 'minimum_replacement_planned'
        ),
        completed_at = ${input.recoveredAt}, updated_at = ${input.recoveredAt}
    WHERE public_id = ${generation.public_id}
  `;
  await sql`
    INSERT INTO focowiki.projection_generation_retention (
      generation_public_id, retention_state, retain_until, reason, updated_at
    ) VALUES (
      ${generation.public_id}, 'retained',
      ${input.recoveredAt}::timestamptz + interval '7 days',
      'minimum-compatible-replan', ${input.recoveredAt}
    )
    ON CONFLICT (generation_public_id) DO UPDATE
    SET retention_state = 'retained', retain_until = excluded.retain_until,
        reason = excluded.reason, updated_at = excluded.updated_at
  `;
  return {
    replacementGenerationPublicId,
    factCount: documents.length,
    supersededScopeCount: superseded.length
  };
}

function minimumReplanError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication minimum replan error: ${code}`), {
    code
  });
}
