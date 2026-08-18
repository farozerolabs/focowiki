import { createHash } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
import type { DocumentProjectionScopeClaim } from
  "../application/document-scope-projector-runtime.js";
import { PROJECTION_DIRTY_SCOPE_KINDS } from
  "./postgres-projection-dirty-scope-repository.js";

const MAXIMUM_SCOPE_FACTS = 10_000;

export function createPostgresProjectionScopeSnapshot(sql: DatabaseClient) {
  return {
    async render(scope: DocumentProjectionScopeClaim): Promise<{
      outputFingerprintSha256: string;
      factCount: number;
      pages: readonly [];
      removedNormalizedPaths: readonly [];
      navigationMutations: readonly [];
      storageRequests: {
        put: number;
        head: number;
        verification: number;
        attemptedBytes: number;
        retries: number;
        latencyMilliseconds: number;
      };
    }> {
      validateScope(scope);
      const rows = await readScopeRows(sql, scope);
      if (rows.length > MAXIMUM_SCOPE_FACTS) {
        throw scopeSnapshotError("projection_scope_fact_limit_exceeded");
      }
      return {
        outputFingerprintSha256: createHash("sha256")
          .update(canonicalJson({
            kind: scope.kind,
            key: scope.key,
            renderedSequence: scope.renderedSequence,
            facts: rows.map((row) => row.fact)
          }))
          .digest("hex"),
        factCount: rows.length,
        pages: [],
        removedNormalizedPaths: [],
        navigationMutations: [],
        storageRequests: {
          put: 0,
          head: 0,
          verification: 0,
          attemptedBytes: 0,
          retries: 0,
          latencyMilliseconds: 0
        }
      };
    }
  };
}

async function readScopeRows(
  sql: DatabaseClient,
  scope: DocumentProjectionScopeClaim
): Promise<readonly { fact: unknown }[]> {
  if (scope.kind === "source") {
    return sql`
      WITH contributed AS (
        SELECT source_revision_public_id
        FROM focowiki.projection_scope_contributions
        WHERE scope_public_id = ${scope.publicId}
          AND required_sequence <= ${scope.renderedSequence}
      )
      SELECT jsonb_build_object(
        'record', to_jsonb(record), 'degree', to_jsonb(degree)
      ) AS fact
      FROM focowiki.document_projection_records record
      LEFT JOIN focowiki.document_graph_degrees degree
        ON degree.knowledge_base_id = record.knowledge_base_id
       AND degree.source_revision_public_id = record.source_revision_public_id
      WHERE record.knowledge_base_id = ${scope.knowledgeBaseId}
        AND record.source_file_public_id = ${scope.key}
        AND (record.active OR record.source_revision_public_id IN (
          SELECT source_revision_public_id FROM contributed
        ))
      ORDER BY record.source_revision_public_id COLLATE "C"
      LIMIT ${MAXIMUM_SCOPE_FACTS + 1}
    `;
  }
  if (scope.kind === "relation") {
    return sql`
      SELECT jsonb_build_object(
        'relation', to_jsonb(relation),
        'evidence', coalesce(jsonb_agg(to_jsonb(evidence)
          ORDER BY evidence.public_id) FILTER (
            WHERE evidence.public_id IS NOT NULL
          ), '[]'::jsonb)
      ) AS fact
      FROM focowiki.canonical_file_relations relation
      LEFT JOIN focowiki.relation_directed_evidence evidence
        ON evidence.knowledge_base_id = relation.knowledge_base_id
       AND evidence.pair_public_id = relation.pair_public_id
       AND evidence.retired_at IS NULL
      WHERE relation.knowledge_base_id = ${scope.knowledgeBaseId}
        AND relation.public_id = ${scope.key}
        AND relation.retired_at IS NULL
      GROUP BY relation.public_id
      LIMIT 2
    `;
  }
  if (scope.kind === "directory") {
    return sql`
      WITH contributed AS (
        SELECT source_revision_public_id
        FROM focowiki.projection_scope_contributions
        WHERE scope_public_id = ${scope.publicId}
          AND required_sequence <= ${scope.renderedSequence}
      )
      SELECT jsonb_build_object(
        'pagePath', membership.page_path,
        'sourceRevisionPublicId', membership.source_revision_public_id,
        'title', record.title
      ) AS fact
      FROM focowiki.document_semantic_directory_memberships membership
      JOIN focowiki.document_projection_records record
        ON record.knowledge_base_id = membership.knowledge_base_id
       AND record.source_revision_public_id = membership.source_revision_public_id
      WHERE membership.knowledge_base_id = ${scope.knowledgeBaseId}
        AND membership.directory_path = ${scope.key}
        AND (record.active OR record.source_revision_public_id IN (
          SELECT source_revision_public_id FROM contributed
        ))
      ORDER BY membership.page_path COLLATE "C",
               membership.source_revision_public_id COLLATE "C"
      LIMIT ${MAXIMUM_SCOPE_FACTS + 1}
    `;
  }
  if (scope.kind === "_index" && scope.key.startsWith("term:")) {
    const bucket = scope.key.slice("term:".length);
    return sql`
      WITH contributed AS (
        SELECT source_revision_public_id
        FROM focowiki.projection_scope_contributions
        WHERE scope_public_id = ${scope.publicId}
          AND required_sequence <= ${scope.renderedSequence}
      )
      SELECT jsonb_build_object(
        'term', term.term, 'pagePath', posting.page_path,
        'fields', posting.fields,
        'sourceRevisionPublicId', term.source_revision_public_id
      ) AS fact
      FROM focowiki.document_navigation_terms term
      JOIN focowiki.document_navigation_postings posting
        ON posting.knowledge_base_id = term.knowledge_base_id
       AND posting.source_revision_public_id = term.source_revision_public_id
       AND posting.term = term.term
      JOIN focowiki.document_projection_records record
        ON record.knowledge_base_id = term.knowledge_base_id
       AND record.source_revision_public_id = term.source_revision_public_id
      WHERE term.knowledge_base_id = ${scope.knowledgeBaseId}
        AND term.bucket = ${bucket}
        AND (record.active OR record.source_revision_public_id IN (
          SELECT source_revision_public_id FROM contributed
        ))
      ORDER BY term.term COLLATE "C", posting.page_path COLLATE "C"
      LIMIT ${MAXIMUM_SCOPE_FACTS + 1}
    `;
  }
  if (scope.kind === "graph" || scope.kind === "_graph") {
    return sql`
      SELECT jsonb_build_object(
        'sourceRevisionPublicId', degree.source_revision_public_id,
        'incomingCount', degree.incoming_count,
        'outgoingCount', degree.outgoing_count
      ) AS fact
      FROM focowiki.document_graph_degrees degree
      JOIN focowiki.document_projection_records record
        ON record.knowledge_base_id = degree.knowledge_base_id
       AND record.source_revision_public_id = degree.source_revision_public_id
      WHERE degree.knowledge_base_id = ${scope.knowledgeBaseId}
        AND (degree.incoming_count + degree.outgoing_count) > 0
        AND record.active
      ORDER BY degree.source_revision_public_id COLLATE "C"
      LIMIT ${MAXIMUM_SCOPE_FACTS + 1}
    `;
  }
  return sql`
    SELECT jsonb_build_object(
      'sourceFilePublicId', record.source_file_public_id,
      'sourceRevisionPublicId', record.source_revision_public_id,
      'pagePath', concat('pages/', record.logical_path),
      'title', record.title
    ) AS fact
    FROM focowiki.document_projection_records record
    WHERE record.knowledge_base_id = ${scope.knowledgeBaseId}
      AND record.active
    ORDER BY record.normalized_path COLLATE "C",
             record.source_revision_public_id COLLATE "C"
    LIMIT ${MAXIMUM_SCOPE_FACTS + 1}
  `;
}

function validateScope(scope: DocumentProjectionScopeClaim): void {
  if (!scope.publicId || !scope.knowledgeBaseId || !scope.key
    || !PROJECTION_DIRTY_SCOPE_KINDS.includes(scope.kind)
    || !Number.isSafeInteger(scope.renderedSequence)
    || scope.renderedSequence < 1) {
    throw scopeSnapshotError("projection_scope_snapshot_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right, "en-US"))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
}

function scopeSnapshotError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Projection scope snapshot error: ${code}`), {
    code
  });
}
