import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentKnowledgeProjectionManifest } from
  "../application/document-knowledge-projection-manifest.js";

export async function lockAndAdvanceScopedOwners(
  sql: DatabaseClient,
  manifest: DocumentKnowledgeProjectionManifest,
  activatedAt: string
): Promise<void> {
  const owners = [...manifest.activationOwners].sort((left, right) =>
    left.kind.localeCompare(right.kind, "en")
      || left.key.localeCompare(right.key, "en"));
  const desired = owners.map((owner) => ({
    kind: owner.kind,
    key: owner.key,
    expected_version: owner.expectedVersion,
    active_source_revision_public_id: owner.activeSourceRevisionPublicId,
    active_page_candidate_public_id: owner.activePageCandidatePublicId,
    public_id: `activation-owner-${createHash("sha256")
      .update(JSON.stringify([manifest.knowledgeBaseId, owner.kind, owner.key]))
      .digest("hex")}`
  }));
  await sql`
    INSERT INTO focowiki.scoped_activation_owners (
      public_id, knowledge_base_id, owner_kind, owner_key, owner_version
    )
    SELECT item.public_id, ${manifest.knowledgeBaseId}, item.kind, item.key, 0
    FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb) AS item(
      public_id text, kind text, key text, expected_version bigint,
      active_source_revision_public_id text,
      active_page_candidate_public_id text
    )
    ON CONFLICT (knowledge_base_id, owner_kind, owner_key) DO NOTHING
  `;
  const locked = await sql<Array<{
    owner_kind: string;
    owner_key: string;
    owner_version: number | string;
  }>>`
    SELECT owner.owner_kind, owner.owner_key, owner.owner_version
    FROM focowiki.scoped_activation_owners owner
    JOIN jsonb_to_recordset(${sql.json(desired as never)}::jsonb) AS item(
      public_id text, kind text, key text, expected_version bigint,
      active_source_revision_public_id text,
      active_page_candidate_public_id text
    ) ON item.kind = owner.owner_kind AND item.key = owner.owner_key
    WHERE owner.knowledge_base_id = ${manifest.knowledgeBaseId}
    ORDER BY owner.owner_kind COLLATE "C", owner.owner_key COLLATE "C"
    FOR UPDATE OF owner
  `;
  if (locked.length !== desired.length) {
    throw scopedActivationError("scoped_activation_conflict");
  }
  const expectedByOwner = new Map(desired.map((owner) => [
    `${owner.kind}\0${owner.key}`,
    owner.expected_version
  ]));
  for (const owner of locked) {
    if (Number(owner.owner_version) !== expectedByOwner.get(
      `${owner.owner_kind}\0${owner.owner_key}`)) {
      throw scopedActivationError("scoped_activation_conflict");
    }
  }
  const updated = await sql<Array<{ public_id: string }>>`
    UPDATE focowiki.scoped_activation_owners owner
    SET owner_version = owner.owner_version + 1,
        active_source_revision_public_id
          = item.active_source_revision_public_id,
        active_page_candidate_public_id
          = item.active_page_candidate_public_id,
        updated_at = ${activatedAt}
    FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb) AS item(
      public_id text, kind text, key text, expected_version bigint,
      active_source_revision_public_id text,
      active_page_candidate_public_id text
    )
    WHERE owner.knowledge_base_id = ${manifest.knowledgeBaseId}
      AND owner.owner_kind = item.kind AND owner.owner_key = item.key
      AND owner.owner_version = item.expected_version
    RETURNING owner.public_id
  `;
  if (updated.length !== desired.length) {
    throw scopedActivationError("scoped_activation_conflict");
  }
  await sql`
    INSERT INTO focowiki.knowledge_base_sequences (
      knowledge_base_id, current_sequence, updated_at
    ) VALUES (
      ${manifest.knowledgeBaseId}, ${manifest.readinessSequence}, ${activatedAt}
    ) ON CONFLICT (knowledge_base_id) DO UPDATE
    SET current_sequence = greatest(
          focowiki.knowledge_base_sequences.current_sequence,
          excluded.current_sequence
        ), updated_at = excluded.updated_at
  `;
}

function scopedActivationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document fixed activation error: ${code}`), {
    code
  });
}
