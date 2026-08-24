import type { DatabaseClient } from "../../db/client.js";

export async function lockVerifiedDocumentObjectRegistrations(
  sql: DatabaseClient,
  objectIds: readonly string[]
): Promise<boolean> {
  if (objectIds.length === 0) return true;
  const registrations = await sql<Array<{
    object_id: string;
    state: string;
  }>>`
    SELECT object_id, state
    FROM focowiki.object_registrations
    WHERE object_id IN ${sql(objectIds)}
    ORDER BY object_id COLLATE "C"
    FOR UPDATE
  `;
  return registrations.length === objectIds.length
    && registrations.every((registration) => registration.state === "verified");
}
