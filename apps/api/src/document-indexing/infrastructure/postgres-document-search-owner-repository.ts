import type { DatabaseClient } from "../../db/client.js";
import type { SearchProviderKind } from
  "../../application/ports/search-provider-runtime.js";

export function createPostgresDocumentSearchOwnerRepository(sql: DatabaseClient) {
  return {
    async stageAcknowledged(input: {
      knowledgeBaseId: string;
      sourceFilePublicId: string;
      sourceRevisionPublicId: string;
      searchProjectionPublicId: string;
      providerKind: SearchProviderKind;
      acknowledgementPublicId: string;
      documents: readonly {
        providerDocumentId: string;
        documentKind: "file" | "segment" | "graph_seed" | "file_relationship";
        checksumSha256: string;
      }[];
      stagedAt: string;
    }): Promise<number> {
      validateInput(input);
      if (input.documents.length === 0) return 0;
      await sql`
        INSERT INTO focowiki.search_document_owners (
          knowledge_base_id, search_projection_public_id, provider_kind,
          provider_document_id, document_kind, source_file_public_id,
          source_revision_public_id, document_checksum_sha256,
          state, acknowledged_at, created_at, updated_at
        )
        SELECT ${input.knowledgeBaseId}, ${input.searchProjectionPublicId},
               ${input.providerKind}, item.provider_document_id,
               item.document_kind, ${input.sourceFilePublicId},
               ${input.sourceRevisionPublicId}, item.checksum_sha256,
               'staged', ${input.stagedAt}, ${input.stagedAt}, ${input.stagedAt}
        FROM jsonb_to_recordset(${sql.json(input.documents.map((document) => ({
          provider_document_id: document.providerDocumentId,
          document_kind: document.documentKind,
          checksum_sha256: document.checksumSha256
        })) as never)}) AS item(
          provider_document_id text, document_kind text, checksum_sha256 text
        )
        ON CONFLICT (
          knowledge_base_id, provider_kind, provider_document_id,
          source_revision_public_id
        ) DO UPDATE
        SET search_projection_public_id = EXCLUDED.search_projection_public_id,
            document_kind = EXCLUDED.document_kind,
            document_checksum_sha256 = EXCLUDED.document_checksum_sha256,
            state = CASE
              WHEN focowiki.search_document_owners.state = 'active'
                AND focowiki.search_document_owners.document_kind
                  = EXCLUDED.document_kind
                AND focowiki.search_document_owners.document_checksum_sha256
                  = EXCLUDED.document_checksum_sha256
              THEN 'active'
              ELSE 'staged'
            END,
            acknowledged_at = EXCLUDED.acknowledged_at,
            updated_at = EXCLUDED.updated_at
      `;
      const rows = await sql<Array<{
        provider_document_id: string;
        document_kind: string;
        document_checksum_sha256: string;
        state: string;
      }>>`
        SELECT provider_document_id, document_kind,
               document_checksum_sha256, state
        FROM focowiki.search_document_owners
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND provider_kind = ${input.providerKind}
          AND source_revision_public_id = ${input.sourceRevisionPublicId}
          AND provider_document_id IN ${sql(input.documents.map(
            (document) => document.providerDocumentId
          ))}
        ORDER BY provider_document_id COLLATE "C"
      `;
      const expected = [...input.documents].sort((left, right) =>
        left.providerDocumentId.localeCompare(right.providerDocumentId, "en"));
      if (rows.length !== expected.length || rows.some((row, index) =>
        row.provider_document_id !== expected[index]!.providerDocumentId
        || row.document_kind !== expected[index]!.documentKind
        || row.document_checksum_sha256 !== expected[index]!.checksumSha256
        || !["active", "staged"].includes(row.state))) {
        throw ownerRepositoryError("acknowledged_owner_conflict");
      }
      return rows.length;
    }
  };
}

export async function activateDocumentSearchOwners(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  activatedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  await sql`
    UPDATE focowiki.search_document_owners
    SET state = 'obsolete', updated_at = ${input.activatedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND document_kind <> 'file_relationship'
      AND state = 'active'
      AND EXISTS (
        SELECT 1 FROM focowiki.search_document_owners staged
        WHERE staged.knowledge_base_id = ${input.knowledgeBaseId}
          AND staged.source_file_public_id = ${input.sourceFilePublicId}
          AND staged.source_revision_public_id = ${input.sourceRevisionPublicId}
          AND staged.document_kind <> 'file_relationship'
          AND staged.state = 'staged'
      )
  `;
  await sql`
    UPDATE focowiki.search_document_owners
    SET state = 'active', updated_at = ${input.activatedAt}
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND source_file_public_id = ${input.sourceFilePublicId}
      AND source_revision_public_id = ${input.sourceRevisionPublicId}
      AND document_kind <> 'file_relationship'
      AND state = 'staged'
  `;
}

export async function activateDocumentRelationshipSearchOwners(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  affectedSourceFilePublicIds: readonly string[];
  providerDocumentIds: readonly string[];
  activatedAt: string;
}): Promise<void> {
  const sql = input.transaction;
  const sourceFilePublicIds = [...new Set(input.affectedSourceFilePublicIds)];
  if (sourceFilePublicIds.length > 0) {
    await sql`
      UPDATE focowiki.search_document_owners owner
      SET state = 'obsolete', updated_at = ${input.activatedAt}
      WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
        AND owner.source_file_public_id IN ${sql(sourceFilePublicIds)}
        AND owner.document_kind = 'file_relationship'
        AND owner.state = 'active'
    `;
    if (input.providerDocumentIds.length > 0) {
      await sql`
        UPDATE focowiki.search_document_owners owner
        SET state = 'active', updated_at = ${input.activatedAt}
        FROM focowiki.source_file_active_revisions active
        WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
          AND owner.source_file_public_id IN ${sql(sourceFilePublicIds)}
          AND owner.provider_document_id IN ${sql(input.providerDocumentIds)}
          AND owner.document_kind = 'file_relationship'
          AND owner.state IN ('staged', 'obsolete')
          AND active.knowledge_base_id = owner.knowledge_base_id
          AND active.source_file_public_id = owner.source_file_public_id
          AND active.active_source_revision_public_id
            = owner.source_revision_public_id
      `;
    }
    await sql`
      UPDATE focowiki.search_document_owners owner
      SET state = 'obsolete', updated_at = ${input.activatedAt}
      WHERE owner.knowledge_base_id = ${input.knowledgeBaseId}
        AND owner.source_file_public_id IN ${sql(sourceFilePublicIds)}
        AND owner.document_kind = 'file_relationship'
        AND owner.state = 'staged'
    `;
  }
  await sql`
    UPDATE focowiki.search_projections projection
    SET document_count = (
          SELECT count(*)
          FROM focowiki.search_document_owners owner
          WHERE owner.knowledge_base_id = projection.knowledge_base_id
            AND owner.search_projection_public_id = projection.public_id
            AND owner.state = 'active'
        ),
        revision = projection.revision + 1,
        updated_at = ${input.activatedAt}
    WHERE projection.knowledge_base_id = ${input.knowledgeBaseId}
      AND projection.state = 'active'
      AND projection.document_count IS DISTINCT FROM (
        SELECT count(*)
        FROM focowiki.search_document_owners owner
        WHERE owner.knowledge_base_id = projection.knowledge_base_id
          AND owner.search_projection_public_id = projection.public_id
          AND owner.state = 'active'
      )
  `;
}

function validateInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  searchProjectionPublicId: string;
  providerKind: string;
  acknowledgementPublicId: string;
  documents: readonly {
    providerDocumentId: string;
    documentKind: string;
    checksumSha256: string;
  }[];
  stagedAt: string;
}): void {
  if ([input.knowledgeBaseId, input.sourceFilePublicId,
    input.sourceRevisionPublicId, input.searchProjectionPublicId,
    input.acknowledgementPublicId].some((value) => !value
      || Buffer.byteLength(value, "utf8") > 255)
    || !["opensearch", "meilisearch"].includes(input.providerKind)
    || !Number.isFinite(Date.parse(input.stagedAt))
    || input.documents.length > 10_000
    || new Set(input.documents.map((item) => item.providerDocumentId)).size
      !== input.documents.length
    || input.documents.some((item) => !item.providerDocumentId
      || !["file", "segment", "graph_seed", "file_relationship"]
        .includes(item.documentKind)
      || !/^[0-9a-f]{64}$/u.test(item.checksumSha256))) {
    throw ownerRepositoryError("invalid_input");
  }
}

function ownerRepositoryError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document search owner error: ${code}`), { code });
}
