import { posix } from "node:path";
import { portableGraphDirectoryPath } from "@focowiki/okf";
import type { DatabaseClient } from "../../db/client.js";
import { documentRelationProjectionRecord } from
  "../application/document-machine-record.js";
import type { PerFileGraphRow } from
  "./postgres-document-graph-projection-reader.js";
import {
  visibleDocumentGraphEvidence as visibleEvidence,
  visibleDocumentGraphRecord as visibleRecord,
  visibleDocumentGraphRelation as visibleRelation
} from "./postgres-document-graph-visibility.js";
import {
  readAffectedGraphChildScopes,
  readBaseGraphDirectoryRecordKeys,
  readGraphChildScopes,
  readMachineResourcePaths
} from "./postgres-document-graph-directory-scope-reader.js";

const GRAPH_DIRECTORY_READ_PAGE_SIZE = 1_000;

type GraphDirectoryRow = PerFileGraphRow & {
  local_path: string;
  remote_path: string;
  local_source_file_public_id: string;
};

type GraphDirectoryCursor = Pick<GraphDirectoryRow,
  "local_path" | "remote_path" | "relation_kind" | "relation_public_id"
    | "evidence_public_id">;

type DirectoryRelationshipGroup = {
  key: string;
  record: Record<string, unknown>;
  directions: Set<"incoming" | "outgoing">;
  evidence: Record<string, unknown>[];
  evidenceKeys: Set<string>;
};

export function createPostgresDocumentGraphDirectoryScanner(
  sql: DatabaseClient
) {
  async function scanGraphDirectoryState(input: {
    knowledgeBaseId: string;
    scopePath: string;
    includedSourceRevisionPublicIds?: readonly string[];
    excludedActiveSourceFilePublicIds?: readonly string[];
    affectedSourceFilePublicIds?: readonly string[];
    baseDeterministicChangedAt?: string | null;
    affectedLogicalPaths?: readonly string[];
    signal?: AbortSignal;
    checkpoint?: () => Promise<void>;
    onRecords(records: readonly Record<string, unknown>[]): Promise<void> | void;
  }) {
    const included = sortedUnique(input.includedSourceRevisionPublicIds ?? []);
    const excluded = sortedUnique(input.excludedActiveSourceFilePublicIds ?? []);
    const affected = input.affectedSourceFilePublicIds === undefined
      ? null : sortedUnique(input.affectedSourceFilePublicIds);
    if (affected !== null && affected.length === 0) {
      return {
        recordCount: 0, childDirectories: [], resourcePaths: [],
        removedRecordKeys: []
      };
    }
    return sql.begin(async (rawTransaction) => {
      const transaction = rawTransaction as unknown as DatabaseClient;
      await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY`;
      const accumulator = createRelationshipAccumulator(input.scopePath);
      let cursor: GraphDirectoryCursor | null = null;
      let recordCount = 0;
      while (true) {
        input.signal?.throwIfAborted();
        const rows = await readGraphDirectoryPage(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          scopePath: input.scopePath,
          includedSourceRevisionPublicIds: included,
          excludedActiveSourceFilePublicIds: excluded,
          affectedSourceFilePublicIds: affected,
          cursor,
          ...(input.signal ? { signal: input.signal } : {})
        });
        if (rows.length === 0) break;
        const records = accumulator.append(rows);
        if (records.length > 0) {
          await input.onRecords(records);
          recordCount += records.length;
        }
        await input.checkpoint?.();
        const last = rows.at(-1)!;
        cursor = {
          local_path: last.local_path,
          remote_path: last.remote_path,
          relation_kind: last.relation_kind,
          relation_public_id: last.relation_public_id,
          evidence_public_id: last.evidence_public_id
        };
        if (rows.length < GRAPH_DIRECTORY_READ_PAGE_SIZE) break;
      }
      const finalRecords = accumulator.finish();
      if (finalRecords.length > 0) {
        await input.onRecords(finalRecords);
        recordCount += finalRecords.length;
      }
      const [childScopes, resourcePaths, removedRecordKeys] = await Promise.all([
        affected !== null && input.affectedLogicalPaths
          ? readAffectedGraphChildScopes(transaction, {
              knowledgeBaseId: input.knowledgeBaseId,
              scopePath: input.scopePath,
              affectedLogicalPaths: input.affectedLogicalPaths,
              includedSourceRevisionPublicIds: included,
              excludedActiveSourceFilePublicIds: excluded
            })
          : readGraphChildScopes(transaction, {
          knowledgeBaseId: input.knowledgeBaseId,
          scopePath: input.scopePath,
          includedSourceRevisionPublicIds: included,
          excludedActiveSourceFilePublicIds: excluded,
          affectedSourceFilePublicIds: affected
          }),
        affected === null
          ? readMachineResourcePaths(transaction, {
              knowledgeBaseId: input.knowledgeBaseId,
              machineDirectory: portableGraphDirectoryPath(input.scopePath)
            })
          : Promise.resolve([]),
        affected !== null && input.baseDeterministicChangedAt
          ? readBaseGraphDirectoryRecordKeys(transaction, {
              knowledgeBaseId: input.knowledgeBaseId,
              scopePath: input.scopePath,
              affectedSourceFilePublicIds: affected,
              baseDeterministicChangedAt: input.baseDeterministicChangedAt
            })
          : Promise.resolve([])
      ]);
      return {
        recordCount,
        childDirectories: childScopes.map((scopePath) => ({
          title: posix.basename(scopePath),
          scopePath,
          path: `${portableGraphDirectoryPath(scopePath)}/index.json`
        })),
        resourcePaths,
        removedRecordKeys
      };
    });
  }

  return {
    scanGraphDirectoryState,
    async scanGraphDirectoryDeltaState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      affectedSourceFilePublicIds: readonly string[];
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
      signal?: AbortSignal;
      checkpoint?: () => Promise<void>;
      baseDeterministicChangedAt?: string | null;
      affectedLogicalPaths?: readonly string[];
      onRecords(records: readonly Record<string, unknown>[]): Promise<void> | void;
    }) {
      return scanGraphDirectoryState(input);
    },
    async readGraphDirectoryState(input: {
      knowledgeBaseId: string;
      scopePath: string;
      includedSourceRevisionPublicIds?: readonly string[];
      excludedActiveSourceFilePublicIds?: readonly string[];
    }) {
      const records: Record<string, unknown>[] = [];
      const state = await scanGraphDirectoryState({
        ...input,
        onRecords(page) {
          records.push(...page);
        }
      });
      return {
        records,
        childDirectories: state.childDirectories,
        resourcePaths: state.resourcePaths
      };
    }
  };
}

async function readGraphDirectoryPage(sql: DatabaseClient, input: {
  knowledgeBaseId: string;
  scopePath: string;
  includedSourceRevisionPublicIds: readonly string[];
  excludedActiveSourceFilePublicIds: readonly string[];
  affectedSourceFilePublicIds: readonly string[] | null;
  cursor: GraphDirectoryCursor | null;
  signal?: AbortSignal;
}): Promise<GraphDirectoryRow[]> {
  input.signal?.throwIfAborted();
  const included = input.includedSourceRevisionPublicIds;
  const excluded = input.excludedActiveSourceFilePublicIds;
  const rows = await sql<GraphDirectoryRow[]>`
    WITH graph_rows AS (
      SELECT relation.public_id AS relation_public_id,
             evidence.public_id AS evidence_public_id,
             first_page.page_path AS first_path,
             first_record.title AS first_title,
             second_page.page_path AS second_path,
             second_record.title AS second_title,
             relation.first_source_file_public_id,
             relation.second_source_file_public_id,
             evidence.source_file_public_id AS evidence_source_file_public_id,
             relation.relation_kind, evidence.evidence_kind, evidence.evidence,
             first_page.directory_path = ${input.scopePath}
               AND position('/' in substring(first_page.page_path
                 from char_length(${input.scopePath}) + 2)) = 0
               AS first_direct,
             second_page.directory_path = ${input.scopePath}
               AND position('/' in substring(second_page.page_path
                 from char_length(${input.scopePath}) + 2)) = 0
               AS second_direct
      FROM focowiki.canonical_file_relations relation
      JOIN focowiki.relation_directed_evidence evidence
        ON evidence.knowledge_base_id = relation.knowledge_base_id
       AND evidence.pair_public_id = relation.pair_public_id
       AND (${visibleEvidence(sql, included, excluded)})
      JOIN focowiki.document_projection_records first_record
        ON first_record.knowledge_base_id = relation.knowledge_base_id
       AND first_record.source_revision_public_id
         = relation.first_source_revision_public_id
       AND (${visibleRecord(sql, "first_record", included, excluded)})
      JOIN focowiki.document_projection_records second_record
        ON second_record.knowledge_base_id = relation.knowledge_base_id
       AND second_record.source_revision_public_id
         = relation.second_source_revision_public_id
       AND (${visibleRecord(sql, "second_record", included, excluded)})
      JOIN LATERAL (
        SELECT membership.page_path, membership.directory_path
        FROM focowiki.document_semantic_directory_memberships membership
        WHERE membership.knowledge_base_id = first_record.knowledge_base_id
          AND membership.source_revision_public_id
            = first_record.source_revision_public_id
        ORDER BY char_length(membership.directory_path) DESC
        LIMIT 1
      ) first_page ON true
      JOIN LATERAL (
        SELECT membership.page_path, membership.directory_path
        FROM focowiki.document_semantic_directory_memberships membership
        WHERE membership.knowledge_base_id = second_record.knowledge_base_id
          AND membership.source_revision_public_id
            = second_record.source_revision_public_id
        ORDER BY char_length(membership.directory_path) DESC
        LIMIT 1
      ) second_page ON true
      WHERE relation.knowledge_base_id = ${input.knowledgeBaseId}
        AND (${visibleRelation(sql, included, excluded)})
        AND (${input.affectedSourceFilePublicIds === null}
          OR relation.first_source_file_public_id
               = ANY(${input.affectedSourceFilePublicIds ?? []}::text[])
          OR relation.second_source_file_public_id
               = ANY(${input.affectedSourceFilePublicIds ?? []}::text[]))
    ), scoped_rows AS (
      SELECT graph_rows.*,
             CASE WHEN first_direct THEN first_path ELSE second_path END
               AS local_path,
             CASE WHEN first_direct THEN second_path ELSE first_path END
               AS remote_path,
             CASE WHEN first_direct THEN first_source_file_public_id
                  ELSE second_source_file_public_id END
               AS local_source_file_public_id
      FROM graph_rows
      WHERE first_direct OR second_direct
    )
    SELECT relation_public_id, evidence_public_id,
           first_path, first_title, second_path, second_title,
           first_source_file_public_id, second_source_file_public_id,
           evidence_source_file_public_id, relation_kind, evidence_kind,
           evidence, local_path, remote_path, local_source_file_public_id
    FROM scoped_rows
    WHERE ${input.cursor === null}
       OR (local_path COLLATE "C", remote_path COLLATE "C",
           relation_kind::text COLLATE "C", relation_public_id COLLATE "C",
           evidence_public_id COLLATE "C")
          > (${input.cursor?.local_path ?? ""},
             ${input.cursor?.remote_path ?? ""},
             ${input.cursor?.relation_kind ?? "references"},
             ${input.cursor?.relation_public_id ?? ""},
             ${input.cursor?.evidence_public_id ?? ""})
    ORDER BY local_path COLLATE "C", remote_path COLLATE "C",
             relation_kind::text COLLATE "C", relation_public_id COLLATE "C",
             evidence_public_id COLLATE "C"
    LIMIT ${GRAPH_DIRECTORY_READ_PAGE_SIZE}
  `;
  input.signal?.throwIfAborted();
  return rows;
}

function createRelationshipAccumulator(scopePath: string) {
  let current: DirectoryRelationshipGroup | null = null;
  let finished = false;
  function flush(): Record<string, unknown> | null {
    if (current === null) return null;
    const record = finishRelationshipGroup(current);
    current = null;
    return record;
  }
  return {
    append(rows: readonly GraphDirectoryRow[]): Record<string, unknown>[] {
      if (finished) throw scannerError("graph_directory_scan_finished");
      const records: Record<string, unknown>[] = [];
      for (const row of rows) {
        const key = `${row.relation_public_id}\0${
          row.local_source_file_public_id}`;
        if (current !== null && key !== current.key) {
          const completed = flush();
          if (completed) records.push(completed);
        }
        current = appendRelationshipRow(current, row, scopePath);
      }
      return records;
    },
    finish(): Record<string, unknown>[] {
      if (finished) throw scannerError("graph_directory_scan_finished");
      finished = true;
      const completed = flush();
      return completed ? [completed] : [];
    }
  };
}

function appendRelationshipRow(
  group: DirectoryRelationshipGroup | null,
  row: GraphDirectoryRow,
  scopePath: string
): DirectoryRelationshipGroup {
  const firstInScope = posix.dirname(row.first_path) === scopePath;
  const secondInScope = posix.dirname(row.second_path) === scopePath;
  if (!firstInScope && !secondInScope) {
    throw scannerError("graph_directory_endpoint_missing");
  }
  const localIsFirst = firstInScope;
  const evidenceFromFirst = row.evidence_source_file_public_id
    === row.first_source_file_public_id;
  const evidenceRecord = documentRelationProjectionRecord({
    fromPath: sourceLogicalPath(evidenceFromFirst
      ? row.first_path : row.second_path),
    toPath: sourceLogicalPath(evidenceFromFirst
      ? row.second_path : row.first_path),
    fromTitle: evidenceFromFirst ? row.first_title : row.second_title,
    toTitle: evidenceFromFirst ? row.second_title : row.first_title,
    relationType: row.relation_kind,
    evidenceKind: machineEvidenceKind(row.evidence_kind),
    evidenceValue: row.evidence
  });
  const direction = row.evidence_source_file_public_id
    === (localIsFirst
      ? row.first_source_file_public_id
      : row.second_source_file_public_id)
    ? "outgoing" as const : "incoming" as const;
  const key = `${row.relation_public_id}\0${row.local_source_file_public_id}`;
  const current = group ?? {
    key,
    record: {
      ...evidenceRecord,
      from: row.local_path,
      to: row.remote_path,
      fromTitle: localIsFirst ? row.first_title : row.second_title,
      toTitle: localIsFirst ? row.second_title : row.first_title,
      direction
    },
    directions: new Set<"incoming" | "outgoing">(),
    evidence: [],
    evidenceKeys: new Set<string>()
  };
  if (current.key !== key) {
    throw scannerError("graph_directory_group_unordered");
  }
  current.directions.add(direction);
  for (const item of Array.isArray(evidenceRecord.evidence)
    ? evidenceRecord.evidence : []) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue;
    const evidence = item as Record<string, unknown>;
    const evidenceKey = JSON.stringify(evidence);
    if (current.evidenceKeys.has(evidenceKey)) continue;
    current.evidenceKeys.add(evidenceKey);
    current.evidence.push(evidence);
  }
  return current;
}

function finishRelationshipGroup(
  group: DirectoryRelationshipGroup
): Record<string, unknown> {
  return {
    ...group.record,
    direction: group.directions.size === 2 ? "bidirectional"
      : group.directions.has("outgoing") ? "outgoing" : "incoming",
    evidence: group.evidence
  };
}

function machineEvidenceKind(value: PerFileGraphRow["evidence_kind"]):
  "markdown_link" | "stable_alias" | "semantic" {
  if (value === "explicit_reference") return "markdown_link";
  if (value === "title_alias") return "stable_alias";
  return "semantic";
}

function sourceLogicalPath(pagePath: string): string {
  return pagePath.startsWith("pages/") ? pagePath.slice("pages/".length) : pagePath;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en-US"));
}

function scannerError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Document graph directory scanner error: ${code}`),
    { code }
  );
}
