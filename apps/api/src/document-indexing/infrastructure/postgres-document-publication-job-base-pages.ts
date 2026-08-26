import {
  portableGraphDirectoryPath,
  portableIndexDirectoryPath
} from "@focowiki/okf";
import type { DatabaseClient } from "../../db/client.js";
import type {
  DocumentPublicationBasePage,
  DocumentPublicationRenderScope
} from "../application/document-publication-job-ports.js";

const MAXIMUM_SCOPE_BASE_PAGES = 10_000;

export async function readPostgresDocumentPublicationBaseEventTime(
  sql: DatabaseClient,
  input: Readonly<{
    knowledgeBaseId: string;
    baseActiveRevision: number;
  }>
): Promise<string | null> {
  if (input.baseActiveRevision === 0) return null;
  const rows = await sql<Array<{ created_at: Date | string }>>`
    SELECT job.created_at
    FROM focowiki.knowledge_base_publication_heads head
    JOIN focowiki.publication_jobs job
      ON job.public_id = head.active_job_public_id
     AND job.outcome = 'committed'
    WHERE head.knowledge_base_id = ${input.knowledgeBaseId}
      AND head.active_revision = ${input.baseActiveRevision}
    LIMIT 1
  `;
  const value = rows[0]?.created_at;
  if (!value) throw basePageError("publication_active_base_changed");
  return value instanceof Date ? value.toISOString() : value;
}

export async function readPostgresDocumentPublicationJobBasePages(
  sql: DatabaseClient,
  scope: DocumentPublicationRenderScope
): Promise<readonly DocumentPublicationBasePage[]> {
  const selector = baseSelector(scope);
  if (selector.mode === "none") return [];
  const rows = await sql<Array<{
    logical_path: string;
    normalized_path: string;
    entry_kind: string;
    source_file_public_id: string | null;
    source_revision_public_id: string | null;
    object_id: string;
    checksum_sha256: string;
    byte_count: number | string;
    storage_key: string;
    content_type: string;
    object_format: string;
  }>>`
    SELECT head.logical_path, head.normalized_path, head.entry_kind,
           head.source_file_public_id, head.source_revision_public_id,
           head.object_id, head.checksum_sha256, head.byte_count,
           registration.storage_key, registration.content_type,
           registration.object_format
    FROM focowiki.generated_page_heads head
    JOIN focowiki.object_registrations registration
      ON registration.object_id = head.object_id
     AND registration.state = 'verified'
    WHERE head.knowledge_base_id = ${scope.knowledgeBaseId}
      AND (
        (${selector.mode} = 'exact'
          AND head.normalized_path = ${selector.path})
        OR (${selector.mode} = 'directory'
          AND left(head.normalized_path, char_length(${selector.path}) + 1)
                = ${`${selector.path}/`}
          AND position('/' in substring(head.normalized_path
                from char_length(${selector.path}) + 2)) = 0)
        OR (${selector.mode} = 'source_pages'
          AND head.source_file_public_id = ${scope.key}
          AND left(head.normalized_path, char_length('pages/')) = 'pages/')
        OR (${selector.mode} = 'source_graph'
          AND head.source_file_public_id = ${scope.key}
          AND left(head.normalized_path, char_length('_graph/by-file/'))
                = '_graph/by-file/')
        OR (${selector.mode} = 'root'
          AND (head.normalized_path IN (
                 'index.md', 'log.md', '_index/catalog.json'
               )
            OR (left(head.normalized_path, char_length('_index/')) = '_index/'
              AND position('/' in substring(head.normalized_path
                    from char_length('_index/') + 1)) = 0)
            OR (left(head.normalized_path, char_length('_graph/')) = '_graph/'
              AND position('/' in substring(head.normalized_path
                    from char_length('_graph/') + 1)) = 0)))
      )
    ORDER BY head.normalized_path COLLATE "C"
    LIMIT ${MAXIMUM_SCOPE_BASE_PAGES + 1}
  `;
  if (rows.length > MAXIMUM_SCOPE_BASE_PAGES) {
    throw basePageError("publication_base_page_limit_exceeded");
  }
  return rows.map((row) => ({
    logicalPath: row.logical_path,
    normalizedPath: row.normalized_path,
    action: "put" as const,
    entryKind: row.entry_kind,
    objectId: row.object_id,
    checksumSha256: row.checksum_sha256,
    byteCount: Number(row.byte_count),
    storageKey: row.storage_key,
    contentType: row.content_type,
    objectFormat: row.object_format
  }));
}

type BaseSelector = Readonly<{ mode: "none" }> | Readonly<{
  mode: "exact" | "directory" | "source_pages" | "source_graph" | "root";
  path: string;
}>;

function baseSelector(scope: DocumentPublicationRenderScope): BaseSelector {
  if (scope.kind === "source") {
    return { mode: "source_pages", path: "pages" };
  }
  if (scope.kind === "directory") {
    return { mode: "none" };
  }
  if (scope.kind === "_index" && scope.key.startsWith("pages:")) {
    return {
      mode: "directory",
      path: portableIndexDirectoryPath(scope.key.slice("pages:".length))
    };
  }
  if (scope.kind === "_index" && scope.key.startsWith("term:")) {
    return {
      mode: "directory",
      path: `_index/terms/${scope.key.slice("term:".length)}`
    };
  }
  if (scope.kind === "_index" && scope.key === "term-catalog") {
    return { mode: "directory", path: "_index/terms" };
  }
  if (scope.kind === "_graph" && scope.key === "catalog") {
    return { mode: "exact", path: "_graph/catalog.json" };
  }
  if (scope.kind === "_graph" && scope.key.startsWith("directory:")) {
    return {
      mode: "directory",
      path: portableGraphDirectoryPath(scope.key.slice("directory:".length))
    };
  }
  if (scope.kind === "_graph" && scope.key.startsWith("file-directory:")) {
    return { mode: "none" };
  }
  if (scope.kind === "_graph") {
    return { mode: "source_graph", path: "_graph/by-file" };
  }
  if (scope.kind === "root") return { mode: "root", path: "" };
  return { mode: "exact", path: "__not_present__" };
}

function basePageError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication base page error: ${code}`), {
    code
  });
}
