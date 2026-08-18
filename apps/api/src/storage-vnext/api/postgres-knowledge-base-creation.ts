import type { DatabaseClient } from "../../db/client.js";
import type { SemanticMaintenanceTarget } from
  "../../semantic/domain/contracts.js";
import { ensurePostgresSemanticContractBootstrap } from
  "../../semantic/infrastructure/postgres-contract-bootstrap.js";
import type { StorageVnextKnowledgeBaseFact } from
  "../catalog/ports.js";
import type { DocumentSearchProjectionBootstrap } from
  "../../document-indexing/domain/document-search-projection.js";

type KnowledgeBaseRow = {
  public_id: string;
  name: string;
  description: string | null;
  revision: number | string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type StorageVnextKnowledgeBaseCreationPort = {
  create(input: {
    publicId: string;
    name: string;
    description: string | null;
  }): Promise<StorageVnextKnowledgeBaseFact>;
};

export function createPostgresKnowledgeBaseCreation(input: {
  sql: DatabaseClient;
  resolveSemanticTarget(
    knowledgeBaseId: string
  ): Promise<SemanticMaintenanceTarget | null>;
  resolveSearchProjection?(
    knowledgeBaseId: string
  ): DocumentSearchProjectionBootstrap;
  clock?: () => string;
}): StorageVnextKnowledgeBaseCreationPort {
  const clock = input.clock ?? (() => new Date().toISOString());
  return {
    async create(request) {
      assertCreationRequest(request);
      const target = await input.resolveSemanticTarget(request.publicId);
      const searchProjection = input.resolveSearchProjection?.(request.publicId) ?? null;
      if (target && target.knowledgeBaseId !== request.publicId) {
        throw creationError("semantic_target_scope_conflict");
      }
      const createdAt = clock();
      assertTimestamp(createdAt);
      return input.sql.begin(async (transaction) => {
        const rows = await transaction<KnowledgeBaseRow[]>`
          INSERT INTO focowiki.knowledge_bases
            (public_id, name, description, revision, created_at, updated_at)
          VALUES (
            ${request.publicId}, ${request.name}, ${request.description}, 1,
            ${createdAt}, ${createdAt}
          )
          RETURNING public_id, name, description, revision,
                    created_at, updated_at, deleted_at
        `;
        const row = rows[0];
        if (!row) throw creationError("knowledge_base_create_conflict");
        await transaction`
          INSERT INTO focowiki.knowledge_base_sequences (
            knowledge_base_id, current_sequence, updated_at
          ) VALUES (${request.publicId}, 0, ${createdAt})
        `;
        if (searchProjection) {
          await transaction`
            INSERT INTO focowiki.search_projections (
              public_id, knowledge_base_id, provider_kind, provider_index_uid,
              schema_checksum_sha256, settings_checksum_sha256,
              active_contract_revision, document_count, state,
              revision, created_at, updated_at
            ) VALUES (
              ${searchProjection.publicId}, ${request.publicId},
              ${searchProjection.providerKind}, ${searchProjection.providerIndexUid},
              ${searchProjection.schemaChecksumSha256},
              ${searchProjection.settingsChecksumSha256},
              1, 0, 'active', 1, ${createdAt}, ${createdAt}
            )
          `;
        }
        if (target) {
          await ensurePostgresSemanticContractBootstrap(transaction, {
            knowledgeBaseId: request.publicId,
            target,
            createdAt
          });
        }
        return mapKnowledgeBase(row);
      });
    }
  };
}

function mapKnowledgeBase(row: KnowledgeBaseRow): StorageVnextKnowledgeBaseFact {
  return {
    publicId: row.public_id,
    name: row.name,
    description: row.description,
    revision: Number(row.revision),
    visibility: row.deleted_at ? "deleted" : "current",
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function assertCreationRequest(input: {
  publicId: string;
  name: string;
  description: string | null;
}): void {
  if (
    !input.publicId || Buffer.byteLength(input.publicId) > 255
    || !input.name || Buffer.byteLength(input.name) > 255
    || (input.description !== null
      && Buffer.byteLength(input.description) > 16_384)
  ) throw creationError("invalid_input");
}

function assertTimestamp(value: string): void {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw creationError("invalid_clock");
  }
}

function creationError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Knowledge-base creation error: ${code}`),
    { code }
  );
}
