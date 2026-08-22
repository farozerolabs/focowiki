import type { DatabaseClient } from "../../db/client.js";
import { repositoryContractError } from
  "./document-repository-validation.js";

type SourceScope = Readonly<{
  kind: string;
  key: string;
}>;

type ChangedDocument = Readonly<{
  sourceFilePublicId: string;
}>;

export async function readRelatedSourceRevisionSnapshots(
  sql: DatabaseClient,
  input: {
    knowledgeBaseId: string;
    scopes: readonly SourceScope[];
    documents: readonly ChangedDocument[];
  }
) {
  const changedSourceFilePublicIds = new Set(input.documents.map(
    (document) => document.sourceFilePublicId
  ));
  const sourceFilePublicIds = [...new Set(input.scopes.flatMap((scope) =>
    scope.kind === "source" && !changedSourceFilePublicIds.has(scope.key)
      ? [scope.key] : []
  ))].sort((left, right) => Buffer.compare(
    Buffer.from(left),
    Buffer.from(right)
  ));
  const rows = sourceFilePublicIds.length === 0 ? [] : await sql<Array<{
    source_file_public_id: string;
    active_source_revision_public_id: string;
    activation_sequence: number | string;
  }>>`
    SELECT source_file_public_id, active_source_revision_public_id,
           activation_sequence
    FROM focowiki.source_file_active_revisions
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id IN ${sql(sourceFilePublicIds)}
      AND active_source_revision_public_id IS NOT NULL
    ORDER BY source_file_public_id COLLATE "C"
  `;
  if (rows.length !== sourceFilePublicIds.length) {
    throw repositoryContractError("publication_source_scope_snapshot_missing");
  }
  return rows.map((row) => ({
    sourceFilePublicId: row.source_file_public_id,
    sourceRevisionPublicId: row.active_source_revision_public_id,
    activationSequence: Number(row.activation_sequence)
  }));
}
