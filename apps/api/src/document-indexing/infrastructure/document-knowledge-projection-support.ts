import type { ProjectionDirtyScopeKind } from
  "./postgres-projection-dirty-scope-repository.js";
import { normalizeLogicalPath } from "./production-document-processor-support.js";

export type DocumentRelationPlan = {
  pairPublicIds: readonly string[];
  relationPublicIds: readonly string[];
  affectedSourceFilePublicIds: readonly string[];
};

export type ParsedDocumentRelationPlan = Omit<
  DocumentRelationPlan,
  "relationPublicIds"
> & {
  relationPublicIds: readonly string[] | null;
};

export function documentProjectionHeadLookupPaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(normalizeLogicalPath))].sort();
}

export function documentProjectionSourceFileIds(input: {
  currentSourceFilePublicId: string;
  affectedSourceFilePublicIds: readonly string[];
}): string[] {
  return [...new Set([
    input.currentSourceFilePublicId,
    ...input.affectedSourceFilePublicIds
  ])].sort();
}

export function documentProjectionRenderableSourceFileIds(input: {
  currentSourceFilePublicId: string;
  affectedSourceFilePublicIds: readonly string[];
  relations: readonly {
    firstSourceFilePublicId: string;
    secondSourceFilePublicId: string;
  }[];
}): string[] {
  return [...new Set([
    ...documentProjectionSourceFileIds({
      currentSourceFilePublicId: input.currentSourceFilePublicId,
      affectedSourceFilePublicIds: input.affectedSourceFilePublicIds
    }),
    ...input.relations.flatMap((relation) => [
      relation.firstSourceFilePublicId,
      relation.secondSourceFilePublicId
    ])
  ])].sort();
}

export function documentProjectionAvailableSourceFileIds(input: {
  currentSourceFilePublicId: string;
  requestedSourceFilePublicIds: readonly string[];
  availableBaseSourceFilePublicIds: readonly string[];
}): string[] {
  const available = new Set(input.availableBaseSourceFilePublicIds);
  return [...new Set([
    input.currentSourceFilePublicId,
    ...input.requestedSourceFilePublicIds.filter((sourceFilePublicId) =>
      sourceFilePublicId === input.currentSourceFilePublicId
      || available.has(sourceFilePublicId)
    )
  ])];
}

export function documentProjectionGraphDirectoryPaths(input: {
  enabled: boolean;
  currentSourceFilePublicId: string;
  affectedSourceFilePublicIds: readonly string[];
  sourcePaths: readonly {
    sourceFilePublicId: string;
    logicalPath: string;
  }[];
  priorCurrentLogicalPath?: string | null;
}): string[] {
  if (!input.enabled) return [];
  const affected = new Set(input.affectedSourceFilePublicIds);
  return sortedUnique([
    ...input.sourcePaths.filter((source) => affected.has(
      source.sourceFilePublicId)).flatMap((source) =>
      pageDirectoryAncestors(`pages/${source.logicalPath}`)),
    ...(affected.has(input.currentSourceFilePublicId)
      && input.priorCurrentLogicalPath
      ? pageDirectoryAncestors(`pages/${input.priorCurrentLogicalPath}`) : [])
  ]);
}

export function shouldProjectDocumentGraphDirectories(input: {
  relationCount: number;
  affectedSourceFileCount: number;
  hasPriorPresentation: boolean;
}): boolean {
  return input.relationCount > 0
    || input.affectedSourceFileCount > 1
    || input.hasPriorPresentation;
}

export function readDocumentRelationPlan(
  value: Readonly<Record<string, unknown>> | undefined
): ParsedDocumentRelationPlan {
  if (!value
    || value.schemaVersion !== "document-relation-reconciliation-receipt-v1"
    || !Array.isArray(value.pairPublicIds)
    || !Array.isArray(value.affectedSourceFilePublicIds)
    || value.pairPublicIds.some((item) => typeof item !== "string")
    || (value.relationPublicIds !== undefined
      && (!Array.isArray(value.relationPublicIds)
        || value.relationPublicIds.some((item) => typeof item !== "string")))
    || value.affectedSourceFilePublicIds.some(
      (item) => typeof item !== "string"
    )) {
    throw projectionSupportError("relation_reconciliation_receipt_invalid");
  }
  return {
    pairPublicIds: value.pairPublicIds as string[],
    relationPublicIds: value.relationPublicIds === undefined
      ? null : value.relationPublicIds as string[],
    affectedSourceFilePublicIds: value.affectedSourceFilePublicIds as string[]
  };
}

export function documentProjectionScopes(input: {
  relationPublicIds: readonly string[];
  graphSourceFilePublicIds: readonly string[];
  sourceFilePublicIds?: readonly string[];
  directoryPaths?: readonly string[];
  graphDirectoryPaths?: readonly string[];
  navigationMutations: readonly { directoryPath: string }[];
  pages: readonly { sourceFilePublicId: string | null }[];
  termBuckets: readonly string[];
}): Array<{ kind: ProjectionDirtyScopeKind; key: string }> {
  const sourceFilePublicIds = sortedUnique([
    ...(input.sourceFilePublicIds ?? []),
    ...input.pages.flatMap((page) =>
      page.sourceFilePublicId ? [page.sourceFilePublicId] : [])
  ]);
  const relationPublicIds = sortedUnique(input.relationPublicIds);
  const directoryPaths = sortedUnique([
    ...(input.directoryPaths ?? []),
    ...input.navigationMutations.map((mutation) => mutation.directoryPath)
  ]);
  const pageDirectoryPaths = directoryPaths.filter((path) =>
    path === "pages" || path.startsWith("pages/"));
  const graphDirectoryPaths = sortedUnique([
    ...(input.graphDirectoryPaths ?? []),
    ...directoryPaths.flatMap((path) => {
    const prefix = "_graph/by-directory";
    if (path === prefix) return ["pages"];
    if (!path.startsWith(`${prefix}/`)) return [];
    const relative = path.slice(prefix.length + 1);
    return relative ? [`pages/${relative}`] : [];
    })
  ]);
  const graphSourceFilePublicIds = sortedUnique(input.graphSourceFilePublicIds);
  const termBuckets = sortedUnique(input.termBuckets);
  const graphChanged = relationPublicIds.length > 0
    || graphSourceFilePublicIds.length > 0;
  return [...new Map([
    ...sourceFilePublicIds.map((key) => ({ kind: "source" as const, key })),
    ...relationPublicIds.map((key) => ({
      kind: "relation" as const,
      key
    })),
    ...directoryPaths.map((key) => ({
      kind: "directory" as const,
      key
    })),
    ...graphSourceFilePublicIds.map((key) => ({
      kind: "graph" as const,
      key
    })),
    ...pageDirectoryPaths.map((path) => ({
      kind: "_index" as const,
      key: `pages:${path}`
    })),
    ...termBuckets.map((bucket) => ({
      kind: "_index" as const,
      key: `term:${bucket}`
    })),
    ...(termBuckets.length > 0
      ? [{ kind: "_index" as const, key: "term-catalog" }] : []),
    ...graphSourceFilePublicIds.map((key) => ({
      kind: "_graph" as const,
      key
    })),
    ...graphDirectoryPaths.map((path) => ({
      kind: "_graph" as const,
      key: `directory:${path}`
    })),
    ...graphDirectoryPaths.map((path) => ({
      kind: "_graph" as const,
      key: `file-directory:${path}`
    })),
    ...(graphChanged ? [{ kind: "_graph" as const, key: "catalog" }] : []),
    { kind: "root" as const, key: "index" }
  ].map((scope) => [`${scope.kind}\0${scope.key}`, scope])).values()];
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) =>
    left.localeCompare(right, "en"));
}

function pageDirectoryAncestors(pagePath: string): string[] {
  const segments = pagePath.split("/");
  segments.pop();
  const directories: string[] = [];
  while (segments.length > 0) {
    directories.push(segments.join("/"));
    segments.pop();
  }
  return directories.reverse();
}

export function documentActivationOwnerRequests(input: {
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  pairPublicIds: readonly string[];
  familyPublicIds: readonly string[];
  pageCandidates: readonly {
    normalizedPath: string;
    pageCandidatePublicId: string;
  }[];
  removedPaths: readonly string[];
  navigationMutations: readonly {
    directoryPath: string;
    touchedLeaves: readonly {
      id: string;
      entries: readonly { id: string }[];
    }[];
    removedLeafIds: readonly string[];
  }[];
}) {
  return [...new Map([
    {
      kind: "source" as const,
      key: input.sourceFilePublicId,
      activeSourceRevisionPublicId: input.sourceRevisionPublicId,
      activePageCandidatePublicId: null
    },
    ...input.pairPublicIds.map((key) => ({
      kind: "relation_pair" as const,
      key,
      activeSourceRevisionPublicId: null,
      activePageCandidatePublicId: null
    })),
    ...input.familyPublicIds.map((key) => ({
      kind: "search_family" as const,
      key,
      activeSourceRevisionPublicId: input.sourceRevisionPublicId,
      activePageCandidatePublicId: null
    })),
    ...input.pageCandidates.map((page) => ({
      kind: "page_head" as const,
      key: page.normalizedPath,
      activeSourceRevisionPublicId: null,
      activePageCandidatePublicId: page.pageCandidatePublicId
    })),
    ...input.removedPaths.map((key) => ({
      kind: "page_head" as const,
      key,
      activeSourceRevisionPublicId: null,
      activePageCandidatePublicId: null
    })),
    ...input.navigationMutations.flatMap((mutation) => [
      ...mutation.touchedLeaves.flatMap((leaf) => leaf.entries.map((entry) => ({
        kind: "directory_entry" as const,
        key: directoryEntryOwnerKey(mutation.directoryPath, entry.id),
        activeSourceRevisionPublicId: null,
        activePageCandidatePublicId: null
      }))),
      ...mutation.touchedLeaves.map((leaf) => ({
        kind: "directory_leaf" as const,
        key: directoryLeafOwnerKey(mutation.directoryPath, leaf.id),
        activeSourceRevisionPublicId: null,
        activePageCandidatePublicId: null
      })),
      ...mutation.removedLeafIds.map((leafId) => ({
        kind: "directory_leaf" as const,
        key: directoryLeafOwnerKey(mutation.directoryPath, leafId),
        activeSourceRevisionPublicId: null,
        activePageCandidatePublicId: null
      }))
    ])
  ].map((owner) => ({
    ...owner,
    key: normalizeActivationOwnerKey(owner.key)
  })).map((owner) => [`${owner.kind}\0${owner.key}`, owner])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind, "en")
      || left.key.localeCompare(right.key, "en"));
}

export function documentProjectionOutputOwnerRequests(input: {
  pages: readonly { normalizedPath: string }[];
  removedPaths: readonly string[];
  navigationMutations: readonly {
    directoryPath: string;
    touchedLeaves: readonly {
      id: string;
      entries: readonly { id: string }[];
    }[];
    removedLeafIds: readonly string[];
  }[];
}) {
  return [...new Map([
    ...input.pages.map((page) => ({
      kind: "page_head" as const,
      key: normalizeActivationOwnerKey(page.normalizedPath)
    })),
    ...input.removedPaths.map((path) => ({
      kind: "page_head" as const,
      key: normalizeActivationOwnerKey(path)
    })),
    ...input.navigationMutations.flatMap((mutation) => [
      ...mutation.touchedLeaves.flatMap((leaf) => leaf.entries.map((entry) => ({
        kind: "directory_entry" as const,
        key: normalizeActivationOwnerKey(directoryEntryOwnerKey(
          mutation.directoryPath,
          entry.id
        ))
      }))),
      ...mutation.touchedLeaves.map((leaf) => ({
        kind: "directory_leaf" as const,
        key: normalizeActivationOwnerKey(directoryLeafOwnerKey(
          mutation.directoryPath,
          leaf.id
        ))
      })),
      ...mutation.removedLeafIds.map((leafId) => ({
        kind: "directory_leaf" as const,
        key: normalizeActivationOwnerKey(directoryLeafOwnerKey(
          mutation.directoryPath,
          leafId
        ))
      }))
    ])
  ].map((owner) => [`${owner.kind}\0${owner.key}`, owner])).values()]
    .sort((left, right) => left.kind.localeCompare(right.kind, "en")
      || left.key.localeCompare(right.key, "en"));
}

export function documentProjectionActivationOwnerVersions(input: {
  owners: ReturnType<typeof documentActivationOwnerRequests>;
  versions: ReadonlyArray<{
    kind: string;
    key: string;
    version: number;
  }>;
}) {
  const versionByOwner = new Map(input.versions.map((owner) => [
    `${owner.kind}\0${owner.key}`,
    owner.version
  ]));
  const result = input.owners.map((owner) => ({
    ...owner,
    expectedVersion: versionByOwner.get(`${owner.kind}\0${owner.key}`) ?? 0
  }));
  return result;
}

function directoryLeafOwnerKey(directoryPath: string, leafId: string): string {
  return JSON.stringify([directoryPath, leafId]);
}

function directoryEntryOwnerKey(directoryPath: string, entryId: string): string {
  return JSON.stringify([directoryPath, entryId]);
}

function normalizeActivationOwnerKey(value: string): string {
  const normalized = value.normalize("NFKC").trim();
  if (!normalized || Buffer.byteLength(normalized, "utf8") > 2_048) {
    throw projectionSupportError("activation_owner_key_invalid");
  }
  return normalized;
}

export function canonicalDocumentProjectionJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalDocumentProjectionJson).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([key, item]) => `${JSON.stringify(key)}:${
      canonicalDocumentProjectionJson(item)
    }`)
    .join(",")}}`;
}

function projectionSupportError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document knowledge projection error: ${code}`), {
    code
  });
}
