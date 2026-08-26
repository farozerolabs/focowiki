import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { DocumentPublicationItemDelta } from
  "./document-publication-job-plan.js";

export const DOCUMENT_PUBLICATION_PLANNING_MODES = [
  "initial", "delta", "repair"
] as const;

export type DocumentPublicationPlanningMode =
  (typeof DOCUMENT_PUBLICATION_PLANNING_MODES)[number];

export type DocumentPublicationAffectedMember = Readonly<{
  kind: "source" | "revision" | "prior_path" | "successor_path"
    | "relation_endpoint" | "directory" | "record_owner"
    | "navigation_neighbor" | "term_bucket" | "graph_directory"
    | "search_owner" | "tombstone" | "root";
  publicId: string;
  sourceFilePublicId: string | null;
  order: number;
}>;

export function buildDocumentPublicationAffectedClosure(input: Readonly<{
  planningMode: DocumentPublicationPlanningMode;
  documents: readonly DocumentPublicationItemDelta[];
}>) {
  if (!DOCUMENT_PUBLICATION_PLANNING_MODES.includes(input.planningMode)) {
    throw closureError("publication_planning_mode_invalid");
  }
  const members = new Map<string, Omit<DocumentPublicationAffectedMember,
    "order">>();
  const add = (
    kind: DocumentPublicationAffectedMember["kind"],
    publicId: string | null,
    sourceFilePublicId: string | null
  ) => {
    if (!publicId) return;
    members.set(`${kind}\0${publicId}`, { kind, publicId, sourceFilePublicId });
  };
  for (const document of input.documents) {
    add("source", document.sourceFilePublicId, document.sourceFilePublicId);
    add("record_owner", document.sourceFilePublicId, document.sourceFilePublicId);
    add("search_owner", document.sourceFilePublicId,
      document.sourceFilePublicId);
    add("revision", document.sourceRevisionPublicId,
      document.sourceFilePublicId);
    add("prior_path", document.priorLogicalPath, document.sourceFilePublicId);
    add("successor_path", document.nextLogicalPath,
      document.sourceFilePublicId);
    for (const sourceFilePublicId of document.relatedSourceFilePublicIds) {
      add("relation_endpoint", sourceFilePublicId, sourceFilePublicId);
      add("search_owner", sourceFilePublicId, sourceFilePublicId);
    }
    for (const bucket of [
      ...document.priorTermBuckets,
      ...document.nextTermBuckets
    ]) add("term_bucket", bucket, null);
    for (const path of [document.priorLogicalPath, document.nextLogicalPath]) {
      for (const directory of directoryAncestors(path)) {
        add("directory", directory, null);
        add("navigation_neighbor", directory, null);
      }
    }
    for (const directory of [
      ...document.priorGraphDirectoryPaths,
      ...document.nextGraphDirectoryPaths
    ]) {
      add("directory", directory, null);
      add("graph_directory", directory, null);
    }
    if (document.operation === "delete"
      || (document.priorLogicalPath !== null
        && document.priorLogicalPath !== document.nextLogicalPath)) {
      add("tombstone", document.sourceFilePublicId,
        document.sourceFilePublicId);
    }
  }
  if (input.documents.length > 0) {
    for (const root of ["index.md", "_index/index.md", "_graph/index.md"]) {
      add("root", root, null);
    }
  }
  const ordered = [...members.values()].sort((left, right) =>
    bytewise(left.kind, right.kind) || bytewise(left.publicId, right.publicId)
  ).map((member, order) => ({ ...member, order }));
  if (input.planningMode === "delta" && ordered.length === 0) {
    throw closureError("publication_delta_closure_incomplete");
  }
  return {
    planningMode: input.planningMode,
    members: ordered,
    fingerprintSha256: createHash("sha256").update(JSON.stringify(
      ordered.map(({ kind, publicId, sourceFilePublicId }) =>
        [kind, publicId, sourceFilePublicId])
    )).digest("hex")
  };
}

function directoryAncestors(path: string | null): string[] {
  if (!path) return [];
  const normalized = path.startsWith("pages/") ? path : `pages/${path}`;
  const ancestors: string[] = [];
  let current = posix.dirname(normalized);
  while (current === "pages" || current.startsWith("pages/")) {
    ancestors.push(current);
    if (current === "pages") break;
    current = posix.dirname(current);
  }
  return ancestors;
}

function bytewise(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function closureError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Publication closure error: ${code}`), { code });
}
