import type { DatabaseClient } from "../../db/client.js";
import {
  validateDocumentDirectoryNavigationMutations,
  type DocumentDirectoryNavigationMutation
} from "../application/document-directory-navigation-mutation.js";

export async function applyPostgresDocumentDirectoryNavigation(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  activationRevision: number;
  mutations: readonly DocumentDirectoryNavigationMutation[];
  activatedAt: string;
}): Promise<void> {
  validateDocumentDirectoryNavigationMutations(input.mutations);
  if (!input.knowledgeBaseId || !Number.isSafeInteger(input.activationRevision)
    || input.activationRevision < 1
    || !Number.isFinite(Date.parse(input.activatedAt))) {
    throw directoryNavigationWriteError("apply_input_invalid");
  }
  const sql = input.transaction;
  const directoryPaths = input.mutations.map((mutation) =>
    mutation.directoryPath);
  const newerLeaves = directoryPaths.length === 0 ? [] : await sql<Array<{
    directory_path: string;
  }>>`
    SELECT leaf.directory_path
    FROM focowiki.generated_directory_leaves leaf
    WHERE leaf.knowledge_base_id = ${input.knowledgeBaseId}
      AND leaf.directory_path IN ${sql(directoryPaths)}
      AND leaf.activation_revision > ${input.activationRevision}
    FOR UPDATE OF leaf
  `;
  const newerDirectories = new Set(newerLeaves.map((leaf) =>
    leaf.directory_path));
  const mutations = input.mutations.filter((mutation) =>
    !newerDirectories.has(mutation.directoryPath));
  const touchedLeaves = mutations.flatMap((mutation) =>
    mutation.touchedLeaves.map((leaf) => ({
      directory_path: mutation.directoryPath,
      leaf_public_id: leaf.id,
      previous_leaf_public_id: leaf.previousLeafId,
      next_leaf_public_id: leaf.nextLeafId,
      first_sort_key: leaf.entries[0]!.sortKey,
      last_sort_key: leaf.entries.at(-1)!.sortKey,
      entry_count: leaf.entries.length,
      revision: leaf.revision,
      changed_at: leaf.changedAt ?? input.activatedAt
    })));
  const affectedLeaves = [...new Map(mutations.flatMap((mutation) => [
    ...mutation.touchedLeaves.map((leaf) => ({
      directory_path: mutation.directoryPath,
      leaf_public_id: leaf.id
    })),
    ...mutation.removedLeafIds.map((leafId) => ({
      directory_path: mutation.directoryPath,
      leaf_public_id: leafId
    }))
  ]).map((leaf) => [
    `${leaf.directory_path}\0${leaf.leaf_public_id}`,
    leaf
  ])).values()];
  const removedLeaves = mutations.flatMap((mutation) =>
    mutation.removedLeafIds.map((leafId) => ({
      directory_path: mutation.directoryPath,
      leaf_public_id: leafId
    })));
  const entries = mutations.flatMap((mutation) =>
    mutation.touchedLeaves.flatMap((leaf) =>
      leaf.entries.map((entry, ordinal) => ({
        directory_path: mutation.directoryPath,
        leaf_public_id: leaf.id,
        entry_public_id: entry.id,
        ordinal,
        sort_key: entry.sortKey,
        name: entry.name,
        target_path: entry.targetPath,
        evidence_path: entry.evidencePath ?? null,
        entry_kind: entry.kind
      }))));
  if (affectedLeaves.length > 0) {
    await sql`
      DELETE FROM focowiki.generated_directory_leaf_entries entry
      USING jsonb_to_recordset(${sql.json(affectedLeaves as never)}::jsonb)
        AS affected(directory_path text, leaf_public_id text)
      WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
        AND entry.directory_path = affected.directory_path
        AND entry.leaf_public_id = affected.leaf_public_id
    `;
  }
  if (removedLeaves.length > 0) {
    await sql`
      DELETE FROM focowiki.generated_directory_leaves leaf
      USING jsonb_to_recordset(${sql.json(removedLeaves as never)}::jsonb)
        AS removed(directory_path text, leaf_public_id text)
      WHERE leaf.knowledge_base_id = ${input.knowledgeBaseId}
        AND leaf.directory_path = removed.directory_path
        AND leaf.leaf_public_id = removed.leaf_public_id
    `;
  }
  if (touchedLeaves.length > 0) {
    await sql`
      INSERT INTO focowiki.generated_directory_leaves (
        knowledge_base_id, directory_path, leaf_public_id,
        previous_leaf_public_id, next_leaf_public_id,
        first_sort_key, last_sort_key, entry_count, revision,
        activation_revision, changed_at, updated_at
      )
      SELECT ${input.knowledgeBaseId}, leaf.directory_path,
             leaf.leaf_public_id, leaf.previous_leaf_public_id,
             leaf.next_leaf_public_id, leaf.first_sort_key,
             leaf.last_sort_key, leaf.entry_count, leaf.revision,
             ${input.activationRevision}, leaf.changed_at, ${input.activatedAt}
      FROM jsonb_to_recordset(${sql.json(touchedLeaves as never)}::jsonb) AS leaf(
        directory_path text, leaf_public_id text,
        previous_leaf_public_id text, next_leaf_public_id text,
        first_sort_key text, last_sort_key text, entry_count integer,
        revision bigint, changed_at timestamptz
      )
      ON CONFLICT (knowledge_base_id, directory_path, leaf_public_id)
      DO UPDATE SET
        previous_leaf_public_id = EXCLUDED.previous_leaf_public_id,
        next_leaf_public_id = EXCLUDED.next_leaf_public_id,
        first_sort_key = EXCLUDED.first_sort_key,
        last_sort_key = EXCLUDED.last_sort_key,
        entry_count = EXCLUDED.entry_count,
        revision = EXCLUDED.revision,
        activation_revision = EXCLUDED.activation_revision,
        changed_at = EXCLUDED.changed_at,
        updated_at = EXCLUDED.updated_at
    `;
  }
  if (entries.length > 0) {
    await sql`
      INSERT INTO focowiki.generated_directory_leaf_entries (
        knowledge_base_id, directory_path, leaf_public_id,
        entry_public_id, ordinal, sort_key, name, target_path,
        evidence_path, entry_kind
      )
      SELECT ${input.knowledgeBaseId}, entry.directory_path,
             entry.leaf_public_id, entry.entry_public_id, entry.ordinal,
             entry.sort_key, entry.name, entry.target_path,
             entry.evidence_path, entry.entry_kind
      FROM jsonb_to_recordset(${sql.json(entries as never)}::jsonb) AS entry(
        directory_path text, leaf_public_id text, entry_public_id text,
        ordinal integer, sort_key text, name text, target_path text,
        evidence_path text, entry_kind text
      )
    `;
  }
  await assertDirectoryNavigationIntegrity(sql, input.knowledgeBaseId,
    [...new Set(mutations.map((mutation) => mutation.directoryPath))]);
}

async function assertDirectoryNavigationIntegrity(
  sql: DatabaseClient,
  knowledgeBaseId: string,
  directoryPaths: readonly string[]
): Promise<void> {
  if (directoryPaths.length === 0) return;
  const invalid = await sql<Array<{ directory_path: string }>>`
    WITH ordered AS (
      SELECT directory_path, leaf_public_id,
             previous_leaf_public_id, next_leaf_public_id,
             lag(leaf_public_id) OVER (
               PARTITION BY directory_path
               ORDER BY first_sort_key COLLATE "C", leaf_public_id COLLATE "C"
             ) AS expected_previous_leaf_public_id,
             lead(leaf_public_id) OVER (
               PARTITION BY directory_path
               ORDER BY first_sort_key COLLATE "C", leaf_public_id COLLATE "C"
             ) AS expected_next_leaf_public_id
      FROM focowiki.generated_directory_leaves
      WHERE knowledge_base_id = ${knowledgeBaseId}
        AND directory_path IN ${sql(directoryPaths)}
    )
    SELECT directory_path
    FROM ordered
    GROUP BY directory_path
    HAVING bool_or(
      previous_leaf_public_id IS DISTINCT FROM
        expected_previous_leaf_public_id
      OR next_leaf_public_id IS DISTINCT FROM expected_next_leaf_public_id
    )
    LIMIT 1
  `;
  if (invalid.length > 0) {
    throw directoryNavigationWriteError("navigation_chain_invalid");
  }
}

function directoryNavigationWriteError(
  code: string
): Error & { code: string } {
  return Object.assign(
    new Error(`Document directory navigation write error: ${code}`),
    { code }
  );
}
