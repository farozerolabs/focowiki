import type { DatabaseClient } from "../../db/client.js";
import type { DocumentScopeGenerationRepository } from
  "../application/document-publication-repository-ports.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositoryTimestamp
} from "./document-repository-validation.js";

export function createPostgresDocumentScopeGenerationHeartbeat(
  sql: DatabaseClient
) {
  return {
    async heartbeat(input: Parameters<
      DocumentScopeGenerationRepository["heartbeat"]
    >[0]): Promise<boolean> {
      const now = assertRepositoryTimestamp(input.now, "now");
      const expiresAt = new Date(Date.parse(now)
        + assertRepositoryPositiveInteger(
          input.leaseDurationMs,
          "lease_duration",
          300_000
        )).toISOString();
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.projection_scope_generations
        SET heartbeat_at = ${now}, lease_expires_at = ${expiresAt},
            updated_at = ${now}
        WHERE public_id = ${assertRepositoryIdentity(input.publicId, "public_id")}
          AND state = 'running'
          AND lease_owner = ${assertRepositoryIdentity(
            input.workerId,
            "worker_id"
          )}
          AND lease_generation = ${input.leaseGeneration}
          AND lease_expires_at > ${now}
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}
