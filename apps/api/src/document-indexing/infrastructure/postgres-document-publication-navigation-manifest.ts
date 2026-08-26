import type { DatabaseClient } from "../../db/client.js";
import type { DocumentPublicationJobOutput } from
  "../application/document-publication-job-ports.js";
import {
  validateDocumentDirectoryNavigationMutations,
  type DocumentDirectoryNavigationMutation
} from "../application/document-directory-navigation-mutation.js";
import { applyPostgresDocumentDirectoryNavigation } from
  "./postgres-document-directory-navigation.js";

const INSERT_BATCH_SIZE = 500;

export async function replacePostgresDocumentPublicationNavigationManifest(
  input: Readonly<{
    transaction: DatabaseClient;
    jobPublicId: string;
    outputs: readonly DocumentPublicationJobOutput[];
    persistedAt: string;
  }>
): Promise<void> {
  const sql = input.transaction;
  const mutations = input.outputs.flatMap((output) =>
    output.navigationMutations as readonly DocumentDirectoryNavigationMutation[]
  );
  validateMutationSequence(mutations);
  await sql`
    DELETE FROM focowiki.publication_job_navigation_mutations
    WHERE job_public_id = ${input.jobPublicId}
  `;
  const headers = mutations.map((mutation, mutationOrder) => ({
    mutation_order: mutationOrder,
    directory_path: mutation.directoryPath
  }));
  for (const batch of batches(headers)) {
    await sql`
      INSERT INTO focowiki.publication_job_navigation_mutations (
        job_public_id, mutation_order, directory_path, created_at
      )
      SELECT ${input.jobPublicId}, desired.mutation_order,
             desired.directory_path, ${input.persistedAt}
      FROM jsonb_to_recordset(${sql.json(batch as never)}) desired(
        mutation_order integer, directory_path text
      )
    `;
  }
  const leaves = mutations.flatMap((mutation, mutationOrder) =>
    mutation.touchedLeaves.map((leaf, leafOrder) => ({
      mutation_order: mutationOrder,
      leaf_order: leafOrder,
      leaf_public_id: leaf.id,
      previous_leaf_public_id: leaf.previousLeafId,
      next_leaf_public_id: leaf.nextLeafId,
      revision: leaf.revision,
      changed_at: leaf.changedAt ?? null
    }))
  );
  for (const batch of batches(leaves)) {
    await sql`
      INSERT INTO focowiki.publication_job_navigation_leaves (
        job_public_id, mutation_order, leaf_order, leaf_public_id,
        previous_leaf_public_id, next_leaf_public_id, revision, changed_at
      )
      SELECT ${input.jobPublicId}, desired.mutation_order,
             desired.leaf_order, desired.leaf_public_id,
             desired.previous_leaf_public_id, desired.next_leaf_public_id,
             desired.revision, desired.changed_at
      FROM jsonb_to_recordset(${sql.json(batch as never)}) desired(
        mutation_order integer, leaf_order integer, leaf_public_id text,
        previous_leaf_public_id text, next_leaf_public_id text,
        revision bigint, changed_at timestamptz
      )
    `;
  }
  const entries = mutations.flatMap((mutation, mutationOrder) =>
    mutation.touchedLeaves.flatMap((leaf, leafOrder) =>
      leaf.entries.map((entry, entryOrder) => ({
        mutation_order: mutationOrder,
        leaf_order: leafOrder,
        entry_order: entryOrder,
        entry_public_id: entry.id,
        sort_key: entry.sortKey,
        name: entry.name,
        target_path: entry.targetPath,
        evidence_path: entry.evidencePath ?? null,
        entry_kind: entry.kind
      }))
    )
  );
  for (const batch of batches(entries)) {
    await sql`
      INSERT INTO focowiki.publication_job_navigation_entries (
        job_public_id, mutation_order, leaf_order, entry_order,
        entry_public_id, sort_key, name, target_path, evidence_path, entry_kind
      )
      SELECT ${input.jobPublicId}, desired.mutation_order,
             desired.leaf_order, desired.entry_order,
             desired.entry_public_id, desired.sort_key, desired.name,
             desired.target_path, desired.evidence_path, desired.entry_kind
      FROM jsonb_to_recordset(${sql.json(batch as never)}) desired(
        mutation_order integer, leaf_order integer, entry_order integer,
        entry_public_id text, sort_key text, name text, target_path text,
        evidence_path text, entry_kind text
      )
    `;
  }
  const removals = mutations.flatMap((mutation, mutationOrder) =>
    mutation.removedLeafIds.map((leafPublicId, removalOrder) => ({
      mutation_order: mutationOrder,
      removal_order: removalOrder,
      leaf_public_id: leafPublicId
    }))
  );
  for (const batch of batches(removals)) {
    await sql`
      INSERT INTO focowiki.publication_job_navigation_removals (
        job_public_id, mutation_order, removal_order, leaf_public_id
      )
      SELECT ${input.jobPublicId}, desired.mutation_order,
             desired.removal_order, desired.leaf_public_id
      FROM jsonb_to_recordset(${sql.json(batch as never)}) desired(
        mutation_order integer, removal_order integer, leaf_public_id text
      )
    `;
  }
}

export async function applyPostgresDocumentPublicationNavigationManifest(
  input: Readonly<{
    transaction: DatabaseClient;
    jobPublicId: string;
    knowledgeBaseId: string;
    activationRevision: number;
    activatedAt: string;
    legacyMutations?: readonly DocumentDirectoryNavigationMutation[];
  }>
): Promise<number> {
  const sql = input.transaction;
  const [headers, leaves, entries, removals] = await Promise.all([
    sql<Array<{ mutation_order: number; directory_path: string }>>`
      SELECT mutation_order, directory_path
      FROM focowiki.publication_job_navigation_mutations
      WHERE job_public_id = ${input.jobPublicId}
      ORDER BY mutation_order
    `,
    sql<Array<{
      mutation_order: number; leaf_order: number; leaf_public_id: string;
      previous_leaf_public_id: string | null; next_leaf_public_id: string | null;
      revision: number | string; changed_at: Date | string | null;
    }>>`
      SELECT mutation_order, leaf_order, leaf_public_id,
             previous_leaf_public_id, next_leaf_public_id, revision, changed_at
      FROM focowiki.publication_job_navigation_leaves
      WHERE job_public_id = ${input.jobPublicId}
      ORDER BY mutation_order, leaf_order
    `,
    sql<Array<{
      mutation_order: number; leaf_order: number; entry_order: number;
      entry_public_id: string; sort_key: string; name: string;
      target_path: string; evidence_path: string | null;
      entry_kind: "file" | "directory";
    }>>`
      SELECT mutation_order, leaf_order, entry_order, entry_public_id,
             sort_key, name, target_path, evidence_path, entry_kind
      FROM focowiki.publication_job_navigation_entries
      WHERE job_public_id = ${input.jobPublicId}
      ORDER BY mutation_order, leaf_order, entry_order
    `,
    sql<Array<{
      mutation_order: number; removal_order: number; leaf_public_id: string;
    }>>`
      SELECT mutation_order, removal_order, leaf_public_id
      FROM focowiki.publication_job_navigation_removals
      WHERE job_public_id = ${input.jobPublicId}
      ORDER BY mutation_order, removal_order
    `
  ]);
  const leavesByMutation = groupBy(leaves, (leaf) => leaf.mutation_order);
  const entriesByLeaf = groupBy(entries, (entry) =>
    `${entry.mutation_order}:${entry.leaf_order}`
  );
  const removalsByMutation = groupBy(removals, (removal) =>
    removal.mutation_order
  );
  const normalized = headers.map((header): DocumentDirectoryNavigationMutation => ({
    directoryPath: header.directory_path,
    touchedLeaves: (leavesByMutation.get(header.mutation_order) ?? []).map((leaf) => ({
      id: leaf.leaf_public_id,
      previousLeafId: leaf.previous_leaf_public_id,
      nextLeafId: leaf.next_leaf_public_id,
      revision: Number(leaf.revision),
      ...(leaf.changed_at
        ? { changedAt: new Date(leaf.changed_at).toISOString() } : {}),
      entries: (entriesByLeaf.get(
        `${header.mutation_order}:${leaf.leaf_order}`
      ) ?? []).map((entry) => ({
        id: entry.entry_public_id,
        sortKey: entry.sort_key,
        name: entry.name,
        targetPath: entry.target_path,
        ...(entry.evidence_path ? { evidencePath: entry.evidence_path } : {}),
        kind: entry.entry_kind
      }))
    })),
    removedLeafIds: (removalsByMutation.get(header.mutation_order) ?? [])
      .map((removal) => removal.leaf_public_id)
  }));
  const all = [...(input.legacyMutations ?? []), ...normalized];
  validateMutationSequence(all);
  for (const mutation of all) {
    await applyPostgresDocumentDirectoryNavigation({
      transaction: sql,
      knowledgeBaseId: input.knowledgeBaseId,
      activationRevision: input.activationRevision,
      mutations: [mutation],
      activatedAt: input.activatedAt
    });
  }
  return new Set(all.map((mutation) => mutation.directoryPath)).size;
}

function validateMutationSequence(
  mutations: readonly DocumentDirectoryNavigationMutation[]
): void {
  if (new Set(mutations.map((mutation) => mutation.directoryPath)).size
      !== mutations.length) {
    throw manifestError("publication_navigation_directory_conflict");
  }
  for (const mutation of mutations) {
    validateDocumentDirectoryNavigationMutations([mutation]);
  }
}

function manifestError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication navigation manifest error: ${code}`), {
    code
  });
}

function batches<T>(values: readonly T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += INSERT_BATCH_SIZE) {
    result.push(values.slice(index, index + INSERT_BATCH_SIZE));
  }
  return result;
}

function groupBy<T, K>(
  values: readonly T[],
  key: (value: T) => K
): Map<K, T[]> {
  const grouped = new Map<K, T[]>();
  for (const value of values) {
    const current = grouped.get(key(value)) ?? [];
    current.push(value);
    grouped.set(key(value), current);
  }
  return grouped;
}
