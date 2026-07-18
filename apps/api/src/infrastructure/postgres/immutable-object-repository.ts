import type {
  ImmutableObjectRecord,
  ImmutableObjectRepository
} from "../../application/ports/immutable-object-repository.js";
import type { DatabaseClient } from "../../db/client.js";

type ImmutableObjectRow = {
  checksum_sha256: string;
  format_version: number;
  object_key: string;
  content_type: string;
  size_bytes: number;
  created_at: Date;
  verified_at: Date;
};

export function createPostgresImmutableObjectRepository(
  sql: DatabaseClient
): ImmutableObjectRepository {
  return {
    async find(input) {
      const rows = await sql<ImmutableObjectRow[]>`
        SELECT checksum_sha256, format_version, object_key, content_type,
               size_bytes, created_at, verified_at
        FROM focowiki.immutable_objects
        WHERE checksum_sha256 = ${input.checksumSha256}
          AND format_version = ${input.formatVersion}
          AND lifecycle_state = 'active'
      `;
      return rows[0] ? mapRow(rows[0]) : null;
    },

    async register(input) {
      const rows = await sql<ImmutableObjectRow[]>`
        INSERT INTO focowiki.immutable_objects (
          checksum_sha256, format_version, object_key, content_type,
          size_bytes, verified_at
        ) VALUES (
          ${input.checksumSha256}, ${input.formatVersion}, ${input.objectKey},
          ${input.contentType}, ${input.sizeBytes}, ${input.verifiedAt}
        )
        ON CONFLICT (checksum_sha256, format_version) DO UPDATE
        SET verified_at = greatest(focowiki.immutable_objects.verified_at, EXCLUDED.verified_at)
        WHERE focowiki.immutable_objects.object_key = EXCLUDED.object_key
          AND focowiki.immutable_objects.content_type = EXCLUDED.content_type
          AND focowiki.immutable_objects.size_bytes = EXCLUDED.size_bytes
          AND focowiki.immutable_objects.lifecycle_state = 'active'
        RETURNING checksum_sha256, format_version, object_key, content_type,
                  size_bytes, created_at, verified_at
      `;
      if (!rows[0]) {
        throw new Error("Immutable object identity conflicts with registered metadata");
      }
      return mapRow(rows[0]);
    }
  };
}

function mapRow(row: ImmutableObjectRow): ImmutableObjectRecord {
  return {
    checksumSha256: row.checksum_sha256,
    formatVersion: row.format_version,
    objectKey: row.object_key,
    contentType: row.content_type,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at.toISOString(),
    verifiedAt: row.verified_at.toISOString()
  };
}
