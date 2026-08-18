import { createHash } from "node:crypto";
import type { TransactionSql } from "postgres";
import type { DatabaseClient } from "../../db/client.js";
import {
  assertRepositoryIdentity,
  repositoryContractError
} from "./document-repository-validation.js";

export const SCOPED_ACTIVATION_OWNER_KINDS = [
  "source",
  "relation_pair",
  "directory_leaf",
  "directory_entry",
  "search_family",
  "page_head"
] as const;
export type ScopedActivationOwnerKind =
  (typeof SCOPED_ACTIVATION_OWNER_KINDS)[number];

export type ScopedActivationOwner = {
  kind: ScopedActivationOwnerKind;
  key: string;
};

export function sortScopedActivationOwners(
  owners: readonly ScopedActivationOwner[]
): ScopedActivationOwner[] {
  const normalized = owners.map((owner) => {
    if (!SCOPED_ACTIVATION_OWNER_KINDS.includes(owner.kind)) {
      throw repositoryContractError("invalid_owner_kind");
    }
    const key = owner.key.normalize("NFKC").trim();
    if (!key || Buffer.byteLength(key, "utf8") > 2_048) {
      throw repositoryContractError("invalid_owner_key");
    }
    return { kind: owner.kind, key };
  });
  return [...new Map(normalized
    .sort((left, right) => left.kind.localeCompare(right.kind, "en")
      || left.key.localeCompare(right.key, "en"))
    .map((owner) => [`${owner.kind}\0${owner.key}`, owner])).values()];
}

export function createPostgresScopedActivationOwnerRepository(sql: DatabaseClient) {
  return {
    async readVersions(input: {
      knowledgeBaseId: string;
      owners: readonly ScopedActivationOwner[];
    }): Promise<ReadonlyArray<ScopedActivationOwner & {
      version: number;
      updatedAt: string | null;
    }>> {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const owners = sortScopedActivationOwners(input.owners);
      if (owners.length < 1 || owners.length !== input.owners.length) {
        throw repositoryContractError("invalid_activation_owners");
      }
      const rows = await sql<Array<{
        owner_kind: ScopedActivationOwnerKind;
        owner_key: string;
        owner_version: number | string;
        owner_updated_at: Date | string | null;
      }>>`
        SELECT desired.kind AS owner_kind, desired.key AS owner_key,
               coalesce(owner.owner_version, 0) AS owner_version,
               owner.updated_at AS owner_updated_at
        FROM jsonb_to_recordset(${sql.json(owners as never)}::jsonb) AS desired(
          kind text, key text
        )
        LEFT JOIN focowiki.scoped_activation_owners owner
          ON owner.knowledge_base_id = ${knowledgeBaseId}
         AND owner.owner_kind = desired.kind
         AND owner.owner_key = desired.key
        ORDER BY desired.kind COLLATE "C", desired.key COLLATE "C"
      `;
      return rows.map((row) => ({
        kind: row.owner_kind,
        key: row.owner_key,
        version: Number(row.owner_version),
        updatedAt: row.owner_updated_at
          ? new Date(row.owner_updated_at).toISOString() : null
      }));
    },

    async activate(input: {
      knowledgeBaseId: string;
      owners: ReadonlyArray<ScopedActivationOwner & {
        expectedVersion: number;
        activeSourceRevisionPublicId: string | null;
        activePageCandidatePublicId: string | null;
      }>;
      readinessSequence: number;
      now: string;
    }): Promise<
      | { status: "activated"; sequence: number }
      | { status: "conflict"; owner: ScopedActivationOwner; actualVersion: number }
    > {
      const knowledgeBaseId = assertRepositoryIdentity(
        input.knowledgeBaseId,
        "knowledge_base_id"
      );
      const byIdentity = new Map(input.owners.map((owner) => [
        `${owner.kind}\0${owner.key}`,
        owner
      ]));
      const owners = sortScopedActivationOwners(input.owners).map((owner) => ({
        ...owner,
        ...byIdentity.get(`${owner.kind}\0${owner.key}`)!
      }));
      if (owners.length === 0 || owners.length !== input.owners.length) {
        throw repositoryContractError("invalid_activation_owners");
      }
      for (const owner of owners) {
        if (!Number.isSafeInteger(owner.expectedVersion) || owner.expectedVersion < 0) {
          throw repositoryContractError("invalid_owner_version");
        }
      }
      if (!Number.isSafeInteger(input.readinessSequence)
        || input.readinessSequence < 1) {
        throw repositoryContractError("invalid_readiness_sequence");
      }
      return transaction(sql, async (tx) => {
        for (const owner of owners) {
          const digest = createHash("sha256").update(JSON.stringify([
            knowledgeBaseId, owner.kind, owner.key
          ])).digest("hex");
          await tx`
            INSERT INTO focowiki.scoped_activation_owners (
              public_id, knowledge_base_id, owner_kind, owner_key, owner_version
            ) VALUES (
              ${`activation-owner-${digest}`}, ${knowledgeBaseId},
              ${owner.kind}, ${owner.key}, 0
            )
            ON CONFLICT (knowledge_base_id, owner_kind, owner_key) DO NOTHING
          `;
        }
        for (const owner of owners) {
          const rows = await tx<Array<{ owner_version: number | string }>>`
            SELECT owner_version
            FROM focowiki.scoped_activation_owners
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND owner_kind = ${owner.kind} AND owner_key = ${owner.key}
            FOR UPDATE
          `;
          const actualVersion = Number(rows[0]?.owner_version ?? -1);
          if (actualVersion !== owner.expectedVersion) {
            return {
              status: "conflict" as const,
              owner: { kind: owner.kind, key: owner.key },
              actualVersion
            };
          }
        }
        const sequenceRows = await tx<Array<{ current_sequence: number | string }>>`
          INSERT INTO focowiki.knowledge_base_sequences (
            knowledge_base_id, current_sequence, updated_at
          ) VALUES (${knowledgeBaseId}, ${input.readinessSequence}, ${input.now})
          ON CONFLICT (knowledge_base_id) DO UPDATE
          SET current_sequence = greatest(
                knowledge_base_sequences.current_sequence,
                excluded.current_sequence
              ),
              updated_at = excluded.updated_at
          RETURNING current_sequence
        `;
        const sequence = Number(sequenceRows[0]!.current_sequence);
        for (const owner of owners) {
          await tx`
            UPDATE focowiki.scoped_activation_owners
            SET owner_version = owner_version + 1,
                active_source_revision_public_id = ${owner.activeSourceRevisionPublicId},
                active_page_candidate_public_id = ${owner.activePageCandidatePublicId},
                updated_at = ${input.now}
            WHERE knowledge_base_id = ${knowledgeBaseId}
              AND owner_kind = ${owner.kind} AND owner_key = ${owner.key}
              AND owner_version = ${owner.expectedVersion}
          `;
        }
        return { status: "activated" as const, sequence };
      });
    }
  };
}

export async function bumpPostgresScopedActivationOwners(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  owners: readonly ScopedActivationOwner[];
  now: string;
}): Promise<void> {
  const knowledgeBaseId = assertRepositoryIdentity(
    input.knowledgeBaseId,
    "knowledge_base_id"
  );
  const owners = sortScopedActivationOwners(input.owners);
  for (const owner of owners) {
    const publicId = `activation-owner-${createHash("sha256")
      .update(JSON.stringify([knowledgeBaseId, owner.kind, owner.key]))
      .digest("hex")}`;
    await input.transaction`
      INSERT INTO focowiki.scoped_activation_owners (
        public_id, knowledge_base_id, owner_kind, owner_key, owner_version
      ) VALUES (
        ${publicId}, ${knowledgeBaseId}, ${owner.kind}, ${owner.key}, 0
      ) ON CONFLICT (knowledge_base_id, owner_kind, owner_key) DO NOTHING
    `;
  }
  for (const owner of owners) {
    await input.transaction`
      SELECT owner_version
      FROM focowiki.scoped_activation_owners
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND owner_kind = ${owner.kind} AND owner_key = ${owner.key}
      FOR UPDATE
    `;
  }
  for (const owner of owners) {
    await input.transaction`
      UPDATE focowiki.scoped_activation_owners
      SET owner_version = owner_version + 1, updated_at = ${input.now}
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND owner_kind = ${owner.kind} AND owner_key = ${owner.key}
    `;
  }
}

function transaction<T>(
  sql: DatabaseClient,
  callback: (transactionSql: TransactionSql) => Promise<T>
): Promise<T> {
  return typeof sql.begin === "function"
    ? sql.begin(callback as never) as Promise<T>
    : callback(sql as unknown as TransactionSql);
}
