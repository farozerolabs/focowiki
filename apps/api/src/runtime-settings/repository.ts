import { randomUUID } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../db/client.js";
import {
  createStorageVnextRuntimeSettingsRevision,
  readStorageVnextRuntimeSettingsRevision,
  type StorageVnextRuntimeSettingsRevision
} from "./revision-document.js";
import type {
  ModelConfigStatus,
  ModelApiMode,
  RuntimeModelConfigPrivate,
  RuntimeSettingKey,
  RuntimeSettingRecord
} from "./types.js";

type RuntimeSettingRevisionRow = {
  public_id: string;
  checksum_sha256: string;
  settings_values: unknown;
  created_at: Date | string;
};

type ReadSql = DatabaseClient | TransactionSql;

export type RuntimeSettingsRevisionIdentity = {
  publicId: string;
  checksum: string;
  version: number;
};

type ModelConfigRow = {
  public_id: string;
  provider: string;
  model: string;
  secret_reference: string;
  config: unknown;
  enabled: boolean;
  revision: number | string;
  created_at: Date | string;
  updated_at: Date | string;
};

type ModelConfigDocument = {
  displayName: string;
  apiMode: ModelApiMode;
  baseUrl: string;
  apiKeyFingerprint: string;
  contextWindowTokens: number;
  requestMaxTimeoutMs: number;
  requestIdleTimeoutMs: number;
  suggestionConcurrency: number;
  transientRetryDelayMs: number;
  requestMinIntervalMs: number;
  status: ModelConfigStatus;
  deletedAt: string | null;
};

const MODEL_PROVIDER = "openai-compatible";

export type RuntimeSettingsRepository = {
  listSettings: () => Promise<Array<RuntimeSettingRecord>>;
  getSetting: (key: RuntimeSettingKey) => Promise<RuntimeSettingRecord | null>;
  getCurrentRevision: () => Promise<RuntimeSettingsRevisionIdentity | null>;
  getRevision: (
    publicId: string
  ) => Promise<StorageVnextRuntimeSettingsRevision | null>;
  upsertSetting: (input: {
    key: RuntimeSettingKey;
    value: unknown;
    source: "bootstrap" | "admin";
  }) => Promise<RuntimeSettingRecord>;
  createAuditLog: (input: {
    settingKey: string;
    action: string;
    actor?: string | null | undefined;
    value: unknown;
    expiresAt: string;
  }) => Promise<void>;
  listModels: () => Promise<RuntimeModelConfigPrivate[]>;
  getModel: (id: string) => Promise<RuntimeModelConfigPrivate | null>;
  getModelRevision: (
    id: string,
    revision: number
  ) => Promise<RuntimeModelConfigPrivate | null>;
  getActiveModel: () => Promise<RuntimeModelConfigPrivate | null>;
  createModel: (input: {
    displayName: string;
    apiMode: ModelApiMode;
    baseUrl: string;
    encryptedApiKey: string;
    apiKeyFingerprint: string;
    modelName: string;
    contextWindowTokens: number;
    requestMaxTimeoutMs: number;
    requestIdleTimeoutMs: number;
    suggestionConcurrency: number;
    transientRetryDelayMs: number;
    requestMinIntervalMs: number;
    isActive: boolean;
  }) => Promise<RuntimeModelConfigPrivate>;
  updateModel: (input: {
    id: string;
    displayName: string;
    apiMode: ModelApiMode;
    baseUrl: string;
    encryptedApiKey: string;
    apiKeyFingerprint: string;
    modelName: string;
    contextWindowTokens: number;
    requestMaxTimeoutMs: number;
    requestIdleTimeoutMs: number;
    suggestionConcurrency: number;
    transientRetryDelayMs: number;
    requestMinIntervalMs: number;
  }) => Promise<RuntimeModelConfigPrivate | null>;
  setModelStatus: (input: {
    id: string;
    status: Exclude<ModelConfigStatus, "deleted">;
    isActive?: boolean | undefined;
  }) => Promise<RuntimeModelConfigPrivate | null>;
  setActiveModel: (id: string) => Promise<RuntimeModelConfigPrivate | null>;
  softDeleteModel: (id: string) => Promise<RuntimeModelConfigPrivate | null>;
  countRunningModelInvocations: (modelConfigId: string) => Promise<number>;
};

export function createRuntimeSettingsRepository(sql: DatabaseClient): RuntimeSettingsRepository {
  return {
    async listSettings() {
      const current = await readCurrentRevision(sql, false);
      return current ? toSettingRecords(current) : [];
    },
    async getSetting(key) {
      const current = await readCurrentRevision(sql, false);
      return current ? toSettingRecord(current, key) : null;
    },
    async getCurrentRevision() {
      const current = await readCurrentRevision(sql, false);
      return current ? {
        publicId: current.revision.publicId,
        checksum: current.revision.checksum,
        version: current.revision.document.version
      } : null;
    },
    async getRevision(publicId) {
      const row = await readRevisionByPublicId(sql, publicId);
      return row ? readRevisionRow(row).revision : null;
    },
    async upsertSetting(input) {
      return sql.begin(async (transaction) => {
        await transaction`
          SELECT pg_advisory_xact_lock(
            hashtext('focowiki.runtime_setting_current')::bigint
          )
        `;
        const current = await readCurrentRevision(transaction, true);
        const revision = createStorageVnextRuntimeSettingsRevision({
          current: current?.revision.document ?? null,
          key: input.key,
          value: input.value,
          source: input.source
        });
        const inserted = await transaction<RuntimeSettingRevisionRow[]>`
          INSERT INTO focowiki.runtime_setting_revisions (
            public_id, checksum_sha256, settings_values, created_by_public_id
          ) VALUES (
            ${revision.publicId}, ${revision.checksum},
            ${transaction.json(revision.document as never)}, NULL
          )
          ON CONFLICT (public_id) DO NOTHING
          RETURNING public_id, checksum_sha256, settings_values, created_at
        `;
        const stored = inserted[0] ?? await readRevisionByPublicId(
          transaction,
          revision.publicId
        );
        if (!stored) throw new Error("Runtime settings revision was not persisted");
        const verified = readRevisionRow(stored);
        if (
          verified.revision.checksum !== revision.checksum
          || verified.revision.document.version !== revision.document.version
        ) {
          throw new Error("Runtime settings revision identity conflict");
        }
        await transaction`
          INSERT INTO focowiki.runtime_setting_current (
            singleton, revision_public_id, updated_at
          ) VALUES (true, ${revision.publicId}, now())
          ON CONFLICT (singleton) DO UPDATE
          SET revision_public_id = EXCLUDED.revision_public_id,
              updated_at = EXCLUDED.updated_at
        `;
        const record = toSettingRecord(verified, input.key);
        if (!record) throw new Error("Runtime setting section was not persisted");
        return record;
      });
    },
    async createAuditLog(input) {
      const createdAt = new Date().toISOString();
      await sql`
        INSERT INTO focowiki.security_audit_events (
          public_id, knowledge_base_id, actor_public_id, event_type,
          target_kind, target_public_id, result, reason_code, source_ip,
          user_agent, metadata, created_at, expires_at
        )
        VALUES (
          ${`runtime-setting-audit-${randomUUID()}`},
          NULL,
          ${input.actor ?? null},
          ${`runtime_settings.${input.action}`},
          'runtime_setting',
          ${input.settingKey},
          'success',
          NULL,
          NULL,
          NULL,
          ${sql.json({ settingKey: input.settingKey, action: input.action })},
          ${createdAt},
          ${input.expiresAt}
        )
      `;
    },
    async listModels() {
      const rows = await sql<ModelConfigRow[]>`
        SELECT public_id, provider, model, secret_reference, config,
               enabled, revision, created_at, updated_at
        FROM focowiki.model_configs
        WHERE knowledge_base_id IS NULL
          AND config ->> 'status' <> 'deleted'
        ORDER BY enabled DESC, created_at DESC, public_id DESC
      `;

      return rows.map((row) => toPrivateModel(row));
    },
    async getModel(id) {
      const rows = await sql<ModelConfigRow[]>`
        SELECT public_id, provider, model, secret_reference, config,
               enabled, revision, created_at, updated_at
        FROM focowiki.model_configs
        WHERE public_id = ${id}
          AND knowledge_base_id IS NULL
          AND config ->> 'status' <> 'deleted'
        LIMIT 1
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async getModelRevision(id, revision) {
      if (!Number.isSafeInteger(revision) || revision < 1) return null;
      const rows = await sql<ModelConfigRow[]>`
        SELECT configuration_public_id AS public_id,
               provider, model, secret_reference, config,
               false AS enabled, revision_number AS revision,
               created_at, created_at AS updated_at
        FROM focowiki.model_config_revisions
        WHERE configuration_public_id = ${id}
          AND revision_number = ${revision}
        LIMIT 1
      `;
      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async getActiveModel() {
      const rows = await sql<ModelConfigRow[]>`
        SELECT public_id, provider, model, secret_reference, config,
               enabled, revision, created_at, updated_at
        FROM focowiki.model_configs
        WHERE knowledge_base_id IS NULL
          AND enabled = true
          AND config ->> 'status' = 'active'
        ORDER BY updated_at DESC, public_id DESC
        LIMIT 1
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async createModel(input) {
      const rows = await sql.begin(async (transaction) => {
        if (input.isActive) {
          await lockActiveModel(transaction);
          await transaction`
            UPDATE focowiki.model_configs
            SET enabled = false, updated_at = now()
            WHERE knowledge_base_id IS NULL AND enabled = true
          `;
        }
        return transaction<ModelConfigRow[]>`
          INSERT INTO focowiki.model_configs (
            public_id, knowledge_base_id, provider, model,
            secret_reference, config, enabled, revision
          ) VALUES (
            ${`model-config-${randomUUID()}`}, NULL, ${MODEL_PROVIDER},
            ${input.modelName}, ${input.encryptedApiKey},
            ${transaction.json(createModelConfigDocument(input) as never)},
            ${input.isActive}, 1
          )
          RETURNING public_id, provider, model, secret_reference, config,
                    enabled, revision, created_at, updated_at
        `;
      });

      if (!rows[0]) {
        throw new Error("Runtime model creation did not return a row");
      }

      return toPrivateModel(rows[0]);
    },
    async updateModel(input) {
      const rows = await sql<ModelConfigRow[]>`
        UPDATE focowiki.model_configs
        SET model = ${input.modelName},
            secret_reference = ${input.encryptedApiKey},
            config = config || ${sql.json({
              displayName: input.displayName,
              apiMode: input.apiMode,
              baseUrl: input.baseUrl,
              apiKeyFingerprint: input.apiKeyFingerprint,
              contextWindowTokens: input.contextWindowTokens,
              requestMaxTimeoutMs: input.requestMaxTimeoutMs,
              requestIdleTimeoutMs: input.requestIdleTimeoutMs,
              suggestionConcurrency: input.suggestionConcurrency,
              transientRetryDelayMs: input.transientRetryDelayMs,
              requestMinIntervalMs: input.requestMinIntervalMs
            })},
            revision = revision + 1,
            updated_at = now()
        WHERE public_id = ${input.id}
          AND knowledge_base_id IS NULL
          AND config ->> 'status' <> 'deleted'
        RETURNING public_id, provider, model, secret_reference, config,
                  enabled, revision, created_at, updated_at
      `;
      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async setModelStatus(input) {
      const rows = await sql.begin(async (transaction) => {
        if (input.isActive) {
          await lockActiveModel(transaction);
          await transaction`
            UPDATE focowiki.model_configs
            SET enabled = false, updated_at = now()
            WHERE knowledge_base_id IS NULL AND enabled = true
          `;
        }
        return transaction<ModelConfigRow[]>`
          UPDATE focowiki.model_configs
          SET config = config || ${transaction.json({ status: input.status })},
              enabled = ${input.isActive ?? false},
              updated_at = now()
          WHERE public_id = ${input.id}
            AND knowledge_base_id IS NULL
            AND config ->> 'status' <> 'deleted'
          RETURNING public_id, provider, model, secret_reference, config,
                    enabled, revision, created_at, updated_at
        `;
      });

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async setActiveModel(id) {
      const rows = await sql.begin(async (transaction) => {
        await lockActiveModel(transaction);
        const target = await transaction<Array<{ public_id: string }>>`
          SELECT public_id
          FROM focowiki.model_configs
          WHERE public_id = ${id}
            AND knowledge_base_id IS NULL
            AND config ->> 'status' <> 'deleted'
          FOR UPDATE
        `;
        if (!target[0]) return [] as ModelConfigRow[];
        await transaction`
          UPDATE focowiki.model_configs
          SET enabled = false, updated_at = now()
          WHERE knowledge_base_id IS NULL AND enabled = true
        `;
        return transaction<ModelConfigRow[]>`
          UPDATE focowiki.model_configs
          SET config = config || ${transaction.json({ status: "active" })},
              enabled = true,
              updated_at = now()
          WHERE public_id = ${id}
            AND knowledge_base_id IS NULL
            AND config ->> 'status' <> 'deleted'
          RETURNING public_id, provider, model, secret_reference, config,
                    enabled, revision, created_at, updated_at
        `;
      });

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async softDeleteModel(id) {
      const rows = await sql<ModelConfigRow[]>`
        UPDATE focowiki.model_configs
        SET config = config || ${sql.json({
          status: "deleted",
          deletedAt: new Date().toISOString()
        })},
            enabled = false,
            revision = revision + 1,
            updated_at = now()
        WHERE public_id = ${id}
          AND knowledge_base_id IS NULL
          AND config ->> 'status' <> 'deleted'
        RETURNING public_id, provider, model, secret_reference, config,
                  enabled, revision, created_at, updated_at
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async countRunningModelInvocations(modelConfigId) {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.document_processing_jobs
        WHERE state = 'processing'
          AND generation_model_configuration_public_id = ${modelConfigId}
      `;

      return Number(rows[0]?.count ?? 0);
    }
  };
}

type VerifiedRuntimeSettingsRevision = {
  revision: StorageVnextRuntimeSettingsRevision;
  createdAt: string;
};

const SETTING_KEYS: readonly RuntimeSettingKey[] = [
  "rate_limits",
  "worker",
  "generated",
  "graph",
  "maintenance",
  "semantic",
  "search"
];

async function readCurrentRevision(
  sql: ReadSql,
  lock: boolean
): Promise<VerifiedRuntimeSettingsRevision | null> {
  const rows = await sql<RuntimeSettingRevisionRow[]>`
    SELECT revision.public_id, revision.checksum_sha256,
           revision.settings_values, revision.created_at
    FROM focowiki.runtime_setting_current AS current_pointer
    JOIN focowiki.runtime_setting_revisions AS revision
      ON revision.public_id = current_pointer.revision_public_id
    WHERE current_pointer.singleton = true
    ${lock ? sql`FOR UPDATE OF current_pointer` : sql``}
  `;
  return rows[0] ? readRevisionRow(rows[0]) : null;
}

async function readRevisionByPublicId(
  sql: ReadSql,
  publicId: string
): Promise<RuntimeSettingRevisionRow | null> {
  const rows = await sql<RuntimeSettingRevisionRow[]>`
    SELECT public_id, checksum_sha256, settings_values, created_at
    FROM focowiki.runtime_setting_revisions
    WHERE public_id = ${publicId}
    LIMIT 1
  `;
  return rows[0] ?? null;
}

function readRevisionRow(
  row: RuntimeSettingRevisionRow
): VerifiedRuntimeSettingsRevision {
  return {
    revision: readStorageVnextRuntimeSettingsRevision({
      publicId: row.public_id,
      checksum: row.checksum_sha256,
      document: row.settings_values
    }),
    createdAt: timestamp(row.created_at)
  };
}

function toSettingRecords(
  current: VerifiedRuntimeSettingsRevision
): RuntimeSettingRecord[] {
  return SETTING_KEYS
    .map((key) => toSettingRecord(current, key))
    .filter((record): record is RuntimeSettingRecord => record !== null);
}

function toSettingRecord(
  current: VerifiedRuntimeSettingsRevision,
  key: RuntimeSettingKey
): RuntimeSettingRecord | null {
  const value = current.revision.document.sections[key];
  if (value === undefined) return null;
  return {
    key,
    value: structuredClone(value),
    version: current.revision.document.version,
    source: current.revision.document.source,
    createdAt: current.createdAt,
    updatedAt: current.createdAt
  };
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("Runtime settings revision timestamp is invalid");
  }
  return parsed.toISOString();
}

async function lockActiveModel(sql: TransactionSql): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtext('focowiki.model_configs.active')::bigint
    )
  `;
}

function createModelConfigDocument(
  input: Parameters<RuntimeSettingsRepository["createModel"]>[0]
): ModelConfigDocument {
  return {
    displayName: input.displayName,
    apiMode: input.apiMode,
    baseUrl: input.baseUrl,
    apiKeyFingerprint: input.apiKeyFingerprint,
    contextWindowTokens: input.contextWindowTokens,
    requestMaxTimeoutMs: input.requestMaxTimeoutMs,
    requestIdleTimeoutMs: input.requestIdleTimeoutMs,
    suggestionConcurrency: input.suggestionConcurrency,
    transientRetryDelayMs: input.transientRetryDelayMs,
    requestMinIntervalMs: input.requestMinIntervalMs,
    status: "active",
    deletedAt: null
  };
}

function toPrivateModel(
  row: ModelConfigRow,
  override?: {
    status: ModelConfigStatus;
    isActive: boolean;
    deletedAt: string;
  }
): RuntimeModelConfigPrivate {
  const config = readModelConfigDocument(row.config);
  return {
    id: row.public_id,
    displayName: config.displayName,
    apiMode: config.apiMode,
    baseUrl: config.baseUrl,
    apiKey: row.secret_reference,
    configurationRevision: Number(row.revision),
    apiKeyFingerprint: config.apiKeyFingerprint,
    modelName: row.model,
    contextWindowTokens: config.contextWindowTokens,
    requestMaxTimeoutMs: config.requestMaxTimeoutMs,
    requestIdleTimeoutMs: config.requestIdleTimeoutMs,
    suggestionConcurrency: config.suggestionConcurrency,
    transientRetryDelayMs: config.transientRetryDelayMs,
    requestMinIntervalMs: config.requestMinIntervalMs,
    status: override?.status ?? config.status,
    isActive: override?.isActive ?? row.enabled,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    deletedAt: override?.deletedAt ?? config.deletedAt
  };
}

function readModelConfigDocument(value: unknown): ModelConfigDocument {
  if (!isRecord(value)) {
    throw new Error("Runtime model config document is invalid");
  }
  const status = value.status;
  if (status !== "active" && status !== "paused" && status !== "deleted") {
    throw new Error("Runtime model config status is invalid");
  }
  return {
    displayName: readModelString(value, "displayName"),
    apiMode: readModelApiMode(value.apiMode),
    baseUrl: readModelString(value, "baseUrl"),
    apiKeyFingerprint: readModelString(value, "apiKeyFingerprint"),
    contextWindowTokens: readModelNumber(value, "contextWindowTokens"),
    requestMaxTimeoutMs: readModelNumber(value, "requestMaxTimeoutMs"),
    requestIdleTimeoutMs: readModelNumber(value, "requestIdleTimeoutMs"),
    suggestionConcurrency: readModelNumber(value, "suggestionConcurrency"),
    transientRetryDelayMs: readModelNumber(value, "transientRetryDelayMs"),
    requestMinIntervalMs: readModelNumber(value, "requestMinIntervalMs"),
    status,
    deletedAt: readDeletedAt(value.deletedAt, status)
  };
}

function readDeletedAt(value: unknown, status: ModelConfigStatus): string | null {
  if (status !== "deleted") return null;
  if (typeof value !== "string" || !Number.isFinite(new Date(value).getTime())) {
    throw new Error("Runtime model config deletedAt is invalid");
  }
  return value;
}

function readModelString(
  value: Record<string, unknown>,
  field: string
): string {
  const fieldValue = value[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new Error(`Runtime model config ${field} is invalid`);
  }
  return fieldValue;
}

function readModelNumber(
  value: Record<string, unknown>,
  field: string
): number {
  const fieldValue = value[field];
  if (typeof fieldValue !== "number" || !Number.isFinite(fieldValue)) {
    throw new Error(`Runtime model config ${field} is invalid`);
  }
  return fieldValue;
}

function readModelApiMode(value: unknown): ModelApiMode {
  if (value !== "responses" && value !== "chat_completions") {
    throw new Error("Runtime model config apiMode is invalid");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
