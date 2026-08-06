import type { DatabaseClient } from "../../db/client.js";
import type {
  StorageVnextAuditPort,
  StorageVnextAuditResult,
  StorageVnextSecurityAuditEvent
} from "./ports.js";

export type StorageVnextAuditRepositoryErrorCode =
  | "invalid_input"
  | "invalid_cursor"
  | "event_conflict";

export class StorageVnextAuditRepositoryError extends Error {
  public constructor(public readonly code: StorageVnextAuditRepositoryErrorCode) {
    super(`Storage vNext audit repository error: ${code}`);
    this.name = "StorageVnextAuditRepositoryError";
  }
}

type AuditRow = {
  public_id: string;
  knowledge_base_id: string | null;
  actor_public_id: string | null;
  event_type: string;
  target_kind: string | null;
  target_public_id: string | null;
  result: StorageVnextAuditResult;
  reason_code: string | null;
  source_ip: string | null;
  user_agent: string | null;
  metadata: Record<string, boolean | number | string | null>;
  created_at: Date | string;
  expires_at: Date | string;
};

type AuditCursor = {
  version: 1;
  scope: {
    knowledgeBaseId: string | null;
    eventType: string | null;
    result: StorageVnextAuditResult | null;
    createdAfter: string | null;
    createdBefore: string | null;
  };
  createdAt: string;
  publicId: string;
};

const AUDIT_RESULTS: readonly StorageVnextAuditResult[] = [
  "success",
  "failure",
  "blocked"
];
const FORBIDDEN_METADATA_KEY =
  /(?:secret|token|password|credential|api.?key|body|prompt|sql|object.?key|local.?path)/iu;

export function createPostgresStorageVnextAuditRepository(
  sql: DatabaseClient
): StorageVnextAuditPort {
  return {
    async append(event) {
      assertAuditEvent(event);
      const inserted = await sql<Array<{ public_id: string }>>`
        INSERT INTO focowiki.security_audit_events
          (public_id, knowledge_base_id, actor_public_id, event_type,
           target_kind, target_public_id, result, reason_code, source_ip,
           user_agent, metadata, created_at, expires_at)
        VALUES
          (${event.publicId}, ${event.knowledgeBaseId}, ${event.actorPublicId},
           ${event.eventType}, ${event.targetKind}, ${event.targetPublicId},
           ${event.result}, ${event.reasonCode}, ${event.sourceIp}, ${event.userAgent},
           ${sql.json(event.metadata)}, ${event.createdAt}, ${event.expiresAt})
        ON CONFLICT (created_at, public_id) DO NOTHING
        RETURNING public_id
      `;
      if (inserted.length === 1) return;

      const existingRows = await sql<AuditRow[]>`
        SELECT public_id, knowledge_base_id, actor_public_id, event_type,
               target_kind, target_public_id, result, reason_code,
               host(source_ip) AS source_ip, user_agent, metadata,
               created_at, expires_at
        FROM focowiki.security_audit_events
        WHERE created_at = ${event.createdAt}
          AND public_id = ${event.publicId}
        LIMIT 1
      `;
      if (!existingRows[0] || !sameAuditEvent(mapAudit(existingRows[0]), event)) {
        throw auditError("event_conflict");
      }
    },

    async list(input) {
      assertOptionalIdentifier(input.knowledgeBaseId, 255);
      assertOptionalIdentifier(input.eventType, 128);
      if (input.result !== null && !AUDIT_RESULTS.includes(input.result)) {
        throw auditError("invalid_input");
      }
      if (input.createdAfter !== null) assertTimestamp(input.createdAfter);
      if (input.createdBefore !== null) assertTimestamp(input.createdBefore);
      if (
        input.createdAfter !== null
        && input.createdBefore !== null
        && Date.parse(input.createdAfter) >= Date.parse(input.createdBefore)
      ) {
        throw auditError("invalid_input");
      }
      const limit = assertLimit(input.limit);
      const scope = {
        knowledgeBaseId: input.knowledgeBaseId,
        eventType: input.eventType,
        result: input.result,
        createdAfter: input.createdAfter,
        createdBefore: input.createdBefore
      };
      const cursor = decodeAuditCursor(input.cursor, scope);
      const rows = await sql<AuditRow[]>`
        SELECT public_id, knowledge_base_id, actor_public_id, event_type,
               target_kind, target_public_id, result, reason_code,
               host(source_ip) AS source_ip, user_agent, metadata,
               created_at, expires_at
        FROM focowiki.security_audit_events
        WHERE (${input.knowledgeBaseId}::text IS NULL
               OR knowledge_base_id = ${input.knowledgeBaseId})
          AND (${input.eventType}::text IS NULL OR event_type = ${input.eventType})
          AND (${input.result}::text IS NULL OR result = ${input.result})
          AND (${input.createdAfter}::timestamptz IS NULL
               OR created_at >= ${input.createdAfter})
          AND (${input.createdBefore}::timestamptz IS NULL
               OR created_at < ${input.createdBefore})
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR (created_at, public_id) <
               (${cursor?.createdAt ?? null}::timestamptz,
                ${cursor?.publicId ?? null}::text)
          )
        ORDER BY created_at DESC, public_id DESC
        LIMIT ${limit + 1}
      `;
      const items = rows.slice(0, limit).map(mapAudit);
      const last = items.at(-1);
      return {
        items,
        nextCursor: rows.length > limit && last
          ? encodeAuditCursor({
              version: 1,
              scope,
              createdAt: last.createdAt,
              publicId: last.publicId
            })
          : null
      };
    }
  };
}

function mapAudit(row: AuditRow): StorageVnextSecurityAuditEvent {
  if (!AUDIT_RESULTS.includes(row.result)) throw auditError("event_conflict");
  return {
    publicId: row.public_id,
    knowledgeBaseId: row.knowledge_base_id,
    actorPublicId: row.actor_public_id,
    eventType: row.event_type,
    targetKind: row.target_kind,
    targetPublicId: row.target_public_id,
    result: row.result,
    reasonCode: row.reason_code,
    sourceIp: row.source_ip,
    userAgent: row.user_agent,
    metadata: row.metadata,
    createdAt: timestamp(row.created_at),
    expiresAt: timestamp(row.expires_at)
  };
}

function assertAuditEvent(event: StorageVnextSecurityAuditEvent): void {
  assertIdentifier(event.publicId, 255);
  assertOptionalIdentifier(event.knowledgeBaseId, 255);
  assertOptionalIdentifier(event.actorPublicId, 255);
  assertIdentifier(event.eventType, 128);
  if ((event.targetKind === null) !== (event.targetPublicId === null)) {
    throw auditError("invalid_input");
  }
  assertOptionalIdentifier(event.targetKind, 128);
  assertOptionalIdentifier(event.targetPublicId, 255);
  if (!AUDIT_RESULTS.includes(event.result)) throw auditError("invalid_input");
  assertOptionalIdentifier(event.reasonCode, 128);
  if (event.sourceIp !== null && event.sourceIp.length > 64) {
    throw auditError("invalid_input");
  }
  if (event.userAgent !== null && Buffer.byteLength(event.userAgent, "utf8") > 1_024) {
    throw auditError("invalid_input");
  }
  assertSafeMetadata(event.metadata);
  const createdAt = assertTimestamp(event.createdAt);
  const expiresAt = assertTimestamp(event.expiresAt);
  if (expiresAt.getTime() <= createdAt.getTime()) throw auditError("invalid_input");
}

function assertSafeMetadata(
  metadata: Record<string, boolean | number | string | null>
): void {
  if (
    Array.isArray(metadata)
    || metadata === null
    || Buffer.byteLength(JSON.stringify(metadata), "utf8") > 16_384
  ) {
    throw auditError("invalid_input");
  }
  for (const [key, value] of Object.entries(metadata)) {
    if (
      key.length === 0
      || Buffer.byteLength(key, "utf8") > 128
      || FORBIDDEN_METADATA_KEY.test(key)
      || (typeof value === "string" && Buffer.byteLength(value, "utf8") > 2_048)
      || (typeof value === "number" && !Number.isFinite(value))
    ) {
      throw auditError("invalid_input");
    }
  }
}

function sameAuditEvent(
  left: StorageVnextSecurityAuditEvent,
  right: StorageVnextSecurityAuditEvent
): boolean {
  return left.publicId === right.publicId
    && left.knowledgeBaseId === right.knowledgeBaseId
    && left.actorPublicId === right.actorPublicId
    && left.eventType === right.eventType
    && left.targetKind === right.targetKind
    && left.targetPublicId === right.targetPublicId
    && left.result === right.result
    && left.reasonCode === right.reasonCode
    && left.sourceIp === right.sourceIp
    && left.userAgent === right.userAgent
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt
    && stableMetadata(left.metadata) === stableMetadata(right.metadata);
}

function assertLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw auditError("invalid_input");
  }
  return limit;
}

function assertIdentifier(value: string, maxBytes: number): void {
  if (value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw auditError("invalid_input");
  }
}

function assertOptionalIdentifier(value: string | null, maxBytes: number): void {
  if (value !== null) assertIdentifier(value, maxBytes);
}

function assertTimestamp(value: string): Date {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw auditError("invalid_input");
  }
  return parsed;
}

function timestamp(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw auditError("event_conflict");
  return parsed.toISOString();
}

function stableMetadata(value: Record<string, boolean | number | string | null>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right, "en")
  )));
}

function encodeAuditCursor(cursor: AuditCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeAuditCursor(
  value: string | null,
  scope: AuditCursor["scope"]
): AuditCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as AuditCursor;
    if (
      parsed.version !== 1
      || JSON.stringify(parsed.scope) !== JSON.stringify(scope)
      || typeof parsed.publicId !== "string"
      || typeof parsed.createdAt !== "string"
    ) {
      throw auditError("invalid_cursor");
    }
    assertTimestamp(parsed.createdAt);
    assertIdentifier(parsed.publicId, 255);
    return parsed;
  } catch (error) {
    if (error instanceof StorageVnextAuditRepositoryError) throw error;
    throw auditError("invalid_cursor");
  }
}

function auditError(
  code: StorageVnextAuditRepositoryErrorCode
): StorageVnextAuditRepositoryError {
  return new StorageVnextAuditRepositoryError(code);
}
