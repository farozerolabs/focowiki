import {
  requestGraphRelationshipConfirmations,
  isLowInformationSharedGraphTerm,
  type ModelReceiveTimeouts,
  type OkfGraphEdge,
  type OkfGraphNode,
  type OpenAIModelClient,
  type SourceMetadataDefaults,
  type SourceModelSuggestions
} from "@focowiki/okf";
import type { FileGraphRepository, SourceFileRecord } from "../db/admin-repositories.js";
import {
  buildSourceContentProfile,
  isUsefulTerm,
  normalizeTerm,
  stripGeneratedSections
} from "./content-profile.js";
import {
  findSharedSpecificPhrases,
  isSpecificSharedSignal,
  isStrongContentSignal
} from "./relationship-signals.js";

export type BuildSourceFileGraphInput = {
  graph: FileGraphRepository;
  knowledgeBaseId: string;
  source: SourceFileRecord;
  metadata: SourceMetadataDefaults;
  body: string;
  suggestions: SourceModelSuggestions | null;
  pageSize: number;
  maxCandidateNodes?: number;
  modelConfirmation?: GraphModelConfirmationOptions | null;
};

export type GraphModelConfirmationOptions = {
  client: OpenAIModelClient;
  modelName: string;
  contextWindowTokens: number;
  receiveTimeouts: ModelReceiveTimeouts;
};

export type BuildSourceFileGraphResult = {
  edgeCount: number;
  rejectedEdgeCount: number;
  warnings: string[];
};

export async function buildSourceFileGraph(
  input: BuildSourceFileGraphInput
): Promise<BuildSourceFileGraphResult> {
  const node = createGraphNode(input);
  await input.graph.upsertGraphNode({
    knowledgeBaseId: input.knowledgeBaseId,
    node
  });

  const candidates = await listCandidateNodes({
    graph: input.graph,
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id,
    candidateTerms: buildCandidateTerms(node),
    pageSize: input.pageSize,
    maxCandidateNodes: resolveMaxCandidateNodes(input)
  });
  const edges = buildGraphEdges({
    source: node,
    body: input.body,
    suggestions: input.suggestions,
    candidates
  });
  const confirmation = await confirmGraphEdges({
    node,
    body: input.body,
    candidates,
    edges,
    modelConfirmation: input.modelConfirmation ?? null
  });

  await input.graph.replaceGraphEdgesForSourceFile?.({
    knowledgeBaseId: input.knowledgeBaseId,
    sourceFileId: input.source.id
  });

  if (confirmation.edges.length > 0) {
    await input.graph.upsertGraphEdges({
      knowledgeBaseId: input.knowledgeBaseId,
      edges: confirmation.edges
    });
  }

  if (confirmation.rejectedEdges.length > 0) {
    await input.graph.upsertRejectedGraphEdges?.({
      knowledgeBaseId: input.knowledgeBaseId,
      edges: confirmation.rejectedEdges
    });
  }

  return {
    edgeCount: confirmation.edges.length,
    rejectedEdgeCount: confirmation.rejectedEdges.length,
    warnings: confirmation.warnings
  };
}

function createGraphNode(input: BuildSourceFileGraphInput): OkfGraphNode {
  const title = readString(input.metadata.title) || stripMarkdownExtension(input.source.originalName);
  const profile = buildSourceContentProfile({
    title,
    body: input.body,
    metadata: input.metadata,
    suggestions: input.suggestions
  });
  const tags = unique([...readStringArray(input.metadata.tags), ...profile.tags]).filter(isUsefulTerm);
  const keywords = unique([
    ...profile.keywords,
    ...profile.subjects,
    ...profile.entities,
    ...extractSearchTerms(title)
  ])
    .filter(isUsefulTerm)
    .slice(0, 80);

  return {
    fileId: input.source.id,
    path: `pages/${input.source.originalName}`,
    title,
    ...(readString(input.metadata.type) ? { type: readString(input.metadata.type) } : {}),
    ...(profile.description ? { description: profile.description } : {}),
    ...(profile.summary ? { summary: profile.summary } : {}),
    subjects: profile.subjects,
    tags,
    entities: profile.entities,
    explicitReferences: profile.explicitReferences,
    relationshipHints: profile.relationshipHints,
    headings: profile.headingOutline,
    keywords,
    language: profile.language,
    profileVersion: profile.profileVersion,
    profileSource: profile.profileSource,
    metadata: {
      ...input.metadata,
      contentProfile: {
        summary: profile.summary,
        subjects: profile.subjects,
        keywords: profile.keywords,
        entities: profile.entities,
        explicitReferences: profile.explicitReferences,
        relationshipHints: profile.relationshipHints,
        headingOutline: profile.headingOutline,
        language: profile.language,
        profileVersion: profile.profileVersion,
        profileSource: profile.profileSource
      }
    }
  };
}

async function listCandidateNodes(input: {
  graph: FileGraphRepository;
  knowledgeBaseId: string;
  sourceFileId: string;
  candidateTerms: string[];
  pageSize: number;
  maxCandidateNodes: number;
}): Promise<OkfGraphNode[]> {
  const candidatesById = new Map<string, OkfGraphNode>();
  const indexedCandidates = input.graph.listGraphCandidates
    ? await input.graph.listGraphCandidates({
        knowledgeBaseId: input.knowledgeBaseId,
        sourceFileId: input.sourceFileId,
        terms: input.candidateTerms,
        limit: input.maxCandidateNodes
      })
    : [];

  for (const candidate of indexedCandidates) {
    if (candidate.fileId !== input.sourceFileId) {
      candidatesById.set(candidate.fileId, candidate);
    }
  }

  let cursor: string | null = null;

  while (candidatesById.size < input.maxCandidateNodes) {
    const page = await input.graph.listGraphNodes({
      knowledgeBaseId: input.knowledgeBaseId,
      limit: input.pageSize,
      cursor
    });
    for (const node of page.items.filter((node) => node.fileId !== input.sourceFileId)) {
      if (candidatesById.size >= input.maxCandidateNodes) {
        break;
      }
      candidatesById.set(node.fileId, node);
    }
    cursor = page.nextCursor;

    if (!cursor) {
      break;
    }
  }

  return Array.from(candidatesById.values()).slice(0, input.maxCandidateNodes);
}

function buildGraphEdges(input: {
  source: OkfGraphNode;
  body: string;
  suggestions: SourceModelSuggestions | null;
  candidates: OkfGraphNode[];
}): OkfGraphEdge[] {
  const suggestedPaths = new Set(
    (input.suggestions?.related_links ?? []).map((link) => normalizePublicPath(link.path))
  );

  return input.candidates
    .map((candidate) => bestEdgeForCandidate(input.source, input.body, suggestedPaths, candidate))
    .filter((edge): edge is OkfGraphEdge => edge !== null)
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.toFileId.localeCompare(right.toFileId) ||
        left.relationType.localeCompare(right.relationType)
    )
    .slice(0, 50);
}

async function confirmGraphEdges(input: {
  node: OkfGraphNode;
  body: string;
  candidates: OkfGraphNode[];
  edges: OkfGraphEdge[];
  modelConfirmation: GraphModelConfirmationOptions | null;
}): Promise<{ edges: OkfGraphEdge[]; rejectedEdges: OkfGraphEdge[]; warnings: string[] }> {
  if (!input.modelConfirmation || input.edges.length === 0) {
    return {
      edges: input.edges,
      rejectedEdges: [],
      warnings: []
    };
  }

  const confirmationCandidates = input.edges.filter(isModelConfirmationCandidateEdge);
  const locallyRejectedEdges = input.edges
    .filter((edge) => !isModelConfirmationCandidateEdge(edge))
    .map((edge) =>
      createRejectedEdge(edge, "The local signal was not strong enough for model confirmation.")
    );

  if (confirmationCandidates.length === 0) {
    return {
      edges: [],
      rejectedEdges: locallyRejectedEdges,
      warnings: []
    };
  }

  const result = await requestGraphRelationshipConfirmations({
    client: input.modelConfirmation.client,
    modelName: input.modelConfirmation.modelName,
    contextWindowTokens: input.modelConfirmation.contextWindowTokens,
    receiveTimeouts: input.modelConfirmation.receiveTimeouts,
    currentFile: input.node,
    body: input.body,
    candidates: confirmationCandidates,
    candidateFiles: listEdgeCandidateFiles(input.candidates, confirmationCandidates)
  });

  if (result.confirmations.length === 0) {
    const hasModelDecision = result.warnings.length === 0;
    const allowLocalFallback = !hasUnsafeModelOutputWarning(result.warnings);
    return {
      edges: hasModelDecision || !allowLocalFallback ? [] : confirmationCandidates.filter(isSafeLocalFallbackEdge),
      rejectedEdges: [
        ...locallyRejectedEdges,
        ...(hasModelDecision || !allowLocalFallback
          ? confirmationCandidates.map((edge) =>
              createRejectedEdge(edge, "The model did not accept this candidate relationship.")
            )
          : confirmationCandidates
              .filter((edge) => !isSafeLocalFallbackEdge(edge))
              .map((edge) =>
                createRejectedEdge(edge, "The model confirmation failed and the local signal was not strong enough.")
              ))
      ],
      warnings: result.warnings
    };
  }

  const confirmationByTarget = new Map(
    result.confirmations.map((confirmation) => [confirmation.targetFileId, confirmation])
  );
  const acceptedEdges: OkfGraphEdge[] = [];
  const rejectedEdges: OkfGraphEdge[] = [...locallyRejectedEdges];

  for (const edge of confirmationCandidates) {
    const confirmation = confirmationByTarget.get(edge.toFileId);

    if (!confirmation) {
      rejectedEdges.push(createRejectedEdge(edge, "The model did not return this candidate relationship."));
      continue;
    }

    if (!confirmation.accepted) {
      rejectedEdges.push(createRejectedEdge(edge, confirmation.reason));
      continue;
    }

    if (confirmation.relationType !== edge.relationType) {
      rejectedEdges.push(createRejectedEdge(edge, "The model returned a different relationship type than the candidate."));
      continue;
    }

    acceptedEdges.push({
      ...edge,
      relationType: edge.relationType,
      weight: Math.max(edge.weight, confirmation.weight),
      reason: confirmation.reason.trim() || edge.reason,
      source: "model_confirmed",
      evidence: {
        ...(edge.evidence ?? {}),
        deterministicSource: edge.source,
        deterministicRelationType: edge.relationType
      }
    });
  }

  return {
    edges: acceptedEdges,
    rejectedEdges,
    warnings: result.warnings
  };
}

function isModelConfirmationCandidateEdge(edge: OkfGraphEdge): boolean {
  return (
    edge.relationType === "explicit_reference" ||
    edge.relationType === "title_mention" ||
    edge.relationType === "model_related_link" ||
    edge.relationType === "shared_entity" ||
    edge.relationType === "shared_subject"
  );
}

function hasUnsafeModelOutputWarning(warnings: string[]): boolean {
  return warnings.some((warning) =>
    /local schema validation|incomplete|did not complete|refused/i.test(warning)
  );
}

function resolveMaxCandidateNodes(input: BuildSourceFileGraphInput): number {
  const requested = input.maxCandidateNodes ?? input.pageSize * 4;
  return Math.max(1, Math.min(requested, 200));
}

function buildCandidateTerms(node: OkfGraphNode): string[] {
  return unique([
    ...extractSearchTerms(node.title),
    ...(node.subjects ?? []),
    ...(node.tags ?? []),
    ...(node.entities ?? []),
    ...(node.keywords ?? []),
    ...(node.explicitReferences ?? []),
    ...(node.relationshipHints ?? [])
  ])
    .filter(isUsefulTerm)
    .slice(0, 100);
}

function listEdgeCandidateFiles(candidates: OkfGraphNode[], edges: OkfGraphEdge[]): OkfGraphNode[] {
  const edgeTargetIds = new Set(edges.map((edge) => edge.toFileId));
  return candidates.filter((candidate) => edgeTargetIds.has(candidate.fileId));
}

function bestEdgeForCandidate(
  source: OkfGraphNode,
  body: string,
  suggestedPaths: Set<string>,
  candidate: OkfGraphNode
): OkfGraphEdge | null {
  const signals: OkfGraphEdge[] = [];
  const normalizedBody = normalizeSearchText(stripGeneratedSections(body));
  const candidateTitle = normalizeSearchText(candidate.title);
  const candidateStem = normalizeSearchText(stripMarkdownExtension(candidate.path.split("/").at(-1) ?? candidate.title));
  const sharedSubjects = intersectUseful(source.subjects ?? [], candidate.subjects ?? []).filter(
    isSpecificSharedSignal
  );
  const sharedEntities = intersectUseful(source.entities ?? [], candidate.entities ?? []).filter(
    isSpecificSharedSignal
  );
  const sharedKeywords = intersectUseful(source.keywords ?? [], candidate.keywords ?? []).filter(
    isSpecificSharedSignal
  );
  const sharedTags = intersectUseful(source.tags ?? [], candidate.tags ?? []);
  const strongSharedSubjects = sharedSubjects.filter(isStrongContentSignal);
  const strongSharedEntities = sharedEntities.filter(isStrongContentSignal);
  const strongSharedKeywords = sharedKeywords.filter(isStrongContentSignal);
  const sharedKeyPhrases = findSharedSpecificPhrases(source, candidate).filter((term) =>
    normalizedBody.includes(normalizeSearchText(term))
  );
  const strongSharedKeyPhrases = sharedKeyPhrases.filter((term) =>
    isStrongSharedKeyPhrase(term, source, candidate)
  );
  const hasSuggestedPath = suggestedPaths.has(normalizePublicPath(candidate.path));
  const hasExplicitReference = matchesExplicitReference(source, candidate);
  const hasTitleMention =
    (candidateTitle.length > 0 && normalizedBody.includes(candidateTitle)) ||
    (candidateStem.length > 0 && normalizedBody.includes(candidateStem));
  const hasContentOverlap =
    strongSharedSubjects.length > 0 ||
    strongSharedEntities.length > 0 ||
    strongSharedKeyPhrases.length > 0 ||
    hasExplicitReference ||
    hasTitleMention;

  if (hasExplicitReference) {
    signals.push(createEdge(source, candidate, "explicit_reference", 0.95, "The source explicitly references this file.", {
      targetPath: candidate.path,
      targetTitle: candidate.title
    }));
  }

  if (hasSuggestedPath && hasContentOverlap) {
    signals.push(createEdge(source, candidate, "model_related_link", 0.82, "The model selected this existing file path with content evidence.", {
      path: candidate.path
    }, "model_suggested"));
  }

  if (hasTitleMention) {
    signals.push(createEdge(source, candidate, "title_mention", 0.7, "The source body mentions the related file title.", {
      title: candidate.title
    }));
  }

  if (strongSharedEntities.length > 0 && (strongSharedSubjects.length > 0 || strongSharedKeywords.length >= 2)) {
    signals.push(createEdge(source, candidate, "shared_entity", 0.68, "Both files share body-derived entities and content terms.", {
      entities: strongSharedEntities.slice(0, 8),
      subjects: strongSharedSubjects.slice(0, 8),
      keywords: strongSharedKeywords.slice(0, 8)
    }));
  }

  if (strongSharedSubjects.length >= 2 || (strongSharedSubjects.length >= 1 && strongSharedKeywords.length >= 2)) {
    signals.push(createEdge(source, candidate, "shared_subject", 0.64, "Both files share body-derived subjects.", {
      subjects: strongSharedSubjects.slice(0, 8),
      keywords: strongSharedKeywords.slice(0, 8)
    }));
  }

  if (strongSharedKeyPhrases.length > 0) {
    signals.push(createEdge(source, candidate, "shared_key_phrase", 0.69, "Both files share specific body-derived key phrases.", {
      matchedTerms: strongSharedKeyPhrases.slice(0, 8)
    }));
  }

  if (hasContentOverlap && sharedTags.length > 0) {
    signals.push(createEdge(source, candidate, "metadata_supported_content", 0.58, "Shared metadata is supported by body-derived content evidence.", {
      tags: sharedTags.slice(0, 8)
    }));
  }

  return signals.sort((left, right) => right.weight - left.weight)[0] ?? null;
}

function createEdge(
  source: OkfGraphNode,
  candidate: OkfGraphNode,
  relationType: string,
  weight: number,
  reason: string,
  evidence: Record<string, unknown>,
  sourceKind: OkfGraphEdge["source"] = "deterministic"
): OkfGraphEdge {
  return {
    fromFileId: source.fileId,
    toFileId: candidate.fileId,
    relationType,
    weight,
    reason,
    source: sourceKind,
    evidence
  };
}

function createRejectedEdge(edge: OkfGraphEdge, reason: string): OkfGraphEdge {
  return {
    ...edge,
    weight: 0,
    source: "model_rejected",
    reason: reason.trim() || "The model rejected this candidate relationship.",
    evidence: {
      ...(edge.evidence ?? {}),
      rejectedRelationType: edge.relationType,
      rejectedWeight: edge.weight
    }
  };
}

function isSafeLocalFallbackEdge(edge: OkfGraphEdge): boolean {
  return (
    edge.relationType === "explicit_reference" ||
    edge.relationType === "title_mention" ||
    edge.relationType === "model_related_link" ||
    edge.relationType === "shared_entity" ||
    edge.relationType === "shared_subject"
  );
}

function isStrongSharedKeyPhrase(term: string, source: OkfGraphNode, candidate: OkfGraphNode): boolean {
  const normalized = normalizeSearchText(term).replace(/\s+/gu, "");

  if (!normalized || isLowInformationSharedGraphTerm(normalized) || normalized.length < 4) {
    return false;
  }

  const sourceTitle = normalizeSearchText(source.title).replace(/\s+/gu, "");
  const candidateTitle = normalizeSearchText(candidate.title).replace(/\s+/gu, "");

  if (sourceTitle.includes(normalized) && candidateTitle.includes(normalized)) {
    return true;
  }

  const sourceTerms = normalizedStrongNodeTerms(source);
  const candidateTerms = normalizedStrongNodeTerms(candidate);

  return normalized.length >= 5 && sourceTerms.has(normalized) && candidateTerms.has(normalized);
}

function normalizedStrongNodeTerms(node: OkfGraphNode): Set<string> {
  return new Set(
    [
      ...(node.subjects ?? []),
      ...(node.entities ?? []),
      ...(node.keywords ?? []),
      ...(node.relationshipHints ?? [])
    ]
      .map((term) => normalizeSearchText(term).replace(/\s+/gu, ""))
      .filter((term) => term && isStrongContentSignal(term) && !isLowInformationSharedGraphTerm(term))
  );
}

function matchesExplicitReference(source: OkfGraphNode, candidate: OkfGraphNode): boolean {
  const references = source.explicitReferences ?? [];
  const candidatePath = normalizePublicPath(candidate.path);
  const candidateTitle = normalizeSearchText(candidate.title);

  return references.some((reference) => {
    const normalizedReference = normalizePublicPath(reference);
    return (
      normalizedReference === candidatePath ||
      normalizedReference.endsWith(`/${candidatePath}`) ||
      (candidateTitle.length > 0 && normalizeSearchText(reference).includes(candidateTitle))
    );
  });
}

function extractSearchTerms(value: string): string[] {
  return unique(
    value
      .split(/[^\p{L}\p{N}]+/u)
      .map(normalizeTerm)
      .filter(isUsefulTerm)
  );
}

function intersectUseful(left: string[], right: string[]): string[] {
  return intersect(
    left.map(normalizeTerm).filter(isUsefulTerm),
    right.map(normalizeTerm).filter(isUsefulTerm)
  );
}

function normalizeSearchText(value: string): string {
  return normalizeTerm(value)
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizePublicPath(path: string): string {
  return path.trim().replace(/^\/+/, "").replace(/#.*$/u, "");
}

function stripMarkdownExtension(fileName: string): string {
  return fileName.replace(/\.md$/iu, "");
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function intersect(left: string[], right: string[]): string[] {
  const rightValues = new Set(right.map(normalizeTerm));
  return unique(left.filter((value) => rightValues.has(normalizeTerm(value))));
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}
