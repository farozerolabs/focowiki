import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "../db/client.js";
import type {
  ModelConfigStatus,
  RuntimeModelConfigPrivate,
  RuntimeSettingKey,
  RuntimeSettingRecord
} from "./types.js";

type RuntimeSettingRow = {
  key: RuntimeSettingKey;
  value_json: unknown;
  version: number;
  source: "bootstrap" | "admin";
  created_at: Date;
  updated_at: Date;
};

type ModelConfigRow = {
  id: string;
  display_name: string;
  base_url: string;
  encrypted_api_key: string;
  api_key_fingerprint: string;
  model_name: string;
  context_window_tokens: number;
  request_max_timeout_ms: number;
  request_idle_timeout_ms: number;
  suggestion_concurrency: number;
  transient_retry_delay_ms: number;
  request_min_interval_ms: number;
  status: ModelConfigStatus;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
};

export type RuntimeSettingsRepository = {
  listSettings: () => Promise<Array<RuntimeSettingRecord>>;
  getSetting: (key: RuntimeSettingKey) => Promise<RuntimeSettingRecord | null>;
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
  }) => Promise<void>;
  listModels: () => Promise<RuntimeModelConfigPrivate[]>;
  getModel: (id: string) => Promise<RuntimeModelConfigPrivate | null>;
  getActiveModel: () => Promise<RuntimeModelConfigPrivate | null>;
  createModel: (input: {
    displayName: string;
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
  updateModelApiKeyProtection: (input: {
    id: string;
    encryptedApiKey: string;
    apiKeyFingerprint: string;
  }) => Promise<RuntimeModelConfigPrivate | null>;
  setModelStatus: (input: {
    id: string;
    status: Exclude<ModelConfigStatus, "deleted">;
    isActive?: boolean | undefined;
  }) => Promise<RuntimeModelConfigPrivate | null>;
  setActiveModel: (id: string) => Promise<RuntimeModelConfigPrivate | null>;
  softDeleteModel: (id: string) => Promise<RuntimeModelConfigPrivate | null>;
  countRunningModelInvocations: (modelConfigId: string) => Promise<number>;
  countRunningSourceFileJobs: () => Promise<number>;
};

export function createRuntimeSettingsRepository(sql: DatabaseClient): RuntimeSettingsRepository {
  return {
    async listSettings() {
      const rows = await sql<RuntimeSettingRow[]>`
        SELECT key, value_json, version, source, created_at, updated_at
        FROM focowiki.runtime_settings
        ORDER BY key ASC
      `;

      return rows.map(toSettingRecord);
    },
    async getSetting(key) {
      const rows = await sql<RuntimeSettingRow[]>`
        SELECT key, value_json, version, source, created_at, updated_at
        FROM focowiki.runtime_settings
        WHERE key = ${key}
        LIMIT 1
      `;

      return rows[0] ? toSettingRecord(rows[0]) : null;
    },
    async upsertSetting(input) {
      const rows = await sql<RuntimeSettingRow[]>`
        INSERT INTO focowiki.runtime_settings (key, value_json, source)
        VALUES (${input.key}, ${sql.json(input.value as never)}, ${input.source})
        ON CONFLICT (key) DO UPDATE
        SET value_json = EXCLUDED.value_json,
            source = EXCLUDED.source,
            version = focowiki.runtime_settings.version + 1,
            updated_at = now()
        RETURNING key, value_json, version, source, created_at, updated_at
      `;

      if (!rows[0]) {
        throw new Error("Runtime setting upsert did not return a row");
      }

      return toSettingRecord(rows[0]);
    },
    async createAuditLog(input) {
      await sql`
        INSERT INTO focowiki.runtime_setting_audit_logs (
          id, setting_key, action, actor, value_json
        )
        VALUES (
          ${`runtime-setting-audit-${randomUUID()}`},
          ${input.settingKey},
          ${input.action},
          ${input.actor ?? null},
          ${sql.json(input.value as never)}
        )
      `;
    },
    async listModels() {
      const rows = await sql<ModelConfigRow[]>`
        SELECT *
        FROM focowiki.model_configs
        WHERE deleted_at IS NULL
        ORDER BY is_active DESC, created_at DESC, id DESC
      `;

      return rows.map(toPrivateModel);
    },
    async getModel(id) {
      const rows = await sql<ModelConfigRow[]>`
        SELECT *
        FROM focowiki.model_configs
        WHERE id = ${id}
        LIMIT 1
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async getActiveModel() {
      const rows = await sql<ModelConfigRow[]>`
        SELECT *
        FROM focowiki.model_configs
        WHERE is_active = true
          AND status = 'active'
          AND deleted_at IS NULL
        LIMIT 1
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async createModel(input) {
      if (input.isActive) {
        await sql`
          UPDATE focowiki.model_configs
          SET is_active = false, updated_at = now()
          WHERE is_active = true
        `;
      }

      const rows = await sql<ModelConfigRow[]>`
        INSERT INTO focowiki.model_configs (
          id,
          display_name,
          base_url,
          encrypted_api_key,
          api_key_fingerprint,
          model_name,
          context_window_tokens,
          request_max_timeout_ms,
          request_idle_timeout_ms,
          suggestion_concurrency,
          transient_retry_delay_ms,
          request_min_interval_ms,
          status,
          is_active
        )
        VALUES (
          ${`model-config-${randomUUID()}`},
          ${input.displayName},
          ${input.baseUrl},
          ${input.encryptedApiKey},
          ${input.apiKeyFingerprint},
          ${input.modelName},
          ${input.contextWindowTokens},
          ${input.requestMaxTimeoutMs},
          ${input.requestIdleTimeoutMs},
          ${input.suggestionConcurrency},
          ${input.transientRetryDelayMs},
          ${input.requestMinIntervalMs},
          'active',
          ${input.isActive}
        )
        RETURNING *
      `;

      if (!rows[0]) {
        throw new Error("Runtime model creation did not return a row");
      }

      return toPrivateModel(rows[0]);
    },
    async updateModelApiKeyProtection(input) {
      const rows = await sql<ModelConfigRow[]>`
        UPDATE focowiki.model_configs
        SET encrypted_api_key = ${input.encryptedApiKey},
            api_key_fingerprint = ${input.apiKeyFingerprint},
            updated_at = now()
        WHERE id = ${input.id}
          AND deleted_at IS NULL
        RETURNING *
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async setModelStatus(input) {
      const rows = await sql<ModelConfigRow[]>`
        UPDATE focowiki.model_configs
        SET status = ${input.status},
            is_active = ${input.isActive ?? false},
            updated_at = now()
        WHERE id = ${input.id}
          AND deleted_at IS NULL
        RETURNING *
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async setActiveModel(id) {
      await sql`
        UPDATE focowiki.model_configs
        SET is_active = false, updated_at = now()
        WHERE is_active = true
      `;
      const rows = await sql<ModelConfigRow[]>`
        UPDATE focowiki.model_configs
        SET is_active = true,
            status = 'active',
            updated_at = now()
        WHERE id = ${id}
          AND deleted_at IS NULL
        RETURNING *
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async softDeleteModel(id) {
      const rows = await sql<ModelConfigRow[]>`
        UPDATE focowiki.model_configs
        SET status = 'deleted',
            is_active = false,
            deleted_at = now(),
            updated_at = now()
        WHERE id = ${id}
          AND deleted_at IS NULL
        RETURNING *
      `;

      return rows[0] ? toPrivateModel(rows[0]) : null;
    },
    async countRunningModelInvocations(modelConfigId) {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.model_invocations
        WHERE model_config_id = ${modelConfigId}
          AND status = 'running'
      `;

      return Number(rows[0]?.count ?? 0);
    },
    async countRunningSourceFileJobs() {
      const rows = await sql<Array<{ count: number | string }>>`
        SELECT count(*) AS count
        FROM focowiki.source_files
        WHERE processing_status = 'running'
      `;

      return Number(rows[0]?.count ?? 0);
    }
  };
}

function toSettingRecord(row: RuntimeSettingRow): RuntimeSettingRecord {
  return {
    key: row.key,
    value: row.value_json,
    version: row.version,
    source: row.source,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function toPrivateModel(row: ModelConfigRow): RuntimeModelConfigPrivate {
  return {
    id: row.id,
    displayName: row.display_name,
    baseUrl: row.base_url,
    apiKey: row.encrypted_api_key,
    apiKeyFingerprint: row.api_key_fingerprint,
    modelName: row.model_name,
    contextWindowTokens: Number(row.context_window_tokens),
    requestMaxTimeoutMs: Number(row.request_max_timeout_ms),
    requestIdleTimeoutMs: Number(row.request_idle_timeout_ms),
    suggestionConcurrency: Number(row.suggestion_concurrency),
    transientRetryDelayMs: Number(row.transient_retry_delay_ms),
    requestMinIntervalMs: Number(row.request_min_interval_ms),
    status: row.status,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    deletedAt: row.deleted_at?.toISOString() ?? null
  };
}
