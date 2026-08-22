import { posix } from "node:path";
import type {
  DocumentPublicationFactDelta,
  DocumentPublicationScopeNode
} from "./document-publication-planner.js";

export function documentPublicationScopeMembers(input: Readonly<{
  scope: DocumentPublicationScopeNode;
  documents: readonly DocumentPublicationFactDelta[];
  activeSourceRevisions?: readonly Readonly<{
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    activationSequence: number;
  }>[];
}>) {
  const affectedDocuments = input.documents.filter((document) => affectsScope(
    document,
    input.scope
  ));
  const members = affectedDocuments.map(snapshotMember);
  const memberSourceFilePublicIds = new Set(affectedDocuments.map(
    (document) => document.sourceFilePublicId
  ));
  if (input.scope.kind === "source"
    && !input.documents.some((document) =>
      document.sourceFilePublicId === input.scope.key)) {
    const active = input.activeSourceRevisions?.find((revision) =>
      revision.sourceFilePublicId === input.scope.key);
    if (active) {
      members.push({
        kind: "source_revision",
        publicId: active.sourceRevisionPublicId,
        version: String(active.activationSequence)
      });
    }
  }
  for (const sourceFilePublicId of graphScopeSourceFilePublicIds(
    input.scope,
    affectedDocuments
  )) {
    if (memberSourceFilePublicIds.has(sourceFilePublicId)) continue;
    const document = input.documents.find((candidate) =>
      candidate.sourceFilePublicId === sourceFilePublicId);
    if (document) {
      members.push(snapshotMember(document));
      memberSourceFilePublicIds.add(sourceFilePublicId);
      continue;
    }
    const active = input.activeSourceRevisions?.find((revision) =>
      revision.sourceFilePublicId === sourceFilePublicId);
    if (!active) continue;
    members.push({
      kind: "source_revision",
      publicId: active.sourceRevisionPublicId,
      version: String(active.activationSequence)
    });
    memberSourceFilePublicIds.add(sourceFilePublicId);
  }
  return members.map((member, order) => ({ ...member, order }));
}

function snapshotMember(document: DocumentPublicationFactDelta) {
  return {
    kind: document.operation === "delete"
      ? "tombstone" as const : "source_revision" as const,
    publicId: document.operation === "delete"
      ? document.sourceFilePublicId : document.sourceRevisionPublicId,
    version: String(document.factEpoch)
  };
}

function graphScopeSourceFilePublicIds(
  scope: DocumentPublicationScopeNode,
  affectedDocuments: readonly DocumentPublicationFactDelta[]
): readonly string[] {
  if (!scope.identity.startsWith("_graph:")
    || scope.identity === "_graph:catalog") return [];
  if (scope.identity.startsWith("_graph:directory:")
    || scope.identity.startsWith("_graph:file-directory:")) {
    return scope.dependsOn.flatMap((dependency) =>
      /^_graph:[^:]+$/u.test(dependency)
        ? [dependency.slice("_graph:".length)] : []);
  }
  return [...new Set([
    scope.key,
    ...affectedDocuments.flatMap((document) =>
      document.relatedSourceFilePublicIds)
  ])];
}

function affectsScope(
  document: DocumentPublicationFactDelta,
  scope: DocumentPublicationScopeNode
): boolean {
  if (scope.kind === "root" || scope.kind === "validation"
    || scope.identity === "_index:term-catalog"
    || scope.identity === "_graph:catalog") return true;
  if (scope.identity.startsWith("source:")) {
    const source = scope.identity.slice("source:".length);
    return source === document.sourceFilePublicId
      || document.relatedSourceFilePublicIds.includes(source);
  }
  if (scope.identity.startsWith("_graph:")
    && !scope.identity.startsWith("_graph:directory:")
    && !scope.identity.startsWith("_graph:file-directory:")) {
    const source = scope.identity.slice("_graph:".length);
    return source === document.sourceFilePublicId
      || document.relatedSourceFilePublicIds.includes(source);
  }
  if (scope.identity.startsWith("_index:term:")) {
    const bucket = scope.identity.slice("_index:term:".length);
    return document.priorTermBuckets.includes(bucket)
      || document.nextTermBuckets.includes(bucket);
  }
  if (scope.identity.startsWith("directory:")) {
    return paths(document).some((path) =>
      isInside(path, scope.identity.slice("directory:".length)));
  }
  if (scope.identity.startsWith("_index:pages:")) {
    return paths(document).some((path) =>
      isInside(path, scope.identity.slice("_index:pages:".length)));
  }
  if (scope.identity.startsWith("_graph:directory:")
    || scope.identity.startsWith("_graph:file-directory:")) {
    const directory = scope.identity.replace(
      /^_graph:(?:file-)?directory:/u,
      ""
    );
    return document.priorGraphDirectoryPaths.includes(directory)
      || document.nextGraphDirectoryPaths.includes(directory);
  }
  return false;
}

function paths(document: DocumentPublicationFactDelta): readonly string[] {
  return [document.priorLogicalPath, document.nextLogicalPath]
    .flatMap((path) => path ? [`pages/${path}`] : []);
}

function isInside(path: string, directory: string): boolean {
  return path === directory || path.startsWith(`${directory}/`)
    || posix.dirname(path) === directory;
}
