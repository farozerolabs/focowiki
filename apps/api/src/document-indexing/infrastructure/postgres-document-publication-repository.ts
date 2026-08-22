import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentProjectionHead,
  DocumentPublicationGeneration,
  DocumentPublicationRepository
} from "../application/document-publication-repository-ports.js";
import {
  documentFactEpoch,
  documentPublicationGenerationId
} from "../domain/document-publication-identifiers.js";
import {
  assertRepositoryIdentity,
  assertRepositoryPositiveInteger,
  assertRepositorySha256,
  assertRepositoryTimestamp,
  repositoryContractError
} from "./document-repository-validation.js";

export function createPostgresDocumentPublicationRepository(
  sql: DatabaseClient
): DocumentPublicationRepository {
  return {
    async allocateFactEpoch(input) {
      return sql.begin((transaction) => allocatePostgresDocumentFactEpoch({
        transaction: transaction as unknown as DatabaseClient,
        ...input
      })) as Promise<ReturnType<typeof documentFactEpoch>>;
    },

    async readHead(knowledgeBaseId): Promise<DocumentProjectionHead> {
      const id = assertRepositoryIdentity(knowledgeBaseId, "knowledge_base_id");
      await sql`
        INSERT INTO focowiki.knowledge_base_projection_heads (knowledge_base_id)
        VALUES (${id}) ON CONFLICT (knowledge_base_id) DO NOTHING
      `;
      const rows = await sql<Array<{
        knowledge_base_id: string;
        active_generation_public_id: string | null;
        active_fact_epoch: number | string;
        head_version: number | string;
      }>>`
        SELECT knowledge_base_id, active_generation_public_id,
               active_fact_epoch, head_version
        FROM focowiki.knowledge_base_projection_heads
        WHERE knowledge_base_id = ${id}
      `;
      const row = rows[0]!;
      return {
        knowledgeBaseId: row.knowledge_base_id,
        activeGenerationId: row.active_generation_public_id
          ? documentPublicationGenerationId(row.active_generation_public_id)
          : null,
        activeFactEpoch: Number(row.active_fact_epoch),
        headVersion: Number(row.head_version)
      };
    },

    async createGeneration(input): Promise<DocumentPublicationGeneration> {
      const rows = await sql<GenerationRow[]>`
        INSERT INTO focowiki.projection_publication_generations (
          public_id, knowledge_base_id, base_generation_public_id,
          target_fact_epoch, renderer_contract_version,
          deterministic_changed_at, input_fingerprint_sha256
        ) VALUES (
          ${input.publicId},
          ${assertRepositoryIdentity(input.knowledgeBaseId, "knowledge_base_id")},
          ${input.baseGenerationId},
          ${assertNonnegativeInteger(input.targetFactEpoch, "target_fact_epoch")},
          ${assertContractVersion(input.rendererContractVersion)},
          ${assertRepositoryTimestamp(
            input.deterministicChangedAt,
            "deterministic_changed_at"
          )},
          ${assertRepositorySha256(
            input.inputFingerprintSha256,
            "input_fingerprint"
          )}
        )
        ON CONFLICT (public_id) DO UPDATE
        SET public_id = excluded.public_id
        WHERE projection_publication_generations.knowledge_base_id
                = excluded.knowledge_base_id
          AND projection_publication_generations.base_generation_public_id
                IS NOT DISTINCT FROM excluded.base_generation_public_id
          AND projection_publication_generations.target_fact_epoch
                = excluded.target_fact_epoch
          AND projection_publication_generations.renderer_contract_version
                = excluded.renderer_contract_version
          AND projection_publication_generations.deterministic_changed_at
                = excluded.deterministic_changed_at
          AND projection_publication_generations.input_fingerprint_sha256
                = excluded.input_fingerprint_sha256
        RETURNING public_id, knowledge_base_id, base_generation_public_id,
                  target_fact_epoch, renderer_contract_version,
                  deterministic_changed_at, state, input_fingerprint_sha256,
                  output_fingerprint_sha256
      `;
      if (!rows[0]) throw repositoryContractError("publication_generation_conflict");
      return mapGeneration(rows[0]);
    },

    async addDocuments(input): Promise<number> {
      const unique = [...new Map(input.documents.map((document) => [
        document.mutationPublicId,
        document
      ])).values()];
      if (unique.length < 1 || unique.length > 256) {
        throw repositoryContractError("publication_generation_document_limit");
      }
      const records = unique.map((document) => ({
        mutation_public_id: assertRepositoryIdentity(
          document.mutationPublicId,
          "mutation_public_id"
        ),
        document_job_public_id: document.documentJobPublicId === null ? null
          : assertRepositoryIdentity(
              document.documentJobPublicId,
              "document_job_public_id"
            ),
        source_file_public_id: assertRepositoryIdentity(
          document.sourceFilePublicId,
          "source_file_public_id"
        ),
        source_revision_public_id: assertRepositoryIdentity(
          document.sourceRevisionPublicId,
          "source_revision_public_id"
        ),
        fact_epoch: document.factEpoch
      }));
      const rows = await sql<Array<{ mutation_public_id: string }>>`
        INSERT INTO focowiki.projection_generation_documents (
          generation_public_id, mutation_public_id, document_job_public_id,
          source_file_public_id,
          source_revision_public_id, fact_epoch
        )
        SELECT ${input.generationId}, desired.mutation_public_id,
               desired.document_job_public_id, desired.source_file_public_id,
               desired.source_revision_public_id, desired.fact_epoch
        FROM jsonb_to_recordset(${sql.json(records as never)}::jsonb) AS desired(
          mutation_public_id text,
          document_job_public_id text,
          source_file_public_id text,
          source_revision_public_id text,
          fact_epoch bigint
        )
        ON CONFLICT (generation_public_id, mutation_public_id) DO UPDATE
        SET document_job_public_id = excluded.document_job_public_id,
            source_file_public_id = excluded.source_file_public_id,
            source_revision_public_id = excluded.source_revision_public_id,
            fact_epoch = excluded.fact_epoch
        WHERE projection_generation_documents.document_job_public_id
                IS NOT DISTINCT FROM excluded.document_job_public_id
          AND projection_generation_documents.source_file_public_id
                = excluded.source_file_public_id
          AND projection_generation_documents.source_revision_public_id
                = excluded.source_revision_public_id
          AND projection_generation_documents.fact_epoch = excluded.fact_epoch
        RETURNING mutation_public_id
      `;
      if (rows.length !== unique.length) {
        throw repositoryContractError("publication_generation_document_conflict");
      }
      return rows.length;
    },

    async listGenerations(input) {
      const limit = assertRepositoryPositiveInteger(input.limit, "limit", 256);
      const rows = await sql<GenerationRow[]>`
        SELECT public_id, knowledge_base_id, base_generation_public_id,
               target_fact_epoch, renderer_contract_version,
               deterministic_changed_at, state, input_fingerprint_sha256,
               output_fingerprint_sha256
        FROM focowiki.projection_publication_generations
        WHERE knowledge_base_id = ${assertRepositoryIdentity(
          input.knowledgeBaseId,
          "knowledge_base_id"
        )}
          ${input.cursor ? sql`
            AND (target_fact_epoch < ${input.cursor.targetFactEpoch}
              OR (target_fact_epoch = ${input.cursor.targetFactEpoch}
                AND public_id COLLATE "C" > ${input.cursor.publicId}))
          ` : sql``}
        ORDER BY target_fact_epoch DESC, public_id COLLATE "C"
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapGeneration);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last ? {
          targetFactEpoch: last.targetFactEpoch,
          publicId: last.publicId
        } : null
      };
    },

    async setRetention(input): Promise<void> {
      if (!input.reason || Buffer.byteLength(input.reason, "utf8") > 255) {
        throw repositoryContractError("generation_retention_reason_invalid");
      }
      await sql`
        INSERT INTO focowiki.projection_generation_retention (
          generation_public_id, retention_state, retain_until,
          reason, updated_at
        ) VALUES (
          ${input.generationId}, ${input.state},
          ${input.retainUntil === null ? null : assertRepositoryTimestamp(
            input.retainUntil,
            "retain_until"
          )},
          ${input.reason},
          ${assertRepositoryTimestamp(input.updatedAt, "updated_at")}
        )
        ON CONFLICT (generation_public_id) DO UPDATE
        SET retention_state = excluded.retention_state,
            retain_until = excluded.retain_until,
            reason = excluded.reason,
            updated_at = excluded.updated_at
      `;
    }
  };
}

export async function allocatePostgresDocumentFactEpoch(input: Readonly<{
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  mutationPublicId: string;
  mutationGroupPublicId?: string;
  sourceFilePublicId: string | null;
  sourceRevisionPublicId: string | null;
  factKind: "create" | "replace" | "move" | "delete" | "repair" | "shadow";
  createdAt: string;
}>): Promise<ReturnType<typeof documentFactEpoch>> {
  const sql = input.transaction;
  const knowledgeBaseId = assertRepositoryIdentity(
    input.knowledgeBaseId,
    "knowledge_base_id"
  );
  await sql`
    INSERT INTO focowiki.knowledge_base_projection_heads (knowledge_base_id)
    VALUES (${knowledgeBaseId}) ON CONFLICT (knowledge_base_id) DO NOTHING
  `;
  await sql`
    SELECT knowledge_base_id
    FROM focowiki.knowledge_base_projection_heads
    WHERE knowledge_base_id = ${knowledgeBaseId}
    FOR UPDATE
  `;
  const mutationPublicId = assertRepositoryIdentity(
    input.mutationPublicId,
    "mutation_public_id"
  );
  const existing = await sql<Array<{ fact_epoch: number | string }>>`
    SELECT fact_epoch FROM focowiki.projection_fact_epochs
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND mutation_public_id = ${mutationPublicId}
  `;
  if (existing[0]) return documentFactEpoch(Number(existing[0].fact_epoch));
  const next = await sql<Array<{ fact_epoch: number | string }>>`
    SELECT coalesce(max(fact_epoch), 0) + 1 AS fact_epoch
    FROM focowiki.projection_fact_epochs
    WHERE knowledge_base_id = ${knowledgeBaseId}
  `;
  const factEpoch = documentFactEpoch(Number(next[0]!.fact_epoch));
  await sql`
    INSERT INTO focowiki.projection_fact_epochs (
      knowledge_base_id, fact_epoch, mutation_public_id,
      mutation_group_public_id,
      source_file_public_id, source_revision_public_id, fact_kind, created_at
    ) VALUES (
      ${knowledgeBaseId}, ${factEpoch}, ${mutationPublicId},
      ${assertRepositoryIdentity(
        input.mutationGroupPublicId ?? mutationPublicId,
        "mutation_group_public_id"
      )},
      ${optionalIdentity(input.sourceFilePublicId, "source_file_public_id")},
      ${optionalIdentity(input.sourceRevisionPublicId, "source_revision_public_id")},
      ${input.factKind},
      ${assertRepositoryTimestamp(input.createdAt, "created_at")}
    )
  `;
  return factEpoch;
}

type GenerationRow = {
  public_id: string;
  knowledge_base_id: string;
  base_generation_public_id: string | null;
  target_fact_epoch: number | string;
  renderer_contract_version: string;
  deterministic_changed_at: Date | string;
  state: DocumentPublicationGeneration["state"];
  input_fingerprint_sha256: string;
  output_fingerprint_sha256: string | null;
};

function mapGeneration(row: GenerationRow): DocumentPublicationGeneration {
  return {
    publicId: documentPublicationGenerationId(row.public_id),
    knowledgeBaseId: row.knowledge_base_id,
    baseGenerationId: row.base_generation_public_id
      ? documentPublicationGenerationId(row.base_generation_public_id) : null,
    targetFactEpoch: Number(row.target_fact_epoch),
    rendererContractVersion: row.renderer_contract_version,
    deterministicChangedAt: new Date(row.deterministic_changed_at).toISOString(),
    state: row.state,
    inputFingerprintSha256: row.input_fingerprint_sha256,
    outputFingerprintSha256: row.output_fingerprint_sha256
  };
}

function optionalIdentity(value: string | null, name: string): string | null {
  return value === null ? null : assertRepositoryIdentity(value, name);
}

function assertNonnegativeInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw repositoryContractError(`${name}_invalid`);
  }
  return value;
}

function assertContractVersion(value: string): string {
  if (!value || Buffer.byteLength(value, "utf8") > 128) {
    throw repositoryContractError("renderer_contract_version_invalid");
  }
  return value;
}
