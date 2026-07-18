import { randomUUID } from "node:crypto";
import type {
  OkfGraphEdge,
  OkfGraphNode
} from "@focowiki/okf";
import type {
  PublicOpenApiKeyRecord,
  PublicOpenApiKeyRepository,
  PublicOpenApiKeyStatus
} from "../public-openapi/keys.js";
import type { DatabaseClient } from "./client.js";
import type { UploadSessionRepository } from "../application/ports/upload-session-repository.js";
import { createPostgresUploadSessionRepository } from "../infrastructure/postgres/upload-session-repository.js";
import type { SourceResourceRepository } from "../application/ports/source-resource-repository.js";
import { createPostgresSourceResourceRepository } from "../infrastructure/postgres/source-resource-repository.js";
import type {
  ModelInvocationStatus,
  SourceFileRepository
} from "../application/ports/source-file-repository.js";
import { createPostgresSourceFileRepository } from "../infrastructure/postgres/source-file-repository.js";
import { createPostgresFileGraphRepository } from "./file-graph-repository.js";
import {
  createRuntimeSettingsRepository,
  type RuntimeSettingsRepository
} from "../runtime-settings/repository.js";
import type { ModelApiMode } from "../runtime-settings/types.js";
export type {
  GeneratedSourceFileOutputRecord,
  GeneratedOutputStatus,
  ModelInvocationStatus,
  SourceFileActionState,
  SourceFileErrorState,
  SourceFileEventDraft,
  SourceFileEventRecord,
  SourceFileListFilters,
  SourceFileModelInvocationFilter,
  SourceFileProcessingStage,
  SourceFileProcessingStatus,
  SourceFileRecord
} from "../application/ports/source-file-repository.js";

export type CursorPage<T> = {
  items: T[];
  nextCursor: string | null;
};


export type KnowledgeBaseRecord = {
  id: string;
  name: string;
  description: string | null;
  activeGenerationId: string | null;
  resourceRevision?: number;
  catalogGeneration: number;
  createdAt: string;
  updatedAt: string;
};

export type CreateKnowledgeBaseInput = {
  name: string;
  description: string | null;
};

export type KnowledgeBaseRepository = {
  listKnowledgeBases: (request: {
    limit: number;
    cursor: string | null;
    query?: string | null;
  }) => Promise<CursorPage<KnowledgeBaseRecord>>;
  createKnowledgeBase: (input: CreateKnowledgeBaseInput) => Promise<KnowledgeBaseRecord>;
  getKnowledgeBase: (id: string) => Promise<KnowledgeBaseRecord | null>;
};


export type ModelInvocationRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  modelConfigId?: string | null;
  apiMode?: ModelApiMode | null;
  modelName: string;
  status: ModelInvocationStatus;
  startedAt: string;
  endedAt: string | null;
  warningCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  createdAt: string;
};

export type ModelInvocationDraft = Omit<ModelInvocationRecord, "id" | "createdAt"> & {
  id?: string;
};

export type SecurityAuditEventDraft = {
  eventType: string;
  result: "success" | "failure" | "blocked";
  errorCode: string | null;
  username: string | null;
  clientIp: string | null;
  userAgent: string | null;
  origin: string | null;
  createdAt?: string;
};


export type WebhookSubscriptionRecord = {
  id: string;
  name: string;
  url: string;
  signingSecret: string;
  events: string[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastDeliveryAt: string | null;
};

export type WebhookDeliveryRecord = {
  id: string;
  webhookId: string;
  eventId: string;
  eventType: string;
  payload: Record<string, unknown>;
  status: "pending" | "success" | "failed";
  attemptCount: number;
  httpStatus: number | null;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
};

export type WebhookRepository = {
  createWebhookSubscription: (input: {
    id: string;
    name: string;
    url: string;
    signingSecret: string;
    events: string[];
    createdAt: string;
  }) => Promise<WebhookSubscriptionRecord>;
  getWebhookSubscription?: (id: string) => Promise<WebhookSubscriptionRecord | null>;
  listWebhookSubscriptions: (request: {
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<WebhookSubscriptionRecord>>;
  deleteWebhookSubscription: (input: {
    id: string;
    updatedAt: string;
  }) => Promise<boolean>;
  createWebhookDelivery?: (input: {
    id: string;
    webhookId: string;
    eventId: string;
    eventType: string;
    payload: Record<string, unknown>;
    status: WebhookDeliveryRecord["status"];
    attemptCount: number;
    httpStatus: number | null;
    errorCode: string | null;
    createdAt: string;
  }) => Promise<WebhookDeliveryRecord>;
  updateWebhookDeliveryResult?: (input: {
    id: string;
    status: WebhookDeliveryRecord["status"];
    attemptCount: number;
    httpStatus: number | null;
    errorCode: string | null;
    updatedAt: string;
  }) => Promise<WebhookDeliveryRecord | null>;
  listWebhookDeliveries: (request: {
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<WebhookDeliveryRecord>>;
  getWebhookDelivery?: (deliveryId: string) => Promise<WebhookDeliveryRecord | null>;
};

export type FileGraphNodeRecord = OkfGraphNode & {
  knowledgeBaseId: string;
  sourceFileId: string;
  updatedAt: string;
};

export type FileGraphRelatedRecord = {
  fileId: string;
  sourceFileId: string;
  generatedFileId: string | null;
  path: string;
  title: string;
  relationType: string;
  direction: "outgoing" | "incoming";
  weight: number;
  reason: string;
  source: string;
  evidence?: Record<string, unknown>;
  contentAvailable: boolean;
};

export type FileGraphSummaryRecord = {
  sourceFileId: string;
  relationshipCount: number;
  relationships: FileGraphRelatedRecord[];
};

export type FileGraphJobRecord = {
  id: string;
  knowledgeBaseId: string;
  sourceFileId: string;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt: string | null;
  errorCode: string | null;
  createdAt: string;
};

export type FileGraphRepository = {
  createGraphJob?: (input: {
    id?: string;
    knowledgeBaseId: string;
    sourceFileId: string;
    startedAt: string;
  }) => Promise<FileGraphJobRecord>;
  completeGraphJob?: (input: {
    id: string;
    status: FileGraphJobRecord["status"];
    endedAt: string;
    errorCode?: string | null;
  }) => Promise<FileGraphJobRecord | null>;
  upsertGraphNode: (input: {
    knowledgeBaseId: string;
    node: OkfGraphNode;
  }) => Promise<void>;
  upsertGraphEdges: (input: {
    knowledgeBaseId: string;
    edges: OkfGraphEdge[];
  }) => Promise<string[] | void>;
  upsertRejectedGraphEdges?: (input: {
    knowledgeBaseId: string;
    edges: OkfGraphEdge[];
  }) => Promise<void>;
  replaceGraphEdgesForSourceFile?: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<{ sourceFileIds: string[]; edgeIds: string[] } | void>;
  reconcileExplicitReferenceEdgesForTarget?: (input: {
    knowledgeBaseId: string;
    target: OkfGraphNode;
    limit: number;
  }) => Promise<{
    edgeCount: number;
    sourceFileIds: string[];
    edgeIds: string[];
  }>;
  listGraphNodes: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<OkfGraphNode>>;
  listGraphEdges: (request: {
    knowledgeBaseId: string;
    limit: number;
    cursor: string | null;
  }) => Promise<CursorPage<OkfGraphEdge>>;
  getGraphEdge?: (request: {
    knowledgeBaseId: string;
    edgeId: string;
  }) => Promise<OkfGraphEdge | null>;
  listGraphNeighborhood: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
    cursor?: string | null;
  }) => Promise<CursorPage<FileGraphRelatedRecord>>;
  listGraphCandidates?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    terms: string[];
    limit: number;
  }) => Promise<OkfGraphNode[]>;
  getGraphSummary?: (request: {
    knowledgeBaseId: string;
    sourceFileId: string;
    limit: number;
  }) => Promise<FileGraphSummaryRecord>;
  getMutationClosures?: (request: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
  }) => Promise<Map<string, {
    neighborSourceFileIds: string[];
    edgeIds: string[];
  }>>;
  refreshGraphSummariesForSourceFiles?: (request: {
    knowledgeBaseId: string;
    sourceFileIds: string[];
    limit: number;
  }) => Promise<void>;
  deleteGraphForSourceFile: (input: {
    knowledgeBaseId: string;
    sourceFileId: string;
  }) => Promise<void>;
};

export type AdminRepositories = {
  knowledgeBases: KnowledgeBaseRepository;
  uploadSessions?: UploadSessionRepository;
  sourceResources?: SourceResourceRepository;
  files?: SourceFileRepository;
  graph?: FileGraphRepository;
  modelInvocations?: {
    createModelInvocation: (input: ModelInvocationDraft) => Promise<ModelInvocationRecord>;
    completeModelInvocation: (input: {
      id: string;
      status: ModelInvocationStatus;
      endedAt: string;
      warningCount?: number;
      errorCode?: string | null;
      errorMessage?: string | null;
    }) => Promise<ModelInvocationRecord | null>;
  };
  securityAudit?: {
    createSecurityAuditEvent: (input: SecurityAuditEventDraft) => Promise<void>;
  };
  publicApiKeys?: PublicOpenApiKeyRepository;
  webhooks?: WebhookRepository;
  runtimeSettings?: RuntimeSettingsRepository;
};

type KnowledgeBaseRow = {
  id: string;
  name: string;
  description: string | null;
  active_generation_id: string | null;
  resource_revision: number;
  catalog_generation: number | string;
  created_at: Date;
  updated_at: Date;
};


type ModelInvocationRow = {
  id: string;
  knowledge_base_id: string;
  source_file_id: string;
  model_config_id: string | null;
  api_mode: ModelApiMode | null;
  model_name: string;
  status: ModelInvocationStatus;
  started_at: Date;
  ended_at: Date | null;
  warning_count: number;
  error_code: string | null;
  error_message: string | null;
  created_at: Date;
};

type PublicApiKeyRow = {
  id: string;
  name: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  status: PublicOpenApiKeyStatus;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

type WebhookSubscriptionRow = {
  id: string;
  name: string;
  url: string;
  signing_secret: string;
  events_json: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
  last_delivery_at: Date | null;
};

type WebhookDeliveryRow = {
  id: string;
  webhook_id: string;
  event_id: string;
  event_type: string;
  payload_json: unknown;
  status: "pending" | "success" | "failed";
  attempt_count: number;
  http_status: number | null;
  error_code: string | null;
  created_at: Date;
  updated_at: Date;
};

export function createSecurityAuditEventId(): string {
  return `audit-${randomUUID()}`;
}

export function createPostgresAdminRepositories(sql: DatabaseClient): AdminRepositories {
  return {
    runtimeSettings: createRuntimeSettingsRepository(sql),
    uploadSessions: createPostgresUploadSessionRepository(sql),
    sourceResources: createPostgresSourceResourceRepository(sql),
    knowledgeBases: {
      async listKnowledgeBases({ limit, cursor, query }) {
        const cursorValue = cursor ? parseKnowledgeBaseCursor(cursor) : null;
        const searchPredicate = query
          ? sql`AND lower(knowledge_base.id || ' ' || knowledge_base.name || ' ' || coalesce(knowledge_base.description, '')) LIKE ${containsKnowledgeBaseLikePattern(query.toLocaleLowerCase("en-US"))} ESCAPE ${"\\"}`
          : sql``;
        const rows = cursorValue
          ? await sql<Array<KnowledgeBaseRow & { cursor_timestamp: string }>>`
              SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description, knowledge_base.active_generation_id, knowledge_base.resource_revision, knowledge_base.catalog_generation, knowledge_base.created_at, knowledge_base.updated_at,
                     floor(extract(epoch FROM knowledge_base.created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.deleted_at IS NULL
                ${searchPredicate}
                AND (
                  knowledge_base.created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (knowledge_base.created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND knowledge_base.id > ${cursorValue.id})
                )
              ORDER BY knowledge_base.created_at DESC, knowledge_base.id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<KnowledgeBaseRow & { cursor_timestamp: string }>>`
              SELECT knowledge_base.id, knowledge_base.name, knowledge_base.description, knowledge_base.active_generation_id, knowledge_base.resource_revision, knowledge_base.catalog_generation, knowledge_base.created_at, knowledge_base.updated_at,
                     floor(extract(epoch FROM knowledge_base.created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.knowledge_bases knowledge_base
              WHERE knowledge_base.deleted_at IS NULL
                ${searchPredicate}
              ORDER BY knowledge_base.created_at DESC, knowledge_base.id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapKnowledgeBaseRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeKnowledgeBaseCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async createKnowledgeBase(input) {
        const rows = await sql<KnowledgeBaseRow[]>`
          INSERT INTO focowiki.knowledge_bases (id, name, description)
          VALUES (${createKnowledgeBaseId()}, ${input.name}, ${input.description})
          RETURNING id, name, description, active_generation_id, resource_revision, catalog_generation, created_at, updated_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Knowledge base creation did not return a row");
        }

        return mapKnowledgeBaseRow(row);
      },
      async getKnowledgeBase(id) {
        const rows = await sql<KnowledgeBaseRow[]>`
          SELECT id, name, description, active_generation_id, resource_revision, catalog_generation, created_at, updated_at
          FROM focowiki.knowledge_bases
          WHERE id = ${id} AND deleted_at IS NULL
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapKnowledgeBaseRow(row) : null;
      },
    },
    files: createPostgresSourceFileRepository(sql),
    graph: createPostgresFileGraphRepository(sql),
    modelInvocations: {
      async createModelInvocation(input) {
        const rows = await sql.begin(async (transaction) => {
          const inserted = await transaction<ModelInvocationRow[]>`
            INSERT INTO focowiki.model_invocations (
              id,
              knowledge_base_id,
              source_file_id,
              model_config_id,
              api_mode,
              model_name,
              status,
              started_at,
              ended_at,
              warning_count,
              error_code,
              error_message
            )
            SELECT
              ${input.id ?? createModelInvocationId()},
              ${input.knowledgeBaseId},
              ${input.sourceFileId},
              ${input.modelConfigId ?? null},
              ${input.apiMode ?? null},
              ${input.modelName},
              ${input.status},
              ${input.startedAt},
              ${input.endedAt},
              ${input.warningCount},
              ${input.errorCode},
              ${input.errorMessage}
            FROM focowiki.source_files source
            WHERE source.id = ${input.sourceFileId}
              AND source.knowledge_base_id = ${input.knowledgeBaseId}
              AND source.deleted_at IS NULL
              AND source.deletion_intent_id IS NULL
            RETURNING
              id,
              knowledge_base_id,
              source_file_id,
              model_config_id,
              api_mode,
              model_name,
              status,
              started_at,
              ended_at,
              warning_count,
              error_code,
              error_message,
              created_at
          `;
          const row = inserted[0];

          if (row) {
            await transaction`
              UPDATE focowiki.source_files
              SET
                model_invocation_status = ${row.status},
                model_invocation_model_name = ${row.model_name},
                model_invocation_started_at = ${row.started_at},
                model_invocation_ended_at = ${row.ended_at},
                model_invocation_warning_count = ${row.warning_count},
                model_invocation_error_code = ${row.error_code}
              WHERE knowledge_base_id = ${row.knowledge_base_id}
                AND id = ${row.source_file_id}
                AND deleted_at IS NULL
                AND deletion_intent_id IS NULL
            `;
          }

          return inserted;
        });
        const row = rows[0];

        if (!row) {
          throw new Error("Model invocation creation did not return a row");
        }

        return mapModelInvocationRow(row);
      },
      async completeModelInvocation(input) {
        const rows = await sql.begin(async (transaction) => {
          const updated = await transaction<ModelInvocationRow[]>`
            UPDATE focowiki.model_invocations
            SET
              status = ${input.status},
              ended_at = ${input.endedAt},
              warning_count = ${input.warningCount ?? 0},
              error_code = ${input.errorCode ?? null},
              error_message = ${input.errorMessage ?? null}
            WHERE id = ${input.id}
              AND EXISTS (
                SELECT 1 FROM focowiki.source_files source
                WHERE source.id = focowiki.model_invocations.source_file_id
                  AND source.knowledge_base_id = focowiki.model_invocations.knowledge_base_id
                  AND source.deleted_at IS NULL
                  AND source.deletion_intent_id IS NULL
              )
            RETURNING
              id,
              knowledge_base_id,
              source_file_id,
              model_config_id,
              api_mode,
              model_name,
              status,
              started_at,
              ended_at,
              warning_count,
              error_code,
              error_message,
              created_at
          `;
          const row = updated[0];

          if (row) {
            await transaction`
              UPDATE focowiki.source_files
              SET
                model_invocation_status = ${row.status},
                model_invocation_model_name = ${row.model_name},
                model_invocation_started_at = ${row.started_at},
                model_invocation_ended_at = ${row.ended_at},
                model_invocation_warning_count = ${row.warning_count},
                model_invocation_error_code = ${row.error_code}
              WHERE knowledge_base_id = ${row.knowledge_base_id}
                AND id = ${row.source_file_id}
            `;
          }

          return updated;
        });
        const row = rows[0];
        return row ? mapModelInvocationRow(row) : null;
      }
    },
    securityAudit: {
      async createSecurityAuditEvent(input) {
        await sql`
          INSERT INTO focowiki.admin_audit_events (
            id,
            event_type,
            result,
            error_code,
            username,
            client_ip,
            user_agent,
            origin,
            created_at
          )
          VALUES (
            ${createSecurityAuditEventId()},
            ${input.eventType},
            ${input.result},
            ${input.errorCode},
            ${input.username},
            ${input.clientIp},
            ${input.userAgent},
            ${input.origin},
            ${input.createdAt ?? new Date().toISOString()}
          )
        `;
      }
    },
    publicApiKeys: {
      async countActivePublicOpenApiKeys() {
        const rows = await sql<Array<{ count: string | number }>>`
          SELECT count(*) AS count
          FROM focowiki.public_api_keys
          WHERE status = 'active'
        `;
        return Number(rows[0]?.count ?? 0);
      },
      async listPublicOpenApiKeys({ limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<Array<PublicApiKeyRow & { cursor_timestamp: string }>>`
              SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.public_api_keys
              WHERE status = 'active'
                AND (
                  created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<PublicApiKeyRow & { cursor_timestamp: string }>>`
              SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.public_api_keys
              WHERE status = 'active'
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);

        return {
          items: pageRows.map(mapPublicApiKeyRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async createPublicOpenApiKey(input) {
        const rows = await sql<PublicApiKeyRow[]>`
          INSERT INTO focowiki.public_api_keys (
            id,
            name,
            key_hash,
            key_prefix,
            key_suffix,
            created_at
          )
          VALUES (
            ${input.id},
            ${input.name},
            ${input.keyHash},
            ${input.keyPrefix},
            ${input.keySuffix},
            ${input.createdAt}
          )
          RETURNING id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Public OpenAPI key creation did not return a row");
        }

        return mapPublicApiKeyRow(row);
      },
      async findActivePublicOpenApiKeyByHash(keyHash) {
        const rows = await sql<PublicApiKeyRow[]>`
          SELECT id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
          FROM focowiki.public_api_keys
          WHERE key_hash = ${keyHash}
            AND status = 'active'
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapPublicApiKeyRow(row) : null;
      },
      async revokePublicOpenApiKey({ id, revokedAt }) {
        const rows = await sql<PublicApiKeyRow[]>`
          UPDATE focowiki.public_api_keys
          SET
            status = 'revoked',
            revoked_at = ${revokedAt}
          WHERE id = ${id}
            AND status = 'active'
          RETURNING id, name, key_hash, key_prefix, key_suffix, status, created_at, last_used_at, revoked_at
        `;
        const row = rows[0];
        return row ? mapPublicApiKeyRow(row) : null;
      },
      async updatePublicOpenApiKeyLastUsed({ id, lastUsedAt }) {
        await sql`
          UPDATE focowiki.public_api_keys
          SET last_used_at = ${lastUsedAt}
          WHERE id = ${id}
            AND status = 'active'
        `;
      }
    },
    webhooks: {
      async createWebhookSubscription(input) {
        const rows = await sql<WebhookSubscriptionRow[]>`
          INSERT INTO focowiki.webhook_subscriptions (
            id,
            name,
            url,
            signing_secret,
            events_json,
            created_at,
            updated_at
          )
          VALUES (
            ${input.id},
            ${input.name},
            ${input.url},
            ${input.signingSecret},
            ${sql.json(input.events as never)},
            ${input.createdAt},
            ${input.createdAt}
          )
          RETURNING id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Webhook subscription creation did not return a row");
        }

        return mapWebhookSubscriptionRow(row);
      },
      async getWebhookSubscription(id) {
        const rows = await sql<WebhookSubscriptionRow[]>`
          SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at
          FROM focowiki.webhook_subscriptions
          WHERE id = ${id}
            AND enabled = true
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapWebhookSubscriptionRow(row) : null;
      },
      async listWebhookSubscriptions({ limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<Array<WebhookSubscriptionRow & { cursor_timestamp: string }>>`
              SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.webhook_subscriptions
              WHERE enabled = true
                AND (
                  created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                  OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
                )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<WebhookSubscriptionRow & { cursor_timestamp: string }>>`
              SELECT id, name, url, signing_secret, events_json, enabled, created_at, updated_at, last_delivery_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.webhook_subscriptions
              WHERE enabled = true
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapWebhookSubscriptionRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async deleteWebhookSubscription({ id, updatedAt }) {
        const rows = await sql<Array<{ id: string }>>`
          UPDATE focowiki.webhook_subscriptions
          SET enabled = false, updated_at = ${updatedAt}
          WHERE id = ${id}
            AND enabled = true
          RETURNING id
        `;
        return rows.length > 0;
      },
      async createWebhookDelivery(input) {
        const rows = await sql<WebhookDeliveryRow[]>`
          INSERT INTO focowiki.webhook_deliveries (
            id,
            webhook_id,
            event_id,
            event_type,
            payload_json,
            status,
            attempt_count,
            http_status,
            error_code,
            created_at,
            updated_at
          )
          VALUES (
            ${input.id},
            ${input.webhookId},
            ${input.eventId},
            ${input.eventType},
            ${sql.json(input.payload as never)},
            ${input.status},
            ${input.attemptCount},
            ${input.httpStatus},
            ${input.errorCode},
            ${input.createdAt},
            ${input.createdAt}
          )
          RETURNING id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
        `;
        const row = rows[0];

        if (!row) {
          throw new Error("Webhook delivery creation did not return a row");
        }

        return mapWebhookDeliveryRow(row);
      },
      async updateWebhookDeliveryResult(input) {
        const rows = await sql<WebhookDeliveryRow[]>`
          UPDATE focowiki.webhook_deliveries
          SET status = ${input.status},
              attempt_count = ${input.attemptCount},
              http_status = ${input.httpStatus},
              error_code = ${input.errorCode},
              updated_at = ${input.updatedAt}
          WHERE id = ${input.id}
          RETURNING id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
        `;
        const row = rows[0];
        return row ? mapWebhookDeliveryRow(row) : null;
      },
      async listWebhookDeliveries({ limit, cursor }) {
        const cursorValue = cursor ? parseTimedCursor(cursor) : null;
        const rows = cursorValue
          ? await sql<Array<WebhookDeliveryRow & { cursor_timestamp: string }>>`
              SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.webhook_deliveries
              WHERE (
                created_at < to_timestamp(${cursorValue.createdAt}::double precision / 1000000)
                OR (created_at = to_timestamp(${cursorValue.createdAt}::double precision / 1000000) AND id > ${cursorValue.id})
              )
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `
          : await sql<Array<WebhookDeliveryRow & { cursor_timestamp: string }>>`
              SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at,
                     floor(extract(epoch FROM created_at) * 1000000)::bigint::text AS cursor_timestamp
              FROM focowiki.webhook_deliveries
              ORDER BY created_at DESC, id ASC
              LIMIT ${limit + 1}
            `;
        const pageRows = rows.slice(0, limit);
        const lastRow = pageRows.at(-1);
        return {
          items: pageRows.map(mapWebhookDeliveryRow),
          nextCursor:
            rows.length > limit && lastRow
              ? serializeTimedCursor({
                  createdAt: lastRow.cursor_timestamp,
                  id: lastRow.id
                })
              : null
        };
      },
      async getWebhookDelivery(deliveryId) {
        const rows = await sql<WebhookDeliveryRow[]>`
          SELECT id, webhook_id, event_id, event_type, payload_json, status, attempt_count, http_status, error_code, created_at, updated_at
          FROM focowiki.webhook_deliveries
          WHERE id = ${deliveryId}
          LIMIT 1
        `;
        const row = rows[0];
        return row ? mapWebhookDeliveryRow(row) : null;
      }
    }
  };
}

export function createKnowledgeBaseId(): string {
  return `kb-${randomUUID()}`;
}

export function createSourceFileEventId(): string {
  return `source-event-${randomUUID()}`;
}

export function createModelInvocationId(): string {
  return `model-invocation-${randomUUID()}`;
}

function mapKnowledgeBaseRow(row: KnowledgeBaseRow): KnowledgeBaseRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    activeGenerationId: row.active_generation_id,
    resourceRevision: row.resource_revision,
    catalogGeneration: Number(row.catalog_generation),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function serializeKnowledgeBaseCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseKnowledgeBaseCursor(cursor: string): { createdAt: string; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid knowledge base cursor");
  }

  const candidate = parsed as Record<string, unknown>;

  if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid knowledge base cursor");
  }

  return {
    createdAt: candidate.createdAt,
    id: candidate.id
  };
}

function containsKnowledgeBaseLikePattern(value: string): string {
  return `%${escapeKnowledgeBaseLikePattern(value)}%`;
}

function escapeKnowledgeBaseLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}


function mapModelInvocationRow(row: ModelInvocationRow): ModelInvocationRecord {
  return {
    id: row.id,
    knowledgeBaseId: row.knowledge_base_id,
    sourceFileId: row.source_file_id,
    modelConfigId: row.model_config_id,
    apiMode: row.api_mode,
    modelName: row.model_name,
    status: row.status,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    warningCount: row.warning_count,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at.toISOString()
  };
}


function mapPublicApiKeyRow(row: PublicApiKeyRow): PublicOpenApiKeyRecord {
  return {
    id: row.id,
    name: row.name,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    keySuffix: row.key_suffix,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null
  };
}

function mapWebhookSubscriptionRow(row: WebhookSubscriptionRow): WebhookSubscriptionRecord {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    signingSecret: row.signing_secret,
    events: readStringArray(row.events_json),
    enabled: row.enabled,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    lastDeliveryAt: row.last_delivery_at?.toISOString() ?? null
  };
}

function mapWebhookDeliveryRow(row: WebhookDeliveryRow): WebhookDeliveryRecord {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    eventId: row.event_id,
    eventType: row.event_type,
    payload: readRecord(row.payload_json),
    status: row.status,
    attemptCount: row.attempt_count,
    httpStatus: row.http_status,
    errorCode: row.error_code,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString()
  };
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}


function serializeTimedCursor(cursor: { createdAt: string; id: string }): string {
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function parseTimedCursor(cursor: string): { createdAt: string; id: string } {
  const candidate = parseCursorRecord(cursor);

  if (typeof candidate.createdAt !== "string" || typeof candidate.id !== "string") {
    throw new Error("Invalid timed cursor");
  }

  return {
    createdAt: candidate.createdAt,
    id: candidate.id
  };
}


function parseCursorRecord(cursor: string): Record<string, unknown> {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Invalid cursor");
  }

  return parsed as Record<string, unknown>;
}
