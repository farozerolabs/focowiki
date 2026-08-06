import type { OkfGraphNode } from "@focowiki/okf";
import type {
  StorageVnextGraphNodeFact
} from "../graph/ports.js";
import type {
  StorageVnextPublicDocument,
  StorageVnextPublicValue,
  StorageVnextStructuredMetadata
} from "../shared/types.js";

export const MAXIMUM_GRAPH_METADATA_BYTES = 7_500;

export function createStorageVnextGraphMetadata(
  node: OkfGraphNode,
  suggestions: { description?: unknown } | null
): StorageVnextStructuredMetadata {
  const contentProfile = readDocument(node.metadata?.contentProfile);
  const suggestedDescription = typeof suggestions?.description === "string"
    ? suggestions.description.trim()
    : "";
  const metadata: StorageVnextStructuredMetadata = {
    tags: node.tags ?? [],
    ...(suggestedDescription && suggestedDescription.length <= 500
      ? { presentationSuggestion: { description: suggestedDescription } }
      : {}),
    ...(contentProfile ? { contentProfile } : {})
  };
  return boundGraphMetadata(metadata);
}

export function toOkfGraphNode(node: StorageVnextGraphNodeFact): OkfGraphNode {
  const profile = readDocument(node.metadata.contentProfile);
  return {
    fileId: node.sourceFilePublicId,
    path: node.logicalPath,
    title: node.label,
    type: node.kind,
    description: readString(profile?.summary),
    summary: readString(profile?.summary),
    subjects: readStringList(profile?.subjects),
    tags: readStringList(node.metadata.tags),
    entities: readStringList(profile?.entities),
    explicitReferences: readStringList(profile?.explicitReferences),
    relationshipHints: readStringList(profile?.relationshipHints),
    headings: readStringList(profile?.headingOutline),
    keywords: readStringList(profile?.keywords),
    language: readString(profile?.language),
    profileVersion: readString(profile?.profileVersion),
    profileSource: readString(profile?.profileSource),
    metadata: node.metadata as Record<string, unknown>
  };
}

function boundGraphMetadata(
  value: StorageVnextStructuredMetadata
): StorageVnextStructuredMetadata {
  const metadata = JSON.parse(JSON.stringify(value)) as StorageVnextStructuredMetadata;
  const profile = readDocument(metadata.contentProfile) as
    | Record<string, StorageVnextPublicValue>
    | null;
  if (profile && typeof profile.summary === "string" && profile.summary.length > 500) {
    profile.summary = profile.summary.slice(0, 500);
  }
  const arrayFields = [
    "evidencePhrases",
    "relationshipHints",
    "processHints",
    "versionHints",
    "definitions",
    "headingOutline",
    "explicitReferences",
    "entities",
    "keywords",
    "subjects"
  ] as const;
  while (metadataBytes(metadata) > MAXIMUM_GRAPH_METADATA_BYTES) {
    let removed = false;
    for (const field of arrayFields) {
      const items = profile?.[field];
      if (!Array.isArray(items) || items.length === 0) continue;
      items.pop();
      removed = true;
      if (metadataBytes(metadata) <= MAXIMUM_GRAPH_METADATA_BYTES) break;
    }
    if (removed) continue;
    const tags = metadata.tags;
    if (Array.isArray(tags) && tags.length > 0) {
      tags.pop();
      continue;
    }
    if (profile && typeof profile.summary === "string" && profile.summary.length > 0) {
      profile.summary = profile.summary.slice(0, Math.floor(profile.summary.length / 2));
      continue;
    }
    throw graphMetadataError();
  }
  return metadata;
}

function metadataBytes(value: StorageVnextStructuredMetadata): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function readDocument(value: unknown): StorageVnextPublicDocument | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as StorageVnextPublicDocument
    : null;
}

function readString(value: StorageVnextPublicValue | undefined): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readStringList(value: StorageVnextPublicValue | undefined): string[] {
  return Array.isArray(value)
    ? value.flatMap((item) => typeof item === "string" && item.trim() ? [item.trim()] : [])
    : [];
}

function graphMetadataError(): Error & { code: string } {
  return Object.assign(
    new Error("Storage vNext source graph extractor error: graph_metadata_too_large"),
    { code: "graph_metadata_too_large" }
  );
}
