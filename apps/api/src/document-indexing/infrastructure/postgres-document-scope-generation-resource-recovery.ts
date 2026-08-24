import type { DatabaseClient } from "../../db/client.js";
import { DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION } from
  "../application/document-publication-renderer-contract.js";
import { createMinimumCompatiblePublicationReplacement } from
  "./postgres-document-publication-minimum-replan.js";

const RESOURCE_RETRY_DEADLINE_MILLISECONDS = 30 * 60 * 1_000;

export async function recoverDocumentScopeGenerationResourceFailure(
  sql: DatabaseClient,
  input: Readonly<{
    publicId: string;
    generationPublicId: string;
    knowledgeBaseId: string;
    resourceFailureStartedAt: Date | string | null;
    errorCode: string;
    now: string;
  }>
): Promise<"waiting" | "superseded"> {
  const resourceFailureStartedAt = input.resourceFailureStartedAt
    ? new Date(input.resourceFailureStartedAt).toISOString()
    : input.now;
  if (Date.parse(input.now) - Date.parse(resourceFailureStartedAt)
    >= RESOURCE_RETRY_DEADLINE_MILLISECONDS) {
    await recomputeDocumentScopeGeneration(sql, input);
    return "superseded";
  }
  await sql`
    UPDATE focowiki.projection_scope_generations
    SET state = 'waiting', lease_owner = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL,
        resource_failure_started_at = coalesce(
          resource_failure_started_at, ${input.now}
        ),
        resource_failure_count = resource_failure_count + 1,
        next_eligible_at = ${input.now}::timestamptz
          + (
            least(
              30000,
              (1000 * power(
                2,
                least(resource_failure_count, 5)
              ))::integer
            ) * interval '1 millisecond'
          ),
        updated_at = ${input.now},
        validation_evidence = jsonb_build_object(
          'safeErrorCode', (${input.errorCode})::text,
          'recoveryClass', 'database_resource'
        )
    WHERE public_id = ${input.publicId}
  `;
  return "waiting";
}

export async function recomputeDocumentScopeGeneration(
  sql: DatabaseClient,
  input: Readonly<{
    generationPublicId: string;
    knowledgeBaseId: string;
    errorCode: string;
    now: string;
  }>
): Promise<void> {
  await createMinimumCompatiblePublicationReplacement(sql, {
    generationPublicId: input.generationPublicId,
    rendererContractVersion: DOCUMENT_PUBLICATION_RENDERER_CONTRACT_VERSION,
    supersessionReason: input.errorCode,
    recoveredAt: input.now
  });
}
