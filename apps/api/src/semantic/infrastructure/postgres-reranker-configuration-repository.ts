import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import type { RerankerConfigurationPrivate } from
  "../reranker/configuration.js";
import type {
  RerankerConfigurationRepository,
  RerankerRevisionWrite
} from "../reranker/repository.js";

type ConfigurationRow = {
  configuration_public_id: string;
  display_name: string;
  lifecycle_status: "draft" | "active" | "paused";
  configuration_revision: number | string;
  revision_public_id: string;
  authentication_mode: "api_key" | "none";
  base_url: string;
  encrypted_api_key: Buffer | null;
  model_name: string;
  timeout_ms: number;
  retry_count: number;
  minimum_interval_ms: number;
  concurrency: number;
  validation_status: "not_tested" | "valid" | "invalid";
  validation_fingerprint_sha256: string | null;
  safe_validation_error_code: string | null;
  created_at: Date | string;
};

export class RerankerConfigurationRepositoryError extends Error {
  public constructor(
    public readonly code: "conflict" | "missing" | "revision_conflict"
  ) {
    super(`Reranker configuration repository error: ${code}`);
    this.name = "RerankerConfigurationRepositoryError";
  }
}

export function createPostgresRerankerConfigurationRepository(
  sql: DatabaseClient
): RerankerConfigurationRepository {
  return {
    async create(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          INSERT INTO focowiki.reranker_configurations (
            public_id, display_name, lifecycle_status, revision,
            created_at, updated_at
          ) VALUES (
            ${input.configurationPublicId}, ${input.displayName}, 'draft', 1,
            ${input.createdAt}, ${input.createdAt}
          )
        `;
        await insertRevision(transaction, input, 1);
        await transaction`
          UPDATE focowiki.reranker_configurations
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
          FROM focowiki.reranker_configurations
          WHERE public_id = ${input.configurationPublicId}
          FOR UPDATE
        `;
        if (!rows[0]) throw repositoryError("missing");
        if (Number(rows[0].revision) !== input.expectedConfigurationRevision) {
          throw repositoryError("revision_conflict");
        }
        const nextRevision = input.expectedConfigurationRevision + 1;
        await insertRevision(transaction, input, nextRevision);
        const updated = await transaction`
          UPDATE focowiki.reranker_configurations
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
      const rows = await readRows(sql, null, revisionPublicId, false);
      return rows[0] ? mapConfiguration(rows[0]) : null;
    },

    async getActive() {
      const rows = await readRows(sql, null, null, true);
      if (rows.length > 1) throw repositoryError("conflict");
      return rows[0] ? mapConfiguration(rows[0]) : null;
    },

    async list() {
      return (await readRows(sql, null, null, false)).map(mapConfiguration);
    },

    async recordValidation(input) {
      const rows = await sql<Array<{ public_id: string }>>`
        UPDATE focowiki.reranker_configuration_revisions revision
        SET validation_status = ${input.status},
            validation_fingerprint_sha256 = ${input.validationFingerprintSha256},
            safe_validation_error_code = ${input.safeValidationErrorCode},
            validated_at = ${input.validatedAt}
        FROM focowiki.reranker_configurations configuration
        WHERE revision.public_id = ${input.revisionPublicId}
          AND revision.configuration_public_id = ${input.configurationPublicId}
          AND configuration.public_id = revision.configuration_public_id
          AND configuration.active_revision_public_id = revision.public_id
        RETURNING revision.public_id
      `;
      if (!rows[0]) throw repositoryError("revision_conflict");
      return requireConfiguration(sql, input.configurationPublicId);
    },

    async setLifecycle(input) {
      return sql.begin(async (transaction) => {
        const current = await transaction<Array<{
          revision: number | string;
          validation_status: string;
        }>>`
          SELECT configuration.revision, revision.validation_status
          FROM focowiki.reranker_configurations configuration
          JOIN focowiki.reranker_configuration_revisions revision
            ON revision.public_id = configuration.active_revision_public_id
          WHERE configuration.public_id = ${input.configurationPublicId}
          FOR UPDATE OF configuration
        `;
        if (!current[0]) throw repositoryError("missing");
        if (Number(current[0].revision) !== input.expectedConfigurationRevision) {
          throw repositoryError("revision_conflict");
        }
        if (input.status === "active" && current[0].validation_status !== "valid") {
          throw repositoryError("conflict");
        }
        const rows = await transaction<Array<{ public_id: string }>>`
          UPDATE focowiki.reranker_configurations
          SET lifecycle_status = ${input.status}, revision = revision + 1,
              updated_at = now()
          WHERE public_id = ${input.configurationPublicId}
            AND revision = ${input.expectedConfigurationRevision}
          RETURNING public_id
        `;
        if (!rows[0]) throw repositoryError("revision_conflict");
        return requireConfiguration(transaction, input.configurationPublicId);
      }).catch(mapDatabaseError);
    },

    async delete(input) {
      const rows = await sql<Array<{ public_id: string }>>`
        DELETE FROM focowiki.reranker_configurations
        WHERE public_id = ${input.configurationPublicId}
          AND revision = ${input.expectedConfigurationRevision}
          AND lifecycle_status <> 'active'
        RETURNING public_id
      `;
      return rows.length === 1;
    }
  };
}

async function insertRevision(
  sql: TransactionSql,
  input: RerankerRevisionWrite & {
    configurationPublicId: string;
    revisionPublicId: string;
    createdAt: string;
  },
  revisionNumber: number
): Promise<void> {
  await sql`
    INSERT INTO focowiki.reranker_configuration_revisions (
      public_id, configuration_public_id, revision_number,
      authentication_mode, base_url, encrypted_api_key, model_name,
      timeout_ms, retry_count, minimum_interval_ms, concurrency,
      validation_status, validation_fingerprint_sha256,
      safe_validation_error_code, validated_at, created_at
    ) VALUES (
      ${input.revisionPublicId}, ${input.configurationPublicId},
      ${revisionNumber}, ${input.authenticationMode}, ${input.baseUrl},
      ${input.encryptedApiKey === null
        ? null
        : Buffer.from(input.encryptedApiKey, "utf8")},
      ${input.modelName}, ${input.timeoutMs}, ${input.retryCount},
      ${input.minimumIntervalMs}, ${input.concurrency}, 'not_tested',
      NULL, NULL, NULL, ${input.createdAt}
    )
  `;
}

async function requireConfiguration(
  sql: DatabaseClient | TransactionSql,
  publicId: string
): Promise<RerankerConfigurationPrivate> {
  const value = await readConfiguration(sql, publicId);
  if (!value) throw repositoryError("missing");
  return value;
}

async function readConfiguration(
  sql: DatabaseClient | TransactionSql,
  publicId: string
): Promise<RerankerConfigurationPrivate | null> {
  const rows = await readRows(sql, publicId, null, false);
  return rows[0] ? mapConfiguration(rows[0]) : null;
}

async function readRows(
  sql: DatabaseClient | TransactionSql,
  configurationPublicId: string | null,
  revisionPublicId: string | null,
  activeOnly: boolean
): Promise<ConfigurationRow[]> {
  return sql<ConfigurationRow[]>`
    SELECT configuration.public_id AS configuration_public_id,
           configuration.display_name, configuration.lifecycle_status,
           configuration.revision AS configuration_revision,
           revision.public_id AS revision_public_id,
           revision.authentication_mode, revision.base_url,
           revision.encrypted_api_key, revision.model_name,
           revision.timeout_ms, revision.retry_count,
           revision.minimum_interval_ms, revision.concurrency,
           revision.validation_status,
           revision.validation_fingerprint_sha256,
           revision.safe_validation_error_code, revision.created_at
    FROM focowiki.reranker_configurations configuration
    JOIN focowiki.reranker_configuration_revisions revision
      ON revision.configuration_public_id = configuration.public_id
     AND revision.public_id = CASE WHEN ${revisionPublicId}::text IS NULL
       THEN configuration.active_revision_public_id
       ELSE ${revisionPublicId}::text END
    WHERE (${configurationPublicId}::text IS NULL
        OR configuration.public_id = ${configurationPublicId})
      AND (${activeOnly}::boolean = false
        OR configuration.lifecycle_status = 'active')
    ORDER BY configuration.created_at, configuration.public_id
  `;
}

function mapConfiguration(row: ConfigurationRow): RerankerConfigurationPrivate {
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
    timeoutMs: row.timeout_ms,
    retryCount: row.retry_count,
    minimumIntervalMs: row.minimum_interval_ms,
    concurrency: row.concurrency,
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
  code: RerankerConfigurationRepositoryError["code"]
): RerankerConfigurationRepositoryError {
  return new RerankerConfigurationRepositoryError(code);
}

function mapDatabaseError(error: unknown): never {
  if (error instanceof RerankerConfigurationRepositoryError) throw error;
  const code = typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : "";
  if (code === "23505") throw repositoryError("conflict");
  if (code === "23503") throw repositoryError("missing");
  throw error;
}
