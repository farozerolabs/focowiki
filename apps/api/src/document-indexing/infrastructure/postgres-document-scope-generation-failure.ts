import type { DatabaseClient } from "../../db/client.js";

export async function transitionFailedDocumentScopeGeneration(
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
        next_eligible_at = ${input.now},
        resource_failure_started_at = NULL,
        resource_failure_count = 0, updated_at = ${input.now},
        validation_evidence = jsonb_build_object(
          'safeErrorCode', (${input.errorCode})::text
        )
    WHERE public_id = ${input.publicId}
  `;
}

export async function supersedeDocumentScopeGenerationSiblings(
  sql: DatabaseClient,
  generationPublicId: string,
  failedScopePublicId: string,
  now: string
): Promise<void> {
  await sql`
    UPDATE focowiki.projection_scope_generations
    SET state = 'superseded', lease_owner = NULL,
        lease_expires_at = NULL, heartbeat_at = NULL,
        updated_at = ${now}
    WHERE publication_generation_public_id = ${generationPublicId}
      AND public_id <> ${failedScopePublicId}
      AND state IN ('waiting', 'running', 'error')
  `;
}
