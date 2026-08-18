import type { DatabaseClient } from "../../db/client.js";
import type {
  PublicOpenApiKeyRecord,
  PublicOpenApiKeyRepository
} from "../../public-openapi/keys.js";

type ApiKeyRow = {
  public_id: string;
  key_hash: string;
  key_prefix: string;
  key_suffix: string;
  label: string;
  enabled: boolean;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
};

type ApiKeyCursor = {
  version: 1;
  createdAt: string;
  publicId: string;
};

export function createPostgresStorageVnextApiKeyRepository(
  sql: DatabaseClient
): PublicOpenApiKeyRepository {
  return {
    async listPublicOpenApiKeys(input) {
      const cursor = decodeCursor(input.cursor);
      const rows = await sql<ApiKeyRow[]>`
        SELECT public_id, key_hash, key_prefix, key_suffix, label, enabled,
               created_at, last_used_at, revoked_at
        FROM focowiki.public_api_keys
        WHERE enabled
          AND (
            ${cursor?.createdAt ?? null}::timestamptz IS NULL
            OR created_at < ${cursor?.createdAt ?? null}::timestamptz
            OR (created_at = ${cursor?.createdAt ?? null}::timestamptz
              AND public_id COLLATE "C" > ${cursor?.publicId ?? null}::text COLLATE "C")
          )
        ORDER BY created_at DESC, public_id COLLATE "C"
        LIMIT ${input.limit + 1}
      `;
      const pageRows = rows.slice(0, input.limit);
      const last = pageRows.at(-1);
      return {
        items: pageRows.map(mapRow),
        nextCursor: rows.length > input.limit && last
          ? encodeCursor({
              version: 1,
              createdAt: last.created_at.toISOString(),
              publicId: last.public_id
            })
          : null
      };
    },

    async createPublicOpenApiKey(input) {
      const rows = await sql<ApiKeyRow[]>`
        INSERT INTO focowiki.public_api_keys (
          public_id, key_hash, key_prefix, key_suffix, label, enabled, created_at
        ) VALUES (
          ${input.id}, ${input.keyHash}, ${input.keyPrefix}, ${input.keySuffix},
          ${input.name}, true, ${input.createdAt}
        )
        RETURNING public_id, key_hash, key_prefix, key_suffix, label, enabled,
                  created_at, last_used_at, revoked_at
      `;
      return mapRow(requireRow(rows[0]));
    },

    async findActivePublicOpenApiKeyByHash(keyHash) {
      const rows = await sql<ApiKeyRow[]>`
        SELECT public_id, key_hash, key_prefix, key_suffix, label, enabled,
               created_at, last_used_at, revoked_at
        FROM focowiki.public_api_keys
        WHERE key_hash = ${keyHash} AND enabled
        LIMIT 1
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async revokePublicOpenApiKey(input) {
      const rows = await sql<ApiKeyRow[]>`
        UPDATE focowiki.public_api_keys
        SET enabled = false, revoked_at = ${input.revokedAt}
        WHERE public_id = ${input.id} AND enabled
        RETURNING public_id, key_hash, key_prefix, key_suffix, label, enabled,
                  created_at, last_used_at, revoked_at
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async updatePublicOpenApiKeyLastUsed(input) {
      await sql`
        UPDATE focowiki.public_api_keys
        SET last_used_at = ${input.lastUsedAt}
        WHERE public_id = ${input.id} AND enabled
      `;
    }
  };
}

function mapRow(row: ApiKeyRow): PublicOpenApiKeyRecord {
  return {
    id: row.public_id,
    name: row.label,
    keyHash: row.key_hash,
    keyPrefix: row.key_prefix,
    keySuffix: row.key_suffix,
    status: row.enabled ? "active" : "revoked",
    createdAt: row.created_at.toISOString(),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null
  };
}

function encodeCursor(cursor: ApiKeyCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(value: string | null): ApiKeyCursor | null {
  if (!value) return null;
  const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as ApiKeyCursor;
  if (parsed.version !== 1 || !parsed.createdAt || !parsed.publicId) {
    throw new Error("Invalid storage vNext API key cursor");
  }
  return parsed;
}

function requireRow<T>(row: T | undefined): T {
  if (!row) throw new Error("Storage vNext API key write returned no row");
  return row;
}
