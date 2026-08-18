import { createHash } from "node:crypto";
import type { CanonicalFileRelation } from "../domain/file-relation.js";

export type DocumentSearchDocument = {
  publicId: string;
  schemaVersion: "document-search-v1";
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  searchContractSha256: string;
  documentKind: "file" | "segment" | "graph_seed" | "file_relationship";
  logicalPath: string;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
  segmentOrdinal: number | null;
  headingAncestors: readonly string[];
  searchText: string;
  embeddingArtifactPublicId: string | null;
  rankingTerms?: readonly string[];
  relationPublicId?: string;
  evidencePublicId?: string;
  targetSourceFilePublicId?: string;
  targetSourceRevisionPublicId?: string;
  targetLogicalPath?: string;
  targetTitle?: string;
  relationKind?: "references" | "related";
  direction?: "incoming" | "outgoing" | "bidirectional";
};

export function prepareDocumentSearchDocuments(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  searchContractSha256: string;
  logicalPath: string;
  title: string;
  metadata: Readonly<Record<string, unknown>>;
  fileSearchText: string;
  graphSeed?: {
    searchText: string;
    rankingTerms: readonly string[];
  };
  segments: readonly {
    publicId: string;
    ordinal: number;
    headingAncestors: readonly string[];
    searchText: string;
    embeddingArtifactPublicId: string;
  }[];
}): DocumentSearchDocument[] {
  assertInput(input);
  const metadataSearchText = canonicalJson(input.metadata);
  const shared = {
    schemaVersion: "document-search-v1" as const,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFilePublicId: input.sourceFilePublicId,
    sourceRevisionPublicId: input.sourceRevisionPublicId,
    searchContractSha256: input.searchContractSha256,
    logicalPath: input.logicalPath,
    title: input.title,
    metadata: structuredClone(input.metadata)
  };
  return [
    createDocument({
      ...shared,
      documentKind: "file",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: `${input.fileSearchText}\n${metadataSearchText}`,
      embeddingArtifactPublicId: null,
      rankingTerms: []
    }),
    createDocument({
      ...shared,
      documentKind: "graph_seed",
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: input.graphSeed?.searchText ?? input.fileSearchText,
      embeddingArtifactPublicId: null,
      rankingTerms: [...new Set(input.graphSeed?.rankingTerms ?? [])].slice(0, 1_000)
    }),
    ...input.segments.map((segment) => createDocument({
      ...shared,
      documentKind: "segment",
      segmentOrdinal: segment.ordinal,
      headingAncestors: [...segment.headingAncestors],
      searchText: segment.searchText,
      embeddingArtifactPublicId: segment.embeddingArtifactPublicId,
      rankingTerms: []
    }))
  ];
}

export function prepareDocumentRelationshipSearchDocuments(input: {
  knowledgeBaseId: string;
  searchContractSha256: string;
  affectedSourceFilePublicIds: readonly string[];
  sources: readonly {
    sourceFilePublicId: string;
    sourceRevisionPublicId: string;
    logicalPath: string;
    title: string;
    metadata: Readonly<Record<string, unknown>>;
  }[];
  relations: readonly CanonicalFileRelation[];
}): DocumentSearchDocument[] {
  const sourceById = new Map(input.sources.map((source) => [
    source.sourceFilePublicId,
    source
  ]));
  const affected = new Set(input.affectedSourceFilePublicIds);
  if (sourceById.size !== input.sources.length
    || affected.size !== input.affectedSourceFilePublicIds.length
    || !/^[0-9a-f]{64}$/u.test(input.searchContractSha256)) {
    throw searchPreparationError("relationship_input_invalid");
  }
  const documents = input.relations.flatMap((relation) => [
    relationshipEndpoint(relation, relation.firstSourceFilePublicId),
    relationshipEndpoint(relation, relation.secondSourceFilePublicId)
  ].flatMap((endpoint) => {
    if (!affected.has(endpoint.sourceFilePublicId)) return [];
    const source = sourceById.get(endpoint.sourceFilePublicId);
    const target = sourceById.get(endpoint.targetSourceFilePublicId);
    if (!source || !target) return [];
    const evidenceText = canonicalJson(relation.evidence.value);
    return [createDocument({
      schemaVersion: "document-search-v1",
      knowledgeBaseId: input.knowledgeBaseId,
      sourceFilePublicId: source.sourceFilePublicId,
      sourceRevisionPublicId: source.sourceRevisionPublicId,
      searchContractSha256: input.searchContractSha256,
      documentKind: "file_relationship",
      logicalPath: source.logicalPath,
      title: source.title,
      metadata: structuredClone(source.metadata),
      segmentOrdinal: null,
      headingAncestors: [],
      searchText: [
        source.title,
        source.logicalPath,
        target.title,
        target.logicalPath,
        relation.relationKind,
        evidenceText
      ].join("\n").slice(0, 262_144),
      embeddingArtifactPublicId: null,
      rankingTerms: [...new Set([
        source.title, source.logicalPath, target.title, target.logicalPath
      ])],
      relationPublicId: relation.publicId,
      evidencePublicId: relation.evidence.publicId,
      targetSourceFilePublicId: target.sourceFilePublicId,
      targetSourceRevisionPublicId: target.sourceRevisionPublicId,
      targetLogicalPath: target.logicalPath,
      targetTitle: target.title,
      relationKind: relation.relationKind,
      direction: endpoint.direction
    })];
  }));
  return [...new Map(documents.map((document) => [
    document.publicId,
    document
  ])).values()].sort((left, right) =>
    left.publicId.localeCompare(right.publicId, "en"));
}

function relationshipEndpoint(
  relation: CanonicalFileRelation,
  sourceFilePublicId: string
) {
  const targetSourceFilePublicId = sourceFilePublicId
    === relation.firstSourceFilePublicId
    ? relation.secondSourceFilePublicId : relation.firstSourceFilePublicId;
  return {
    sourceFilePublicId,
    targetSourceFilePublicId,
    direction: relation.evidence.sourceFilePublicId === sourceFilePublicId
      ? "outgoing" as const : "incoming" as const
  };
}

function createDocument(
  input: Omit<DocumentSearchDocument, "publicId">
): DocumentSearchDocument {
  if (input.documentKind === "file_relationship"
    && [input.relationPublicId, input.evidencePublicId,
      input.targetSourceFilePublicId, input.targetSourceRevisionPublicId,
      input.targetLogicalPath, input.targetTitle,
      input.relationKind, input.direction].some((value) => !value)) {
    throw searchPreparationError("relationship_document_invalid");
  }
  const identity = canonicalJson(input);
  if (Buffer.byteLength(identity, "utf8") > 1_048_576) {
    throw searchPreparationError("document_size_limit");
  }
  return {
    publicId: `search-document-${createHash("sha256").update(identity).digest("hex")}`,
    ...input
  };
}

function assertInput(input: {
  knowledgeBaseId: string;
  sourceFilePublicId: string;
  sourceRevisionPublicId: string;
  searchContractSha256: string;
  logicalPath: string;
  title: string;
  fileSearchText: string;
  graphSeed?: {
    searchText: string;
    rankingTerms: readonly string[];
  };
  segments: readonly {
    publicId: string;
    ordinal: number;
    headingAncestors: readonly string[];
    searchText: string;
    embeddingArtifactPublicId: string;
  }[];
}): void {
  const identities = [
    input.knowledgeBaseId,
    input.sourceFilePublicId,
    input.sourceRevisionPublicId,
    input.logicalPath,
    input.title
  ];
  if (identities.some((value) => !value || Buffer.byteLength(value, "utf8") > 4_096)
    || !/^[0-9a-f]{64}$/u.test(input.searchContractSha256)
    || Buffer.byteLength(input.fileSearchText, "utf8") > 1_000_000
    || (input.graphSeed !== undefined
      && (Buffer.byteLength(input.graphSeed.searchText, "utf8") > 262_144
        || input.graphSeed.rankingTerms.length > 1_000))
    || input.segments.length > 10_000
    || new Set(input.segments.map((segment) => segment.publicId)).size
      !== input.segments.length
    || new Set(input.segments.map((segment) => segment.ordinal)).size
      !== input.segments.length
    || input.segments.some((segment) => !segment.publicId
      || !Number.isSafeInteger(segment.ordinal) || segment.ordinal < 0
      || !segment.searchText || !segment.embeddingArtifactPublicId
      || segment.headingAncestors.length > 64)) {
    throw searchPreparationError("input_invalid");
  }
}

function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw searchPreparationError("metadata_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  throw searchPreparationError("metadata_invalid");
}

function searchPreparationError(code: string): Error & { code: string } {
  return Object.assign(new Error(`Document search preparation error: ${code}`), { code });
}
