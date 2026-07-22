import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import type {
  DirectoryNavigationMutationResult,
  DirectoryNavigationRepository,
  DirectoryNavigationSummary,
  PersistentDirectoryLeaf
} from "../../application/ports/directory-navigation-repository.js";
import type { DatabaseClient } from "../../db/client.js";
import {
  directoryLeafByteSize,
  insertDirectoryEntry,
  removeDirectoryEntry,
  type OrderedDirectoryEntry,
  type OrderedDirectoryLeaf,
  type OrderedDirectoryLeafLimits,
  type OrderedDirectoryLeafMutation
} from "../../publication/ordered-directory-leaves.js";

type LeafRow = {
  id: string;
  previous_leaf_id: string | null;
  next_leaf_id: string | null;
  entries_json: unknown;
  revision: number;
};

type SummaryRow = {
  directory_path: string;
  entry_count: number;
  first_leaf_id: string | null;
  revision: number;
};

type NavigationChangeRow = {
  touched_leaf_ids: string[];
  removed_leaf_ids: string[];
};

type TransactionClient = postgres.TransactionSql;

export function createPostgresDirectoryNavigationRepository(
  sql: DatabaseClient,
  options: { createLeafId?: () => string } = {}
): DirectoryNavigationRepository {
  const createLeafId = options.createLeafId ?? (() => `directory-leaf-${randomUUID()}`);

  return {
    async applyEntry(input) {
      validateInput(input);
      return sql.begin(async (transaction) => {
        await lockDirectory(transaction, input.generationId, input.directoryPath);
        await ensureGenerationDirectory(transaction, input);
        return applyEntryInTransaction(transaction, input, createLeafId);
      });
    },

    async applyEntries(input) {
      for (const entry of input.entries) {
        validateInput({ ...input, ...entry });
      }
      return sql.begin(async (transaction) => {
        await lockDirectory(transaction, input.generationId, input.directoryPath);
        await ensureGenerationDirectory(transaction, input);
        const touchedIds = new Set<string>();
        const removedIds = new Set<string>();
        let changed = false;
        let summary = await readSummary(
          transaction,
          input.knowledgeBaseId,
          input.generationId,
          input.directoryPath
        );
        for (const entry of input.entries) {
          const mutation = await applyEntryInTransaction(transaction, {
            knowledgeBaseId: input.knowledgeBaseId,
            generationId: input.generationId,
            directoryPath: input.directoryPath,
            entryId: entry.entryId,
            desiredEntry: entry.desiredEntry,
            limits: input.limits
          }, createLeafId);
          if (!mutation.changed) continue;
          changed = true;
          summary = mutation.summary;
          for (const id of mutation.removedLeafIds) {
            removedIds.add(id);
            touchedIds.delete(id);
          }
          for (const leaf of mutation.touchedLeaves) {
            if (!removedIds.has(leaf.id)) touchedIds.add(leaf.id);
          }
        }
        return {
          changed,
          touchedLeaves: changed
            ? await loadLeavesById(
                transaction,
                input.knowledgeBaseId,
                input.generationId,
                input.directoryPath,
                [...touchedIds]
              )
            : [],
          removedLeafIds: [...removedIds],
          summary
        };
      });
    },

    async getSummary(input) {
      const rows = await sql<SummaryRow[]>`
        SELECT directory_path, entry_count, first_leaf_id, revision
        FROM focowiki.generation_directory_navigation_summaries
        WHERE knowledge_base_id = ${input.knowledgeBaseId}
          AND generation_id = ${input.generationId}
          AND directory_path = ${input.directoryPath}
      `;
      return rows[0] ? mapSummary(rows[0]) : null;
    }
  };
}

async function lockDirectory(
  transaction: TransactionClient,
  generationId: string,
  directoryPath: string
): Promise<void> {
  await transaction`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${`${generationId}\u001f${directoryPath}`}, 0)
    )
  `;
}

async function applyEntryInTransaction(
  transaction: TransactionClient,
  input: Parameters<DirectoryNavigationRepository["applyEntry"]>[0],
  createLeafId: () => string
): Promise<DirectoryNavigationMutationResult> {
  const existingLeaf = await findLeafContainingEntry(
    transaction,
    input.knowledgeBaseId,
    input.generationId,
    input.directoryPath,
    input.entryId
  );
  const existingEntry = existingLeaf?.entries.find((entry) => entry.id === input.entryId);
  if (existingEntry && input.desiredEntry && entriesEqual(existingEntry, input.desiredEntry)) {
    return unchangedResult(
      transaction,
      input.knowledgeBaseId,
      input.generationId,
      input.directoryPath,
      input.entryId
    );
  }
  if (!existingEntry && !input.desiredEntry) {
    return unchangedResult(
      transaction,
      input.knowledgeBaseId,
      input.generationId,
      input.directoryPath,
      input.entryId
    );
  }

  const touchedIds = new Set<string>();
  const removedIds = new Set<string>();
  if (existingLeaf) {
    const removalWindow = await loadRemovalWindow(
      transaction,
      input.knowledgeBaseId,
      input.generationId,
      input.directoryPath,
      existingLeaf
    );
    const mutation = removeDirectoryEntry({
      leaves: removalWindow.map(toOrderedLeaf),
      entryId: input.entryId,
      limits: input.limits
    });
    const adjacentTouchedIds = await persistMutation({
      transaction,
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      directoryPath: input.directoryPath,
      originalRows: removalWindow,
      mutation
    });
    mutation.touchedLeafIds.forEach((id) => touchedIds.add(id));
    adjacentTouchedIds.forEach((id) => touchedIds.add(id));
    mutation.removedLeafIds.forEach((id) => removedIds.add(id));
  }

  if (input.desiredEntry) {
    const target = await findInsertionLeaf(
      transaction,
      input.knowledgeBaseId,
      input.generationId,
      input.directoryPath,
      input.desiredEntry.sortKey
    );
    const originalRows = target ? [target] : [];
    const mutation = insertDirectoryEntry({
      leaves: originalRows.map(toOrderedLeaf),
      entry: input.desiredEntry,
      limits: input.limits,
      createLeafId
    });
    const adjacentTouchedIds = await persistMutation({
      transaction,
      knowledgeBaseId: input.knowledgeBaseId,
      generationId: input.generationId,
      directoryPath: input.directoryPath,
      originalRows,
      mutation
    });
    mutation.touchedLeafIds.forEach((id) => touchedIds.add(id));
    adjacentTouchedIds.forEach((id) => touchedIds.add(id));
    mutation.removedLeafIds.forEach((id) => removedIds.add(id));
  }

  for (const id of removedIds) touchedIds.delete(id);
  const entryDelta = existingEntry ? (input.desiredEntry ? 0 : -1) : 1;
  const summary = await updateSummary({
    transaction,
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    directoryPath: input.directoryPath,
    entryDelta
  });
  const touchedLeaves = await loadLeavesById(
    transaction,
    input.knowledgeBaseId,
    input.generationId,
    input.directoryPath,
    [...touchedIds]
  );
  await persistNavigationChange({
    transaction,
    knowledgeBaseId: input.knowledgeBaseId,
    generationId: input.generationId,
    directoryPath: input.directoryPath,
    entryId: input.entryId,
    touchedLeafIds: [...touchedIds],
    removedLeafIds: [...removedIds]
  });
  return {
    changed: true,
    touchedLeaves,
    removedLeafIds: [...removedIds],
    summary
  };
}

async function ensureGenerationDirectory(
  transaction: TransactionClient,
  input: Pick<
    Parameters<DirectoryNavigationRepository["applyEntry"]>[0],
    "knowledgeBaseId" | "generationId" | "directoryPath"
  >
): Promise<void> {
  const existing = await transaction<Array<{ initialized: boolean }>>`
    SELECT EXISTS (
      SELECT 1
      FROM focowiki.generation_directory_navigation_summaries summary
      WHERE summary.generation_id = ${input.generationId}
        AND summary.knowledge_base_id = ${input.knowledgeBaseId}
        AND summary.directory_path = ${input.directoryPath}
    ) AS initialized
  `;
  if (existing[0]?.initialized) return;

  await transaction`
    WITH RECURSIVE lineage(generation_id, depth) AS (
      SELECT generation.predecessor_generation_id, 1
      FROM focowiki.publication_generations generation
      WHERE generation.id = ${input.generationId}
        AND generation.knowledge_base_id = ${input.knowledgeBaseId}
        AND generation.predecessor_generation_id IS NOT NULL
      UNION ALL
      SELECT generation.predecessor_generation_id, lineage.depth + 1
      FROM lineage
      JOIN focowiki.publication_generations generation
        ON generation.id = lineage.generation_id
       AND generation.knowledge_base_id = ${input.knowledgeBaseId}
      WHERE generation.predecessor_generation_id IS NOT NULL
    ), nearest AS MATERIALIZED (
      SELECT summary.*
      FROM lineage
      JOIN focowiki.generation_directory_navigation_summaries summary
        ON summary.generation_id = lineage.generation_id
       AND summary.knowledge_base_id = ${input.knowledgeBaseId}
       AND summary.directory_path = ${input.directoryPath}
      ORDER BY lineage.depth
      LIMIT 1
    )
    INSERT INTO focowiki.generation_directory_navigation_summaries (
      generation_id, knowledge_base_id, directory_path,
      entry_count, first_leaf_id, revision, updated_at
    )
    SELECT ${input.generationId}, nearest.knowledge_base_id,
           nearest.directory_path, nearest.entry_count,
           nearest.first_leaf_id, nearest.revision, now()
    FROM nearest
    ON CONFLICT (generation_id, directory_path) DO NOTHING
  `;
  await transaction`
    WITH RECURSIVE lineage(generation_id, depth) AS (
      SELECT generation.predecessor_generation_id, 1
      FROM focowiki.publication_generations generation
      WHERE generation.id = ${input.generationId}
        AND generation.knowledge_base_id = ${input.knowledgeBaseId}
        AND generation.predecessor_generation_id IS NOT NULL
      UNION ALL
      SELECT generation.predecessor_generation_id, lineage.depth + 1
      FROM lineage
      JOIN focowiki.publication_generations generation
        ON generation.id = lineage.generation_id
       AND generation.knowledge_base_id = ${input.knowledgeBaseId}
      WHERE generation.predecessor_generation_id IS NOT NULL
    ), nearest AS MATERIALIZED (
      SELECT summary.generation_id
      FROM lineage
      JOIN focowiki.generation_directory_navigation_summaries summary
        ON summary.generation_id = lineage.generation_id
       AND summary.knowledge_base_id = ${input.knowledgeBaseId}
       AND summary.directory_path = ${input.directoryPath}
      ORDER BY lineage.depth
      LIMIT 1
    )
    INSERT INTO focowiki.generation_directory_navigation_leaves (
      generation_id, id, knowledge_base_id, directory_path,
      previous_leaf_id, next_leaf_id, entry_count, byte_count,
      first_sort_key, last_sort_key, entries_json, revision, updated_at
    )
    SELECT ${input.generationId}, predecessor.id, predecessor.knowledge_base_id,
           predecessor.directory_path, predecessor.previous_leaf_id,
           predecessor.next_leaf_id, predecessor.entry_count, predecessor.byte_count,
           predecessor.first_sort_key, predecessor.last_sort_key,
           predecessor.entries_json, predecessor.revision, now()
    FROM nearest
    JOIN focowiki.generation_directory_navigation_leaves predecessor
      ON predecessor.generation_id = nearest.generation_id
     AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
     AND predecessor.directory_path = ${input.directoryPath}
    ON CONFLICT (generation_id, id) DO NOTHING
  `;
  await transaction`
    INSERT INTO focowiki.generation_directory_navigation_summaries (
      generation_id, knowledge_base_id, directory_path,
      entry_count, first_leaf_id, revision, updated_at
    )
    SELECT ${input.generationId}, legacy.knowledge_base_id,
           legacy.directory_path, legacy.entry_count,
           legacy.first_leaf_id, legacy.revision, now()
    FROM focowiki.directory_navigation_summaries legacy
    WHERE legacy.knowledge_base_id = ${input.knowledgeBaseId}
      AND legacy.directory_path = ${input.directoryPath}
    ON CONFLICT (generation_id, directory_path) DO NOTHING
  `;
  await transaction`
    WITH RECURSIVE lineage(generation_id) AS (
      SELECT generation.predecessor_generation_id
      FROM focowiki.publication_generations generation
      WHERE generation.id = ${input.generationId}
        AND generation.knowledge_base_id = ${input.knowledgeBaseId}
        AND generation.predecessor_generation_id IS NOT NULL
      UNION ALL
      SELECT generation.predecessor_generation_id
      FROM lineage
      JOIN focowiki.publication_generations generation
        ON generation.id = lineage.generation_id
       AND generation.knowledge_base_id = ${input.knowledgeBaseId}
      WHERE generation.predecessor_generation_id IS NOT NULL
    )
    INSERT INTO focowiki.generation_directory_navigation_leaves (
      generation_id, id, knowledge_base_id, directory_path,
      previous_leaf_id, next_leaf_id, entry_count, byte_count,
      first_sort_key, last_sort_key, entries_json, revision, updated_at
    )
    SELECT ${input.generationId}, legacy.id, legacy.knowledge_base_id,
           legacy.directory_path, legacy.previous_leaf_id, legacy.next_leaf_id,
           legacy.entry_count, legacy.byte_count, legacy.first_sort_key,
           legacy.last_sort_key, legacy.entries_json, legacy.revision, now()
    FROM focowiki.directory_navigation_leaves legacy
    WHERE legacy.knowledge_base_id = ${input.knowledgeBaseId}
      AND legacy.directory_path = ${input.directoryPath}
      AND NOT EXISTS (
        SELECT 1
        FROM lineage
        JOIN focowiki.generation_directory_navigation_summaries predecessor
          ON predecessor.generation_id = lineage.generation_id
         AND predecessor.knowledge_base_id = ${input.knowledgeBaseId}
         AND predecessor.directory_path = ${input.directoryPath}
      )
      AND NOT EXISTS (
        SELECT 1
        FROM focowiki.generation_directory_navigation_leaves current
        WHERE current.generation_id = ${input.generationId}
          AND current.directory_path = ${input.directoryPath}
      )
    ON CONFLICT (generation_id, id) DO NOTHING
  `;
  await transaction`
    INSERT INTO focowiki.generation_directory_navigation_summaries (
      generation_id, knowledge_base_id, directory_path, entry_count, first_leaf_id
    ) VALUES (
      ${input.generationId}, ${input.knowledgeBaseId}, ${input.directoryPath}, 0, NULL
    )
    ON CONFLICT (generation_id, directory_path) DO NOTHING
  `;
}

async function findLeafContainingEntry(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string,
  entryId: string
): Promise<ParsedLeafRow | null> {
  const rows = await transaction<LeafRow[]>`
    SELECT id, previous_leaf_id, next_leaf_id, entries_json, revision
    FROM focowiki.generation_directory_navigation_leaves
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
      AND entries_json @> jsonb_build_array(jsonb_build_object('id', ${entryId}::text))
    LIMIT 1
    FOR UPDATE
  `;
  return rows[0] ? parseLeaf(rows[0]) : null;
}

async function findInsertionLeaf(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string,
  sortKey: string
): Promise<ParsedLeafRow | null> {
  const candidates = await transaction<LeafRow[]>`
    SELECT id, previous_leaf_id, next_leaf_id, entries_json, revision
    FROM focowiki.generation_directory_navigation_leaves
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
      AND (last_sort_key IS NULL OR last_sort_key >= ${sortKey})
    ORDER BY last_sort_key NULLS FIRST, first_sort_key, id
    LIMIT 1
    FOR UPDATE
  `;
  if (candidates[0]) return parseLeaf(candidates[0]);
  const last = await transaction<LeafRow[]>`
    SELECT id, previous_leaf_id, next_leaf_id, entries_json, revision
    FROM focowiki.generation_directory_navigation_leaves
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
    ORDER BY last_sort_key DESC NULLS LAST, id DESC
    LIMIT 1
    FOR UPDATE
  `;
  return last[0] ? parseLeaf(last[0]) : null;
}

type ParsedLeafRow = Omit<LeafRow, "entries_json"> & { entries: OrderedDirectoryEntry[] };

async function loadRemovalWindow(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string,
  target: ParsedLeafRow
): Promise<ParsedLeafRow[]> {
  if (target.previous_leaf_id) {
    const previous = await loadLeafById(
      transaction,
      knowledgeBaseId,
      generationId,
      directoryPath,
      target.previous_leaf_id
    );
    return previous ? [previous, target] : [target];
  }
  if (target.next_leaf_id) {
    const next = await loadLeafById(
      transaction,
      knowledgeBaseId,
      generationId,
      directoryPath,
      target.next_leaf_id
    );
    return next ? [target, next] : [target];
  }
  return [target];
}

async function loadLeafById(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string,
  id: string
): Promise<ParsedLeafRow | null> {
  const rows = await transaction<LeafRow[]>`
    SELECT id, previous_leaf_id, next_leaf_id, entries_json, revision
    FROM focowiki.generation_directory_navigation_leaves
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
      AND id = ${id}
    FOR UPDATE
  `;
  return rows[0] ? parseLeaf(rows[0]) : null;
}

async function persistMutation(input: {
  transaction: TransactionClient;
  knowledgeBaseId: string;
  generationId: string;
  directoryPath: string;
  originalRows: ParsedLeafRow[];
  mutation: OrderedDirectoryLeafMutation;
}): Promise<string[]> {
  const externalPreviousId = input.originalRows[0]?.previous_leaf_id ?? null;
  const externalNextId = input.originalRows.at(-1)?.next_leaf_id ?? null;
  const originalRevisions = new Map(input.originalRows.map((row) => [row.id, row.revision]));
  const removed = new Set(input.mutation.removedLeafIds);
  const adjacentTouchedIds: string[] = [];
  for (let index = 0; index < input.mutation.leaves.length; index += 1) {
    const leaf = input.mutation.leaves[index]!;
    const previousLeafId = input.mutation.leaves[index - 1]?.id ?? externalPreviousId;
    const nextLeafId = input.mutation.leaves[index + 1]?.id ?? externalNextId;
    const firstSortKey = leaf.entries[0]?.sortKey ?? null;
    const lastSortKey = leaf.entries.at(-1)?.sortKey ?? null;
    await input.transaction`
      INSERT INTO focowiki.generation_directory_navigation_leaves (
        generation_id, id, knowledge_base_id, directory_path, previous_leaf_id, next_leaf_id,
        entry_count, byte_count, first_sort_key, last_sort_key, entries_json, revision
      ) VALUES (
        ${input.generationId}, ${leaf.id}, ${input.knowledgeBaseId}, ${input.directoryPath},
        ${previousLeafId}, ${nextLeafId}, ${leaf.entries.length},
        ${directoryLeafByteSize(leaf.entries)}, ${firstSortKey}, ${lastSortKey},
        ${input.transaction.json(leaf.entries)}, ${(originalRevisions.get(leaf.id) ?? 0) + 1}
      )
      ON CONFLICT (generation_id, id) DO UPDATE SET
        previous_leaf_id = EXCLUDED.previous_leaf_id,
        next_leaf_id = EXCLUDED.next_leaf_id,
        entry_count = EXCLUDED.entry_count,
        byte_count = EXCLUDED.byte_count,
        first_sort_key = EXCLUDED.first_sort_key,
        last_sort_key = EXCLUDED.last_sort_key,
        entries_json = EXCLUDED.entries_json,
        revision = focowiki.generation_directory_navigation_leaves.revision + 1,
        updated_at = now()
    `;
  }
  const firstId = input.mutation.leaves[0]?.id ?? externalNextId;
  const lastId = input.mutation.leaves.at(-1)?.id ?? externalPreviousId;
  const originalFirstId = input.originalRows[0]?.id ?? null;
  const originalLastId = input.originalRows.at(-1)?.id ?? null;
  if (
    externalPreviousId && !removed.has(externalPreviousId) &&
    firstId !== originalFirstId
  ) {
    await input.transaction`
      UPDATE focowiki.generation_directory_navigation_leaves
      SET next_leaf_id = ${firstId}, revision = revision + 1, updated_at = now()
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND generation_id = ${input.generationId}
        AND directory_path = ${input.directoryPath}
        AND id = ${externalPreviousId}
    `;
    adjacentTouchedIds.push(externalPreviousId);
  }
  if (
    externalNextId && !removed.has(externalNextId) &&
    lastId !== originalLastId
  ) {
    await input.transaction`
      UPDATE focowiki.generation_directory_navigation_leaves
      SET previous_leaf_id = ${lastId}, revision = revision + 1, updated_at = now()
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND generation_id = ${input.generationId}
        AND directory_path = ${input.directoryPath}
        AND id = ${externalNextId}
    `;
    adjacentTouchedIds.push(externalNextId);
  }
  if (input.mutation.removedLeafIds.length > 0) {
    await input.transaction`
      DELETE FROM focowiki.generation_directory_navigation_leaves
      WHERE knowledge_base_id = ${input.knowledgeBaseId}
        AND generation_id = ${input.generationId}
        AND directory_path = ${input.directoryPath}
        AND id IN ${input.transaction(input.mutation.removedLeafIds)}
    `;
  }
  return adjacentTouchedIds;
}

async function updateSummary(input: {
  transaction: TransactionClient;
  knowledgeBaseId: string;
  generationId: string;
  directoryPath: string;
  entryDelta: number;
}): Promise<DirectoryNavigationSummary> {
  const firstRows = await input.transaction<Array<{ id: string }>>`
    SELECT id
    FROM focowiki.generation_directory_navigation_leaves
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${input.generationId}
      AND directory_path = ${input.directoryPath}
      AND previous_leaf_id IS NULL
    ORDER BY first_sort_key NULLS FIRST, id
    LIMIT 1
  `;
  const rows = await input.transaction<SummaryRow[]>`
    UPDATE focowiki.generation_directory_navigation_summaries
    SET entry_count = entry_count + ${input.entryDelta},
        first_leaf_id = ${firstRows[0]?.id ?? null},
        revision = revision + 1,
        updated_at = now()
    WHERE knowledge_base_id = ${input.knowledgeBaseId}
      AND generation_id = ${input.generationId}
      AND directory_path = ${input.directoryPath}
    RETURNING directory_path, entry_count, first_leaf_id, revision
  `;
  if (!rows[0]) throw new Error("Directory navigation summary is unavailable");
  return mapSummary(rows[0]);
}

async function persistNavigationChange(input: {
  transaction: TransactionClient;
  knowledgeBaseId: string;
  generationId: string;
  directoryPath: string;
  entryId: string;
  touchedLeafIds: string[];
  removedLeafIds: string[];
}): Promise<void> {
  await input.transaction`
    INSERT INTO focowiki.generation_directory_navigation_changes (
      generation_id, knowledge_base_id, directory_path, entry_id,
      touched_leaf_ids, removed_leaf_ids, updated_at
    ) VALUES (
      ${input.generationId}, ${input.knowledgeBaseId}, ${input.directoryPath},
      ${input.entryId}, ${input.touchedLeafIds}, ${input.removedLeafIds}, now()
    )
    ON CONFLICT (generation_id, directory_path, entry_id) DO UPDATE
    SET touched_leaf_ids = EXCLUDED.touched_leaf_ids,
        removed_leaf_ids = EXCLUDED.removed_leaf_ids,
        updated_at = EXCLUDED.updated_at
  `;
}

async function unchangedResult(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string,
  entryId: string
): Promise<DirectoryNavigationMutationResult> {
  const summary = await readSummary(transaction, knowledgeBaseId, generationId, directoryPath);
  const changes = await transaction<NavigationChangeRow[]>`
    SELECT touched_leaf_ids, removed_leaf_ids
    FROM focowiki.generation_directory_navigation_changes
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
      AND entry_id = ${entryId}
  `;
  const previous = changes[0];
  if (previous) {
    return {
      changed: true,
      touchedLeaves: await loadLeavesById(
        transaction,
        knowledgeBaseId,
        generationId,
        directoryPath,
        previous.touched_leaf_ids
      ),
      removedLeafIds: previous.removed_leaf_ids,
      summary
    };
  }
  return {
    changed: false,
    touchedLeaves: [],
    removedLeafIds: [],
    summary
  };
}

async function readSummary(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string
): Promise<DirectoryNavigationSummary> {
  const rows = await transaction<SummaryRow[]>`
    SELECT directory_path, entry_count, first_leaf_id, revision
    FROM focowiki.generation_directory_navigation_summaries
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
  `;
  if (!rows[0]) throw new Error("Directory navigation summary is unavailable");
  return mapSummary(rows[0]);
}

async function loadLeavesById(
  transaction: TransactionClient,
  knowledgeBaseId: string,
  generationId: string,
  directoryPath: string,
  ids: string[]
): Promise<PersistentDirectoryLeaf[]> {
  if (ids.length === 0) return [];
  const rows = await transaction<LeafRow[]>`
    SELECT id, previous_leaf_id, next_leaf_id, entries_json, revision
    FROM focowiki.generation_directory_navigation_leaves
    WHERE knowledge_base_id = ${knowledgeBaseId}
      AND generation_id = ${generationId}
      AND directory_path = ${directoryPath}
      AND id IN ${transaction(ids)}
    ORDER BY first_sort_key NULLS FIRST, id
  `;
  return rows.map((row) => {
    const parsed = parseLeaf(row);
    return {
      id: parsed.id,
      previousLeafId: parsed.previous_leaf_id,
      nextLeafId: parsed.next_leaf_id,
      entries: parsed.entries,
      revision: Number(parsed.revision)
    };
  });
}

function parseLeaf(row: LeafRow): ParsedLeafRow {
  if (!Array.isArray(row.entries_json)) {
    throw new Error("Directory navigation leaf entries are invalid");
  }
  return {
    id: row.id,
    previous_leaf_id: row.previous_leaf_id,
    next_leaf_id: row.next_leaf_id,
    entries: row.entries_json as OrderedDirectoryEntry[],
    revision: Number(row.revision)
  };
}

function toOrderedLeaf(row: ParsedLeafRow): OrderedDirectoryLeaf {
  return { id: row.id, entries: row.entries };
}

function mapSummary(row: SummaryRow): DirectoryNavigationSummary {
  return {
    directoryPath: row.directory_path,
    entryCount: Number(row.entry_count),
    firstLeafId: row.first_leaf_id,
    revision: Number(row.revision)
  };
}

function entriesEqual(a: OrderedDirectoryEntry, b: OrderedDirectoryEntry): boolean {
  return a.id === b.id && a.sortKey === b.sortKey && a.name === b.name &&
    a.targetPath === b.targetPath && a.kind === b.kind;
}

function validateInput(input: {
  knowledgeBaseId: string;
  generationId: string;
  directoryPath: string;
  entryId: string;
  desiredEntry: OrderedDirectoryEntry | null;
  limits: OrderedDirectoryLeafLimits;
}): void {
  if (!input.knowledgeBaseId || !input.generationId || !input.directoryPath || !input.entryId) {
    throw new Error("Directory navigation identity is required");
  }
  if (input.desiredEntry && input.desiredEntry.id !== input.entryId) {
    throw new Error("Directory entry identity must remain stable");
  }
}
