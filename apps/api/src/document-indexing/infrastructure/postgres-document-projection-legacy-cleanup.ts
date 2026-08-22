import type { DatabaseClient } from "../../db/client.js";
import { assertRepositoryTimestamp } from
  "./document-repository-validation.js";

export function createPostgresDocumentProjectionLegacyCleanup(
  sql: DatabaseClient
) {
  return {
    async tryCleanup(cleanedAt: string): Promise<boolean> {
      const rows = await sql<Array<{ cleaned: boolean }>>`
        SELECT focowiki.try_cleanup_legacy_projection_schema(
          ${assertRepositoryTimestamp(cleanedAt, "cleaned_at")}::timestamptz
        ) AS cleaned
      `;
      return rows[0]?.cleaned === true;
    }
  };
}
