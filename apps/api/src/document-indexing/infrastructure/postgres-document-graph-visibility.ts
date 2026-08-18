import type { DatabaseClient } from "../../db/client.js";

export function visibleDocumentGraphEvidence(
  sql: DatabaseClient,
  included: readonly string[],
  excluded: readonly string[]
) {
  return sql`evidence.retired_at IS NULL AND (
    evidence.source_revision_public_id = ANY(${included}::text[])
    OR evidence.target_source_revision_public_id = ANY(${included}::text[])
    OR (evidence.active
      AND evidence.source_file_public_id <> ALL(${excluded}::text[])
      AND evidence.target_source_file_public_id <> ALL(${excluded}::text[]))
  )`;
}

export function visibleDocumentGraphRecord(
  sql: DatabaseClient,
  alias: "first_record" | "second_record" | "source_record",
  included: readonly string[],
  excluded: readonly string[]
) {
  if (alias === "first_record") {
    return sql`first_record.source_revision_public_id = ANY(${included}::text[])
      OR (first_record.active
        AND first_record.source_file_public_id <> ALL(${excluded}::text[]))`;
  }
  if (alias === "second_record") {
    return sql`second_record.source_revision_public_id = ANY(${included}::text[])
      OR (second_record.active
        AND second_record.source_file_public_id <> ALL(${excluded}::text[]))`;
  }
  return sql`source_record.source_revision_public_id = ANY(${included}::text[])
    OR (source_record.active
      AND source_record.source_file_public_id <> ALL(${excluded}::text[]))`;
}

export function visibleDocumentGraphRelation(
  sql: DatabaseClient,
  included: readonly string[],
  excluded: readonly string[]
) {
  return sql`relation.retired_at IS NULL AND (
    relation.first_source_revision_public_id = ANY(${included}::text[])
    OR relation.second_source_revision_public_id = ANY(${included}::text[])
    OR (relation.active
      AND relation.first_source_file_public_id <> ALL(${excluded}::text[])
      AND relation.second_source_file_public_id <> ALL(${excluded}::text[]))
  )`;
}
