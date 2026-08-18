import type { SourceMetadataDefaults } from "@focowiki/okf";
import {
  createSemanticSourceChunks
} from "../../semantic/graphrag/source-chunks.js";
import {
  selectSemanticSkeleton,
  type SemanticSkeletonGraphSignals,
  type SemanticSkeletonPolicy
} from "../../semantic/graphrag/skeleton-selector.js";

export const DOCUMENT_BASELINE_COVERAGE_FAMILIES = [
  "exact_title_path",
  "lexical_jieba",
  "metadata",
  "structural",
  "file_graph_candidate",
  "content_vector"
] as const;

export const DOCUMENT_GRAPHRAG_VECTOR_FAMILIES = [
  "entity_vector",
  "relationship_vector",
  "community_vector"
] as const;

type SemanticContentProfile = {
  headingOutline: readonly string[];
  definitions: readonly string[];
  explicitReferences: readonly string[];
  keywords: readonly string[];
};

export function createDocumentSemanticPlan(input: {
  skeletonPolicy?: SemanticSkeletonPolicy;
  maximumChunkCharacters?: number;
  maximumChunks?: number;
} = {}) {
  const maximumChunkCharacters = input.maximumChunkCharacters ?? 2_000;
  const maximumChunks = input.maximumChunks ?? 32;
  return (request: {
    sourceRevisionPublicId: string;
    logicalPath: string;
    title: string;
    markdown: string;
    metadata: SourceMetadataDefaults;
    contentProfile: SemanticContentProfile;
    graphSignals?: Omit<SemanticSkeletonGraphSignals,
      "contentProfileHeadingCount" | "contentProfileDefinitionCount"
      | "contentProfileExplicitReferenceCount">;
  }) => {
    assertRequest(request);
    const chunks = createSemanticSourceChunks({
      sourceRevisionPublicId: request.sourceRevisionPublicId,
      markdown: request.markdown,
      maximumChunkCharacters,
      maximumChunks
    });
    const graphragSelection = selectSemanticSkeleton({
      sourceRevisionPublicId: request.sourceRevisionPublicId,
      logicalPath: request.logicalPath,
      markdown: request.markdown,
      chunks,
      graphSignals: {
        acceptedEdgeCount: request.graphSignals?.acceptedEdgeCount ?? 0,
        inboundEdgeCount: request.graphSignals?.inboundEdgeCount ?? 0,
        outboundEdgeCount: request.graphSignals?.outboundEdgeCount ?? 0,
        distinctNeighborCount: request.graphSignals?.distinctNeighborCount ?? 0,
        relationKindCount: request.graphSignals?.relationKindCount ?? 0,
        contentProfileHeadingCount: request.contentProfile.headingOutline.length,
        contentProfileDefinitionCount: request.contentProfile.definitions.length,
        contentProfileExplicitReferenceCount:
          request.contentProfile.explicitReferences.length
      },
      ...(input.skeletonPolicy ? { policy: input.skeletonPolicy } : {})
    });
    return {
      coverageFamilies: [...DOCUMENT_BASELINE_COVERAGE_FAMILIES],
      semanticVectorFamilies: graphragSelection.selected
        ? [...DOCUMENT_GRAPHRAG_VECTOR_FAMILIES]
        : [],
      graphragSelection,
      exactIdentity: {
        title: request.title,
        logicalPath: request.logicalPath
      },
      lexicalInput: [
        request.title,
        request.logicalPath,
        ...request.contentProfile.keywords
      ].join("\n"),
      metadataInput: structuredClone(request.metadata),
      structuralInput: {
        headings: [...request.contentProfile.headingOutline],
        definitions: [...request.contentProfile.definitions]
      },
      fileGraphCandidateInput: {
        references: [...request.contentProfile.explicitReferences],
        terms: [...request.contentProfile.keywords]
      },
      contentVectorInputs: chunks.map((chunk) => ({
        publicId: chunk.id,
        text: chunk.text,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset
      }))
    };
  };
}

function assertRequest(input: {
  sourceRevisionPublicId: string;
  logicalPath: string;
  title: string;
  markdown: string;
  contentProfile: SemanticContentProfile;
}): void {
  if (!input.sourceRevisionPublicId || !input.logicalPath || !input.title
    || !input.markdown.trim()
    || input.contentProfile.headingOutline.length > 512
    || input.contentProfile.definitions.length > 512
    || input.contentProfile.explicitReferences.length > 512
    || input.contentProfile.keywords.length > 1_000) {
    throw Object.assign(new Error("Document semantic plan input is invalid"), {
      code: "semantic_plan_invalid"
    });
  }
}
