import type { DatabaseClient } from "../../db/client.js";
import { assertRepositoryIdentity, repositoryContractError } from
  "./document-repository-validation.js";

export function createPostgresDocumentScopeSnapshotMemberRepository(
  sql: DatabaseClient
) {
  return {
    async persistSnapshotMembers(input: {
      scopeGenerationPublicId: string;
      members: readonly {
        kind: string;
        publicId: string;
        version: string;
        order: number;
      }[];
    }): Promise<number> {
      const records = validateMembers(input.members);
      return sql.begin(async (transaction) => {
        const waiting = await transaction<Array<{ public_id: string }>>`
          SELECT public_id FROM focowiki.projection_scope_generations
          WHERE public_id = ${assertRepositoryIdentity(
            input.scopeGenerationPublicId,
            "scope_generation_public_id"
          )} AND state = 'waiting'
          FOR UPDATE
        `;
        if (!waiting[0]) {
          throw repositoryContractError("scope_snapshot_not_mutable");
        }
        const rows = await transaction<Array<{ member_public_id: string }>>`
          INSERT INTO focowiki.projection_scope_snapshot_members (
            scope_generation_public_id, member_kind, member_public_id,
            member_version, member_order
          )
          SELECT ${input.scopeGenerationPublicId}, desired.member_kind,
                 desired.member_public_id, desired.member_version,
                 desired.member_order
          FROM jsonb_to_recordset(${transaction.json(records as never)}::jsonb)
            AS desired(
              member_kind text, member_public_id text,
              member_version text, member_order integer
            )
          ON CONFLICT (
            scope_generation_public_id, member_kind, member_public_id
          ) DO UPDATE SET member_version = excluded.member_version
          WHERE projection_scope_snapshot_members.member_version
                  = excluded.member_version
            AND projection_scope_snapshot_members.member_order
                  = excluded.member_order
          RETURNING member_public_id
        `;
        if (rows.length !== records.length) {
          throw repositoryContractError("scope_snapshot_member_conflict");
        }
        return rows.length;
      }) as Promise<number>;
    }
  };
}

function validateMembers(input: readonly {
  kind: string;
  publicId: string;
  version: string;
  order: number;
}[]) {
  if (input.length > 10_000) {
    throw repositoryContractError("scope_snapshot_member_limit");
  }
  const records = input.map((member) => ({
    member_kind: member.kind,
    member_public_id: assertRepositoryIdentity(member.publicId, "member_public_id"),
    member_version: assertRepositoryIdentity(member.version, "member_version"),
    member_order: member.order
  }));
  if (new Set(records.map((item) => item.member_order)).size !== records.length
    || records.some((item) => !Number.isSafeInteger(item.member_order)
      || item.member_order < 0)) {
    throw repositoryContractError("scope_snapshot_member_order_invalid");
  }
  return records;
}
