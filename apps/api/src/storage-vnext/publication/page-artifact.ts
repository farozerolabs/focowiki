import {
  deduplicateGraphRelationships,
  presentGraphRelationship,
  resolveSourceMetadata,
  type SourceMetadataDefaults,
  type SourceMetadataSuggestions
} from "@focowiki/okf";
import {
  applyPresentationSuggestions,
  prepareSourceBodyForPublication
} from "../../okf/publication-files.js";
import type { StorageVnextCurrentSourceFact } from "../catalog/ports.js";
import type {
  StorageVnextGraphEdgeFact,
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type {
  StorageVnextPublicDocument,
  StorageVnextPublicValue
} from "../shared/types.js";
import { renderStorageVnextPageArtifact } from "./rendering.js";
import type { StorageVnextPublicationArtifact } from "./types.js";

export function assembleStorageVnextPageArtifact(input: {
  current: StorageVnextCurrentSourceFact;
  node: StorageVnextGraphNodeFact;
  neighborhood: readonly StorageVnextGraphEdgeFact[];
  endpointNodes: readonly StorageVnextGraphNodeFact[];
  sourceBody: string;
  removedSourceLogicalPaths?: readonly string[] | undefined;
  ordinal: number;
  relatedFileLimit: number;
}): StorageVnextPublicationArtifact {
  validateInput(input);
  const fileName = input.current.sourceFile.logicalPath.split("/").at(-1)!;
  const suggestions = readPresentationSuggestions(
    input.node.metadata.presentationSuggestion
  );
  const resolved = resolveSourceMetadata({
    fileName,
    content: input.sourceBody,
    metadata: input.current.sourceFile.metadata as unknown as SourceMetadataDefaults,
    suggestions
  });
  const profile = readDocument(input.node.metadata.contentProfile);
  const presentationBody = prepareSourceBodyForPublication(
    readString(profile?.summary) ?? resolved.body,
    input.node.logicalPath,
    input.removedSourceLogicalPaths ?? []
  ).content;
  const metadata = applyPresentationSuggestions(
    resolved.metadata,
    suggestions,
    { body: presentationBody, fileName }
  );
  const nodes = new Map(input.endpointNodes.map((node) => [node.publicId, node]));
  const graphLinks = deduplicateGraphRelationships(input.neighborhood.map((edge) => {
    const from = nodes.get(edge.fromNodePublicId);
    const to = nodes.get(edge.toNodePublicId);
    if (!from || !to || !edge.source?.trim()) {
      throw pageArtifactError("graph_endpoint_conflict");
    }
    return presentGraphRelationship({
      from: endpoint(from),
      to: endpoint(to),
      relationType: edge.relation,
      weight: edge.weight,
      reason: edge.reason ?? "",
      source: edge.source,
      ...(edge.metadata ? { evidence: edge.metadata } : {})
    }, input.current.sourceFile.publicId);
  })).slice(0, input.relatedFileLimit);

  return renderStorageVnextPageArtifact({
    page: {
      pagePath: input.node.logicalPath,
      fileId: input.current.sourceFile.publicId,
      metadata,
      suggestions: null,
      graphLinks
    },
    sourceBody: input.sourceBody,
    removedSourceLogicalPaths: input.removedSourceLogicalPaths,
    ordinal: input.ordinal
  });
}

function validateInput(input: {
  current: StorageVnextCurrentSourceFact;
  node: StorageVnextGraphNodeFact;
  neighborhood: readonly StorageVnextGraphEdgeFact[];
  endpointNodes: readonly StorageVnextGraphNodeFact[];
  sourceBody: string;
  relatedFileLimit: number;
}): void {
  const { sourceFile, sourceRevision } = input.current;
  if (
    !Number.isSafeInteger(input.relatedFileLimit)
    || input.relatedFileLimit < 1
    || input.relatedFileLimit > 1_000
    || sourceFile.visibility !== "current"
    || sourceFile.status !== "ready"
    || sourceFile.currentRevisionPublicId !== sourceRevision.publicId
    || sourceFile.publicId !== sourceRevision.sourceFilePublicId
    || sourceFile.knowledgeBaseId !== sourceRevision.knowledgeBaseId
    || input.node.knowledgeBaseId !== sourceFile.knowledgeBaseId
    || input.node.sourceFilePublicId !== sourceFile.publicId
    || input.node.sourceRevisionPublicId !== sourceRevision.publicId
    || input.node.logicalPath !== `pages/${sourceFile.logicalPath}`
    || !sourceFile.logicalPath.toLocaleLowerCase("en-US").endsWith(".md")
    || typeof input.sourceBody !== "string"
  ) throw pageArtifactError("source_scope_conflict");
  if (input.endpointNodes.some((node) =>
    node.knowledgeBaseId !== sourceFile.knowledgeBaseId)) {
    throw pageArtifactError("graph_scope_conflict");
  }
  if (input.neighborhood.some((edge) =>
    edge.knowledgeBaseId !== sourceFile.knowledgeBaseId
    || (
      edge.fromNodePublicId !== input.node.publicId
      && edge.toNodePublicId !== input.node.publicId
    ))) throw pageArtifactError("graph_scope_conflict");
}

function endpoint(node: StorageVnextGraphNodeFact) {
  return {
    fileId: node.sourceFilePublicId,
    path: node.logicalPath,
    title: node.label
  };
}

function readPresentationSuggestions(
  value: StorageVnextPublicValue | undefined
): SourceMetadataSuggestions | null {
  const document = readDocument(value);
  const description = readString(document?.description);
  return description ? { description } : null;
}

function readDocument(
  value: StorageVnextPublicValue | undefined
): StorageVnextPublicDocument | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as StorageVnextPublicDocument
    : null;
}

function readString(value: StorageVnextPublicValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function pageArtifactError(code: string): Error & { code: string } {
  return Object.assign(
    new Error(`Storage vNext publication page artifact error: ${code}`),
    { code }
  );
}
