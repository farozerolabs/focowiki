import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { EmbeddingConfigurationPrivate } from
  "../embedding/configuration.js";
import type {
  EmbeddingConfigurationRepository,
  EmbeddingRevisionWrite
} from "../embedding/repository.js";

type ConfigurationRow = {
  configuration_public_id: string;
  display_name: string;
  lifecycle_status: "draft" | "active" | "paused";
  configuration_revision: number | string;
  revision_public_id: string;
  revision_number: number | string;
  authentication_mode: "api_key" | "none";
  base_url: string;
  encrypted_api_key: Buffer | null;
  model_name: string;
  requested_dimension: number | null;
  resolved_dimension: number | null;
  normalization: "none" | "l2";
  maximum_input_tokens: number;
  batch_size: number;
  timeout_ms: number;
  retry_count: number;
  minimum_interval_ms: number;
  concurrency: number;
  maximum_response_bytes: number;
  minimum_vector_relevance: number;
  vector_producing_revision_public_id: string;
  validation_status: "not_tested" | "valid" | "invalid";
  validation_fingerprint_sha256: string | null;
  safe_validation_error_code: string | null;
  created_at: Date | string;
};

export class EmbeddingConfigurationRepositoryError extends Error {
  public constructor(public readonly code: "conflict" | "missing" | "revision_conflict") {
    super(`Embedding configuration repository error: ${code}`);
    this.name = "EmbeddingConfigurationRepositoryError";
  }
}

export function createPostgresEmbeddingConfigurationRepository(
  sql: DatabaseClient
): EmbeddingConfigurationRepository {
  return {
    async create(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.embedding_configurations (
            public_id, display_name, lifecycle_status, revision,
            created_at, updated_at
          ) VALUES (
            ${input.configurationPublicId}, ${input.displayName}, 'draft', 1,
            ${input.createdAt}, ${input.createdAt}
          )
        `;
        await insertRevision(transaction, input, 1);
        await transaction`
          UPDATE focowiki.embedding_configurations
          SET active_revision_public_id = ${input.revisionPublicId}
          WHERE public_id = ${input.configurationPublicId}
        `;
        return requireConfiguration(transaction, input.configurationPublicId);
      }).catch(mapDatabaseError);
    },

    async createRevision(input) {
      return sql.begin(async (transaction) => {
        const rows = await transaction<Array<{ revision: number | string }>>`
          SELECT revision
          FROM focowiki.embedding_configurations
          WHERE public_id = ${input.configurationPublicId}
            AND deleted_at IS NULL
          FOR UPDATE
        `;
        if (!rows[0]) throw repositoryError("missing");
        if (Number(rows[0].revision) !== input.expectedConfigurationRevision) {
          throw repositoryError("revision_conflict");
        }
        const nextRevision = input.expectedConfigurationRevision + 1;
        await insertRevision(transaction, input, nextRevision);
        const updated = await transaction`
          UPDATE focowiki.embedding_configurations
          SET display_name = ${input.displayName},
              active_revision_public_id = ${input.revisionPublicId},
              lifecycle_status = 'draft', revision = ${nextRevision},
              updated_at = ${input.createdAt}
          WHERE public_id = ${input.configurationPublicId}
            AND revision = ${input.expectedConfigurationRevision}
        `;
        if (updated.count !== 1) throw repositoryError("revision_conflict");
        return requireConfiguration(transaction, input.configurationPublicId);
      }).catch(mapDatabaseError);
    },

    async get(configurationPublicId) {
      return readConfiguration(sql, configurationPublicId);
    },

    async getRevision(revisionPublicId) {
      const rows = await readRevisionRows(sql, revisionPublicId);
      return rows[0] ? mapConfiguration(rows[0]) : null;
    },

    async list() {
      const rows = await readConfigurationRows(sql, null);
      return rows.map(mapConfiguration);
    },

    async recordValidation(input) {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.embedding_configuration_revisions revision
        SET resolved_dimension = ${input.resolvedDimension},
            validation_status = ${input.status},
            validation_fingerprint_sha256 = ${input.validationFingerprintSha256},
            safe_validation_error_code = ${input.safeValidationErrorCode},
            validated_at = ${input.validatedAt}
        FROM focowiki.embedding_configurations configuration
        WHERE configuration.public_id = ${input.configurationPublicId}
          AND configuration.active_revision_public_id = revision.public_id
          AND revision.public_id = ${input.revisionPublicId}
          AND configuration.deleted_at IS NULL
        RETURNING revision.public_id
      `;
      if (!rows[0]) throw repositoryError("revision_conflict");
      return requireConfiguration(sql, input.configurationPublicId);
    },

    async setLifecycle(input) {
      return sql.begin(async (transaction) => {
        if (input.status === "active") {
          const current = await requireConfiguration(
            transaction,
            input.configurationPublicId
          );
          if (current.validationStatus !== "valid") throw repositoryError("conflict");
          await transaction`
            UPDATE focowiki.embedding_configurations
            SET lifecycle_status = 'paused', revision = revision + 1,
                updated_at = now()
            WHERE lifecycle_status = 'active'
              AND public_id <> ${input.configurationPublicId}
              AND deleted_at IS NULL
          `;
        }
        const rows = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.embedding_configurations
          SET lifecycle_status = ${input.status}, revision = revision + 1,
              updated_at = now()
          WHERE public_id = ${input.configurationPublicId}
            AND revision = ${input.expectedConfigurationRevision}
            AND deleted_at IS NULL
          RETURNING public_id
        `;
        if (!rows[0]) throw repositoryError("revision_conflict");
        return requireConfiguration(transaction, input.configurationPublicId);
      }).catch(mapDatabaseError);
    },

    async delete(input) {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.embedding_configurations
        SET deleted_at = ${input.deletedAt}, lifecycle_status = 'paused',
            revision = revision + 1, updated_at = ${input.deletedAt}
        WHERE public_id = ${input.configurationPublicId}
          AND revision = ${input.expectedConfigurationRevision}
          AND deleted_at IS NULL
        RETURNING public_id
      `;
      return rows.length === 1;
    },

    async countReferences(configurationPublicId) {
      const rows = await sql<Array<{ reference_count: number | string }>>`
        SELECT count(*) AS reference_count
        FROM (
          SELECT contract.public_id
          FROM focowiki.semantic_projection_contracts contract
          JOIN focowiki.embedding_configuration_revisions revision
            ON revision.public_id
              = contract.embedding_configuration_revision_public_id
          WHERE revision.configuration_public_id = ${configurationPublicId}
          UNION ALL
          SELECT work.public_id
          FROM focowiki.semantic_stage_work_items work
          JOIN focowiki.embedding_configuration_revisions revision
            ON revision.public_id
              = work.embedding_configuration_revision_public_id
          WHERE revision.configuration_public_id = ${configurationPublicId}
            AND work.state IN ('queued', 'running', 'retry')
        ) reference
      `;
      return Number(rows[0]?.reference_count ?? 0);
    }
  };
}

async function insertRevision(
  sql: TransactionSql,
  input: EmbeddingRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
    reuseValidationFromRevisionPublicId?: string | null;
  },
  revisionNumber: number
): Promise<void> {
  const reused = "reuseValidationFromRevisionPublicId" in input
    && input.reuseValidationFromRevisionPublicId
    ? (await sql<Array<{
        resolved_dimension: number | null;
        validation_status: "not_tested" | "valid" | "invalid";
        validation_fingerprint_sha256: string | null;
        safe_validation_error_code: string | null;
        validated_at: Date | string | null;
      }>>`
        SELECT resolved_dimension, validation_status,
               validation_fingerprint_sha256, safe_validation_error_code,
               validated_at
        FROM focowiki.embedding_configuration_revisions
        WHERE public_id = ${input.reuseValidationFromRevisionPublicId}
          AND configuration_public_id = ${input.configurationPublicId}
        LIMIT 1
      `)[0]
    : null;
  if ("reuseValidationFromRevisionPublicId" in input
    && input.reuseValidationFromRevisionPublicId && !reused) {
    throw repositoryError("missing");
  }
  await sql`
    INSERT INTO focowiki.embedding_configuration_revisions (
      public_id, configuration_public_id, revision_number,
      authentication_mode, base_url, encrypted_api_key, model_name,
      requested_dimension, normalization, maximum_input_tokens, batch_size,
      timeout_ms, retry_count, minimum_interval_ms, concurrency,
      maximum_response_bytes, minimum_vector_relevance,
      vector_producing_revision_public_id, resolved_dimension,
      validation_status, validation_fingerprint_sha256,
      safe_validation_error_code, validated_at, created_at
    ) VALUES (
      ${input.revisionPublicId}, ${input.configurationPublicId},
      ${revisionNumber}, ${input.authenticationMode}, ${input.baseUrl},
      ${input.encryptedApiKey === null
        ? null
        : Buffer.from(input.encryptedApiKey, "utf8")},
      ${input.modelName}, ${input.requestedDimension}, ${input.normalization},
      ${input.maximumInputTokens}, ${input.batchSize}, ${input.timeoutMs},
      ${input.retryCount}, ${input.minimumIntervalMs}, ${input.concurrency},
      ${input.maximumResponseBytes}, ${input.minimumVectorRelevance},
      ${input.vectorProducingRevisionPublicId},
      ${reused?.resolved_dimension ?? null},
      ${reused?.validation_status ?? "not_tested"},
      ${reused?.validation_fingerprint_sha256 ?? null},
      ${reused?.safe_validation_error_code ?? null},
      ${reused?.validated_at ?? null}, ${input.createdAt}
    )
  `;
}

async function requireConfiguration(
  sql: DatabaseClient | TransactionSql,
  publicId: string
): Promise<EmbeddingConfigurationPrivate> {
  const result = await readConfiguration(sql, publicId);
  if (!result) throw repositoryError("missing");
  return result;
}

async function readConfiguration(
  sql: DatabaseClient | TransactionSql,
  publicId: string
): Promise<EmbeddingConfigurationPrivate | null> {
  const rows = await readConfigurationRows(sql, publicId);
  return rows[0] ? mapConfiguration(rows[0]) : null;
}

async function readConfigurationRows(
  sql: DatabaseClient | TransactionSql,
  publicId: string | null
): Promise<ConfigurationRow[]> {
  return sql<ConfigurationRow[]>`
    SELECT configuration.public_id AS configuration_public_id,
           configuration.display_name, configuration.lifecycle_status,
           configuration.revision AS configuration_revision,
           revision.public_id AS revision_public_id,
           revision.revision_number, revision.authentication_mode,
           revision.base_url, revision.encrypted_api_key, revision.model_name,
           revision.requested_dimension, revision.resolved_dimension,
           revision.normalization, revision.maximum_input_tokens,
           revision.batch_size, revision.timeout_ms, revision.retry_count,
           revision.minimum_interval_ms, revision.concurrency,
           revision.maximum_response_bytes, revision.minimum_vector_relevance,
           revision.vector_producing_revision_public_id,
           revision.validation_status,
           revision.validation_fingerprint_sha256,
           revision.safe_validation_error_code, revision.created_at
    FROM focowiki.embedding_configurations configuration
    JOIN focowiki.embedding_configuration_revisions revision
      ON revision.configuration_public_id = configuration.public_id
     AND revision.public_id = configuration.active_revision_public_id
    WHERE (${publicId}::text IS NULL OR configuration.public_id = ${publicId})
      AND configuration.deleted_at IS NULL
    ORDER BY configuration.created_at, configuration.public_id
  `;
}

async function readRevisionRows(
  sql: DatabaseClient | TransactionSql,
  revisionPublicId: string
): Promise<ConfigurationRow[]> {
  return sql<ConfigurationRow[]>`
    SELECT configuration.public_id AS configuration_public_id,
           configuration.display_name, configuration.lifecycle_status,
           configuration.revision AS configuration_revision,
           revision.public_id AS revision_public_id,
           revision.revision_number, revision.authentication_mode,
           revision.base_url, revision.encrypted_api_key, revision.model_name,
           revision.requested_dimension, revision.resolved_dimension,
           revision.normalization, revision.maximum_input_tokens,
           revision.batch_size, revision.timeout_ms, revision.retry_count,
           revision.minimum_interval_ms, revision.concurrency,
           revision.maximum_response_bytes, revision.minimum_vector_relevance,
           revision.vector_producing_revision_public_id,
           revision.validation_status,
           revision.validation_fingerprint_sha256,
           revision.safe_validation_error_code, revision.created_at
    FROM focowiki.embedding_configuration_revisions revision
    JOIN focowiki.embedding_configurations configuration
      ON configuration.public_id = revision.configuration_public_id
    WHERE revision.public_id = ${revisionPublicId}
      AND configuration.deleted_at IS NULL
    LIMIT 1
  `;
}

function mapConfiguration(row: ConfigurationRow): EmbeddingConfigurationPrivate {
  return {
    publicId: row.configuration_public_id,
    revisionPublicId: row.revision_public_id,
    revision: Number(row.configuration_revision),
    displayName: row.display_name,
    authenticationMode: row.authentication_mode,
    baseUrl: row.base_url,
    encryptedApiKey: row.encrypted_api_key?.toString("utf8") ?? null,
    apiKeyConfigured: row.encrypted_api_key !== null,
    modelName: row.model_name,
    requestedDimension: row.requested_dimension,
    resolvedDimension: row.resolved_dimension,
    normalization: row.normalization,
    maximumInputTokens: row.maximum_input_tokens,
    batchSize: row.batch_size,
    timeoutMs: row.timeout_ms,
    retryCount: row.retry_count,
    minimumIntervalMs: row.minimum_interval_ms,
    concurrency: row.concurrency,
    maximumResponseBytes: row.maximum_response_bytes,
    minimumVectorRelevance: row.minimum_vector_relevance,
    vectorProducingRevisionPublicId: row.vector_producing_revision_public_id,
    queryPolicyRevisionPublicId: row.revision_public_id,
    validationStatus: row.validation_status,
    validationFingerprintSha256: row.validation_fingerprint_sha256,
    safeValidationErrorCode: row.safe_validation_error_code,
    lifecycleStatus: row.lifecycle_status,
    createdAt: toIso(row.created_at)
  };
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function repositoryError(
  code: EmbeddingConfigurationRepositoryError["code"]
): EmbeddingConfigurationRepositoryError {
  return new EmbeddingConfigurationRepositoryError(code);
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof EmbeddingConfigurationRepositoryError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "23505") throw repositoryError("conflict");
  if (code === "23503") throw repositoryError("missing");
  throw error;
}
