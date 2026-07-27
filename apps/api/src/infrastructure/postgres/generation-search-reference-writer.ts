import type { TransactionSql } from "postgres";
import type { ChangeFactKind } from "../../domain/generation.js";

export type GenerationSearchReferenceChange = {
  kind: ChangeFactKind;
  sourceFileId: string | null;
  sourceRevisionId: string | null;
  searchDocumentId: string | null;
  path: string | null;
};

export async function updateGenerationSearchReferences(
  transaction: TransactionSql<Record<string, never>>,
  input: {
    knowledgeBaseId: string;
    generationId: string;
    predecessorGenerationId: string | null;
    inheritPredecessor: boolean;
    changes: GenerationSearchReferenceChange[];
    now: string;
  }
): Promise<void> {
  if (input.inheritPredecessor && input.predecessorGenerationId) {
    await transaction`
      INSERT INTO focowiki.generation_search_projection_refs (
        knowledge_base_id, generation_id, source_file_id, source_revision_id,
        search_document_id, search_schema_version, tokenizer_contract_version,
        segmentation_version,
        logical_path, title, summary, source_url, metadata_json, created_at, updated_at
      )
      SELECT
        reference.knowledge_base_id, ${input.generationId},
        reference.source_file_id, reference.source_revision_id,
        reference.search_document_id, reference.search_schema_version,
        reference.tokenizer_contract_version, reference.segmentation_version,
        reference.logical_path,
        reference.title, reference.summary, reference.source_url,
        reference.metadata_json, ${input.now}, ${input.now}
      FROM focowiki.generation_search_projection_refs reference
      WHERE reference.knowledge_base_id = ${input.knowledgeBaseId}
        AND reference.generation_id = ${input.predecessorGenerationId}
      ON CONFLICT (generation_id, source_file_id) DO NOTHING
    `;
  }

  const deletedSourceFileIds = unique(input.changes.flatMap((change) =>
    change.kind === "source_deleted" && change.sourceFileId
      ? [change.sourceFileId]
      : []
  ));
  if (deletedSourceFileIds.length > 0) {
    await transaction`
      DELETE FROM focowiki.generation_search_projection_refs
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND generation_id = ${input.generationId}
        AND source_file_id = ANY(${deletedSourceFileIds})
    `;
  }

  const upserts = latestSourceChanges(input.changes);
  if (upserts.length === 0) return;
  const rows = await transaction<Array<{ source_file_id: string }>>`
    WITH requested AS (
      SELECT item.*
      FROM jsonb_to_recordset(${transaction.json(upserts as never)}) AS item(
        "sourceFileId" text,
        "sourceRevisionId" text,
        "searchDocumentId" text,
        "path" text
      )
    ), selected AS MATERIALIZED (
      SELECT DISTINCT ON (request."sourceFileId")
             request."sourceFileId" AS source_file_id,
             request."sourceRevisionId" AS source_revision_id,
             document.id AS search_document_id,
             document.search_schema_version,
             document.tokenizer_contract_version,
             document.segmentation_version,
             'pages/' || request."path" AS logical_path,
             coalesce(
               nullif(node.title, ''),
               nullif(revision.metadata_json->>'title', ''),
               source.name
             ) AS title,
             coalesce(
               nullif(node.summary, ''),
               nullif(node.description, ''),
               nullif(revision.metadata_json->>'description', '')
             ) AS summary,
             coalesce(
               nullif(node.metadata_json->>'resource', ''),
               nullif(node.metadata_json->>'sourceUrl', ''),
               nullif(node.metadata_json->>'url', '')
             ) AS source_url,
             coalesce(node.metadata_json, revision.metadata_json, '{}'::jsonb) AS metadata_json
      FROM requested request
      JOIN focowiki.source_files source
        ON source.knowledge_base_id = ${input.knowledgeBaseId}
       AND source.id = request."sourceFileId"
       AND source.deleted_at IS NULL
       AND source.deletion_intent_id IS NULL
      JOIN focowiki.source_revisions revision
        ON revision.knowledge_base_id = source.knowledge_base_id
       AND revision.source_file_id = source.id
       AND revision.id = request."sourceRevisionId"
      JOIN focowiki.search_projection_documents document
        ON document.knowledge_base_id = source.knowledge_base_id
       AND document.source_file_id = source.id
       AND (
         (
           request."searchDocumentId" IS NOT NULL
           AND document.id = request."searchDocumentId"
         )
         OR (
           request."searchDocumentId" IS NULL
           AND document.source_revision_id = revision.id
         )
       )
       AND document.lifecycle_state = 'ready'
      LEFT JOIN focowiki.source_file_graph_nodes node
        ON node.knowledge_base_id = source.knowledge_base_id
       AND node.source_file_id = source.id
      ORDER BY request."sourceFileId", document.completed_at DESC, document.id
    )
    INSERT INTO focowiki.generation_search_projection_refs (
      knowledge_base_id, generation_id, source_file_id, source_revision_id,
      search_document_id, search_schema_version, tokenizer_contract_version,
      segmentation_version,
      logical_path, title, summary, source_url, metadata_json, created_at, updated_at
    )
    SELECT
      ${input.knowledgeBaseId}, ${input.generationId}, selected.source_file_id,
      selected.source_revision_id, selected.search_document_id,
      selected.search_schema_version, selected.tokenizer_contract_version,
      selected.segmentation_version,
      selected.logical_path, selected.title, selected.summary,
      selected.source_url, selected.metadata_json, ${input.now}, ${input.now}
    FROM selected
    ON CONFLICT (generation_id, source_file_id) DO UPDATE
    SET source_revision_id = EXCLUDED.source_revision_id,
        search_document_id = EXCLUDED.search_document_id,
        search_schema_version = EXCLUDED.search_schema_version,
        tokenizer_contract_version = EXCLUDED.tokenizer_contract_version,
        segmentation_version = EXCLUDED.segmentation_version,
        logical_path = EXCLUDED.logical_path,
        title = EXCLUDED.title,
        summary = EXCLUDED.summary,
        source_url = EXCLUDED.source_url,
        metadata_json = EXCLUDED.metadata_json,
        updated_at = EXCLUDED.updated_at
    RETURNING source_file_id
  `;
  if (rows.length !== upserts.length) {
    const legacyPredecessor = input.predecessorGenerationId
      ? await transaction<Array<{ legacy: boolean }>>`
          SELECT (
            search_schema_version IS NULL
            AND tokenizer_contract_version IS NULL
            AND search_segmentation_version IS NULL
          ) AS legacy
          FROM focowiki.publication_generations
          WHERE knowledge_base_id = ${input.knowledgeBaseId}
            AND id = ${input.predecessorGenerationId}
        `
      : [];
    if (input.predecessorGenerationId !== null && legacyPredecessor[0]?.legacy !== true) {
      throw new Error("Ready search projection is unavailable for publication");
    }
  }
}

function latestSourceChanges(changes: GenerationSearchReferenceChange[]): Array<{
  sourceFileId: string;
  sourceRevisionId: string;
  searchDocumentId: string | null;
  path: string;
}> {
  const latest = new Map<string, {
    sourceFileId: string;
    sourceRevisionId: string;
    searchDocumentId: string | null;
    path: string;
  }>();
  for (const change of changes) {
    if (
      change.kind === "source_deleted"
      || !change.sourceFileId
      || !change.sourceRevisionId
      || !change.path
    ) {
      continue;
    }
    latest.set(change.sourceFileId, {
      sourceFileId: change.sourceFileId,
      sourceRevisionId: change.sourceRevisionId,
      searchDocumentId: change.searchDocumentId,
      path: change.path
    });
  }
  return [...latest.values()];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
