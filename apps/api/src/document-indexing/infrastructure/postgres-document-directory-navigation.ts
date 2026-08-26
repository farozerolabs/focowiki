import type { DatabaseClient } from "../../db/client.js";
import type { PersistentDirectoryLeaf } from
  "../../application/ports/directory-navigation-repository.js";
import {
  validateDocumentDirectoryNavigationMutations,
  type DocumentDirectoryNavigationMutation
} from "../application/document-directory-navigation-mutation.js";
import type { DocumentDirectoryNavigationChange } from
  "../application/document-directory-navigation-state.js";
import { partitionDocumentDirectoryNavigationWindows } from
  "../application/document-directory-navigation-windows.js";
import type { OrderedDirectoryEntry } from
  "../domain/document-directory-leaves.js";

type LeafRow = {
  leaf_public_id: string;
  previous_leaf_public_id: string | null;
  next_leaf_public_id: string | null;
  revision: number | string;
  changed_at: Date | null;
};

type EntryRow = {
  leaf_public_id: string;
  entry_public_id: string;
  sort_key: string;
  name: string;
  target_path: string;
  evidence_path: string | null;
  entry_kind: "file" | "directory";
};

export function createPostgresDocumentDirectoryNavigation(sql: DatabaseClient) {
  return {
    async read(input: {
      knowledgeBaseId: string;
      directoryPath: string;
      maximumLeaves: number;
      maximumEntries: number;
    }): Promise<readonly PersistentDirectoryLeaf[]> {
      validateRead(input);
      const leaves = await sql<LeafRow[]>`
        SELECT leaf_public_id, previous_leaf_public_id,
               next_leaf_public_id, revision, changed_at
        FROM focowiki.generated_directory_leaves
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND directory_path = ${input.directoryPath}
        ORDER BY first_sort_key COLLATE "C", leaf_public_id COLLATE "C"
        LIMIT ${input.maximumLeaves + 1}
      `;
      if (leaves.length > input.maximumLeaves) {
        throw directoryNavigationError("leaf_limit_exceeded");
      }
      if (leaves.length === 0) return [];
      const entries = await sql<EntryRow[]>`
        SELECT leaf_public_id, entry_public_id, sort_key, name,
               target_path, evidence_path, entry_kind
        FROM focowiki.generated_directory_leaf_entries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND directory_path = ${input.directoryPath}
          AND leaf_public_id IN ${sql(leaves.map((leaf) => leaf.leaf_public_id))}
        ORDER BY leaf_public_id COLLATE "C", ordinal
        LIMIT ${input.maximumEntries + 1}
      `;
      if (entries.length > input.maximumEntries) {
        throw directoryNavigationError("entry_limit_exceeded");
      }
      const byLeaf = new Map<string, PersistentDirectoryLeaf["entries"]>();
      for (const entry of entries) {
        const values = byLeaf.get(entry.leaf_public_id) ?? [];
        values.push({
          id: entry.entry_public_id,
          sortKey: entry.sort_key,
          name: entry.name,
          targetPath: entry.target_path,
          ...(entry.evidence_path ? { evidencePath: entry.evidence_path } : {}),
          kind: entry.entry_kind
        });
        byLeaf.set(entry.leaf_public_id, values);
      }
      return leaves.map((leaf) => ({
        id: leaf.leaf_public_id,
        previousLeafId: leaf.previous_leaf_public_id,
        nextLeafId: leaf.next_leaf_public_id,
        entries: byLeaf.get(leaf.leaf_public_id) ?? [],
        revision: Number(leaf.revision),
        ...(leaf.changed_at ? { changedAt: leaf.changed_at.toISOString() } : {})
      }));
    },

    async readDelta(input: {
      knowledgeBaseId: string;
      directoryPath: string;
      desiredEntries: readonly OrderedDirectoryEntry[];
      candidateEntryIds?: readonly string[];
      maximumChanges: number;
      maximumLeaves: number;
      maximumEntries: number;
    }): Promise<({
      mode: "full"; leaves: readonly PersistentDirectoryLeaf[];
    } | {
      mode: "window"; leaves: readonly PersistentDirectoryLeaf[];
    } | { mode: "windows";
      windows: readonly (readonly PersistentDirectoryLeaf[])[]; }) & {
      changes: readonly DocumentDirectoryNavigationChange[];
      totalEntryCount: number;
      firstLeafId: string | null;
      rootExists: boolean;
    }> {
      validateRead({
        knowledgeBaseId: input.knowledgeBaseId,
        directoryPath: input.directoryPath,
        maximumLeaves: input.maximumLeaves,
        maximumEntries: input.maximumEntries
      });
      if (!Number.isSafeInteger(input.maximumChanges)
        || input.maximumChanges < 1 || input.maximumChanges > 100_000
        || input.desiredEntries.length > input.maximumEntries) {
        throw directoryNavigationError("delta_read_input_invalid");
      }
      const candidateEntryIds = input.candidateEntryIds
        ? [...new Set(input.candidateEntryIds)].sort() : null;
      if (candidateEntryIds && (candidateEntryIds.length > 100_000
        || candidateEntryIds.some((entryId) => !entryId))) {
        throw directoryNavigationError("delta_candidate_input_invalid");
      }
      const desired = input.desiredEntries.map((entry) => ({
        entry_public_id: entry.id,
        sort_key: entry.sortKey,
        name: entry.name,
        target_path: entry.targetPath,
        evidence_path: entry.evidencePath ?? null,
        entry_kind: entry.kind
      }));
      const changed = await sql<Array<{
        entry_public_id: string;
        existing_leaf_public_id: string | null;
        existing_sort_key: string | null;
        desired_sort_key: string | null;
        desired_name: string | null;
        desired_target_path: string | null;
        desired_evidence_path: string | null;
        desired_entry_kind: "file" | "directory" | null;
      }>>`
        WITH desired AS MATERIALIZED (
          SELECT entry_public_id, sort_key, name, target_path,
                 evidence_path, entry_kind
          FROM jsonb_to_recordset(${sql.json(desired as never)}::jsonb)
            AS desired(
              entry_public_id text, sort_key text, name text,
              target_path text, evidence_path text, entry_kind text
            )
        ), existing AS MATERIALIZED (
          SELECT entry.leaf_public_id, entry.entry_public_id,
                 entry.sort_key, entry.name, entry.target_path,
                 entry.evidence_path, entry.entry_kind
          FROM focowiki.generated_directory_leaf_entries entry
          WHERE entry.knowledge_base_id = ${input.knowledgeBaseId}
            AND entry.directory_path = ${input.directoryPath}
            AND (${candidateEntryIds === null}
              OR entry.entry_public_id
                   = ANY(${candidateEntryIds ?? []}::text[]))
        )
        SELECT coalesce(existing.entry_public_id, desired.entry_public_id)
                 AS entry_public_id,
               existing.leaf_public_id AS existing_leaf_public_id,
               existing.sort_key AS existing_sort_key,
               desired.sort_key AS desired_sort_key,
               desired.name AS desired_name,
               desired.target_path AS desired_target_path,
               desired.evidence_path AS desired_evidence_path,
               desired.entry_kind AS desired_entry_kind
        FROM existing
        FULL OUTER JOIN desired
          ON desired.entry_public_id = existing.entry_public_id
        WHERE existing.entry_public_id IS NULL
           OR desired.entry_public_id IS NULL
           OR ROW(
             existing.sort_key, existing.name, existing.target_path,
             existing.evidence_path, existing.entry_kind
           ) IS DISTINCT FROM ROW(
             desired.sort_key, desired.name, desired.target_path,
             desired.evidence_path, desired.entry_kind
           )
        ORDER BY coalesce(existing.entry_public_id, desired.entry_public_id)
                   COLLATE "C"
        LIMIT ${input.maximumChanges + 1}
      `;
      if (changed.length > input.maximumChanges) {
        return {
          mode: "full", leaves: [], changes: [],
          totalEntryCount: 0, firstLeafId: null, rootExists: false
        };
      }
      const summaries = await sql<Array<{
        total_entry_count: number | string;
        first_leaf_public_id: string | null;
        root_exists: boolean;
      }>>`
        SELECT coalesce(sum(entry_count), 0) AS total_entry_count,
               (array_agg(leaf_public_id ORDER BY first_sort_key COLLATE "C",
                  leaf_public_id COLLATE "C"))[1] AS first_leaf_public_id,
               EXISTS (
                 SELECT 1 FROM focowiki.generated_page_heads head
                 WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
                   AND head.normalized_path
                         = lower(${`${input.directoryPath}/index.md`})
               ) AS root_exists
        FROM focowiki.generated_directory_leaves leaf
        WHERE leaf.knowledge_base_id = ${input.knowledgeBaseId}
          AND leaf.directory_path = ${input.directoryPath}
      `;
      const summary = summaries[0]!;
      if (changed.length === 0) {
        return {
          mode: "window", leaves: [], changes: [],
          totalEntryCount: Number(summary.total_entry_count),
          firstLeafId: summary.first_leaf_public_id,
          rootExists: summary.root_exists
        };
      }
      const existingLeafIds = changed.flatMap((row) =>
        row.existing_leaf_public_id ? [row.existing_leaf_public_id] : []);
      const desiredSortKeys = changed.flatMap((row) =>
        row.desired_sort_key ? [row.desired_sort_key] : []);
      const insertionRows = desiredSortKeys.length === 0 ? []
        : await sql<Array<{ leaf_public_id: string }>>`
            SELECT DISTINCT selected.leaf_public_id COLLATE "C"
                   AS leaf_public_id
            FROM unnest(${desiredSortKeys}::text[]) desired(sort_key)
            JOIN LATERAL (
              SELECT leaf.leaf_public_id
              FROM focowiki.generated_directory_leaves leaf
              WHERE leaf.knowledge_base_id = ${input.knowledgeBaseId}
                AND leaf.directory_path = ${input.directoryPath}
              ORDER BY (leaf.last_sort_key COLLATE "C"
                    >= desired.sort_key COLLATE "C") DESC,
                       CASE WHEN leaf.last_sort_key COLLATE "C"
                         >= desired.sort_key COLLATE "C"
                         THEN leaf.first_sort_key END COLLATE "C",
                       CASE WHEN leaf.last_sort_key COLLATE "C"
                         < desired.sort_key COLLATE "C"
                         THEN leaf.first_sort_key END COLLATE "C" DESC
              LIMIT 1
            ) selected ON true
          `;
      const selectedLeafIds = [...new Set([
        ...existingLeafIds,
        ...insertionRows.map((row) => row.leaf_public_id)
      ])];
      const windowRows = selectedLeafIds.length === 0 ? []
        : await sql<Array<{ leaf_public_id: string }>>`
            SELECT leaf.leaf_public_id
            FROM focowiki.generated_directory_leaves leaf
            WHERE leaf.knowledge_base_id = ${input.knowledgeBaseId}
              AND leaf.directory_path = ${input.directoryPath}
              AND (
                leaf.leaf_public_id = ANY(${selectedLeafIds}::text[])
                OR leaf.previous_leaf_public_id = ANY(${selectedLeafIds}::text[])
                OR leaf.next_leaf_public_id = ANY(${selectedLeafIds}::text[])
              )
            ORDER BY leaf.first_sort_key COLLATE "C",
                     leaf.leaf_public_id COLLATE "C"
          `;
      const windowLeafIds = windowRows.map((row) => row.leaf_public_id);
      if (windowLeafIds.length > input.maximumLeaves) {
        return {
          mode: "full", leaves: [], changes: [],
          totalEntryCount: 0, firstLeafId: null, rootExists: false
        };
      }
      const leaves = windowLeafIds.length === 0 ? [] : await sql<LeafRow[]>`
        SELECT leaf_public_id, previous_leaf_public_id,
               next_leaf_public_id, revision, changed_at
        FROM focowiki.generated_directory_leaves
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND directory_path = ${input.directoryPath}
          AND leaf_public_id IN ${sql(windowLeafIds)}
        ORDER BY first_sort_key COLLATE "C", leaf_public_id COLLATE "C"
      `;
      const entries = windowLeafIds.length === 0 ? [] : await sql<EntryRow[]>`
        SELECT leaf_public_id, entry_public_id, sort_key, name,
               target_path, evidence_path, entry_kind
        FROM focowiki.generated_directory_leaf_entries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND directory_path = ${input.directoryPath}
          AND leaf_public_id IN ${sql(windowLeafIds)}
        ORDER BY leaf_public_id COLLATE "C", ordinal
        LIMIT ${input.maximumEntries + 1}
      `;
      if (entries.length > input.maximumEntries) {
        throw directoryNavigationError("entry_limit_exceeded");
      }
      const byLeaf = new Map<string, PersistentDirectoryLeaf["entries"]>();
      for (const entry of entries) {
        const values = byLeaf.get(entry.leaf_public_id) ?? [];
        values.push({
          id: entry.entry_public_id, sortKey: entry.sort_key,
          name: entry.name, targetPath: entry.target_path,
          ...(entry.evidence_path ? { evidencePath: entry.evidence_path } : {}),
          kind: entry.entry_kind
        });
        byLeaf.set(entry.leaf_public_id, values);
      }
      const mappedLeaves = leaves.map((leaf) => ({
          id: leaf.leaf_public_id,
          previousLeafId: leaf.previous_leaf_public_id,
          nextLeafId: leaf.next_leaf_public_id,
          entries: byLeaf.get(leaf.leaf_public_id) ?? [],
          revision: Number(leaf.revision),
          ...(leaf.changed_at ? { changedAt: leaf.changed_at.toISOString() } : {})
        }));
      const windows = partitionDocumentDirectoryNavigationWindows(mappedLeaves);
      const result = {
        changes: changed.map((row) => ({
          entryId: row.entry_public_id,
          desiredEntry: row.desired_sort_key === null ? null : {
            id: row.entry_public_id,
            sortKey: row.desired_sort_key,
            name: row.desired_name!,
            targetPath: row.desired_target_path!,
            ...(row.desired_evidence_path
              ? { evidencePath: row.desired_evidence_path } : {}),
            kind: row.desired_entry_kind!
          }
        })),
        totalEntryCount: Number(summary.total_entry_count),
        firstLeafId: summary.first_leaf_public_id,
        rootExists: summary.root_exists
      };
      return windows.length > 1
        ? { mode: "windows" as const, windows, ...result }
        : { mode: "window" as const, leaves: mappedLeaves, ...result };
    }
  };
}

export async function applyPostgresDocumentDirectoryNavigation(input: {
  transaction: DatabaseClient;
  knowledgeBaseId: string;
  activationRevision: number;
  mutations: readonly DocumentDirectoryNavigationMutation[];
  activatedAt: string;
}): Promise<void> {
  validateDocumentDirectoryNavigationMutations(input.mutations);
  if (!input.knowledgeBaseId || !Number.isSafeInteger(input.activationRevision)
    || input.activationRevision < 1 || !Number.isFinite(Date.parse(input.activatedAt))) {
    throw directoryNavigationError("apply_input_invalid");
  }
  const sql = input.transaction;
  const directoryPaths = input.mutations.map((mutation) => mutation.directoryPath);
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
}

function validateRead(input: {
  knowledgeBaseId: string;
  directoryPath: string;
  maximumLeaves: number;
  maximumEntries: number;
}): void {
  if (!input.knowledgeBaseId || !input.directoryPath
    || !Number.isSafeInteger(input.maximumLeaves) || input.maximumLeaves < 1
    || input.maximumLeaves > 10_000
    || !Number.isSafeInteger(input.maximumEntries) || input.maximumEntries < 1
    || input.maximumEntries > 100_000) {
    throw directoryNavigationError("read_input_invalid");
  }
}

function directoryNavigationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document directory navigation error: ${code}`), { code });
}
