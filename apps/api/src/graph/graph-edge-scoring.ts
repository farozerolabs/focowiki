import {
  boundGraphEvidence,
  isLowInformationSharedGraphTerm,
  normalizeDurableGraphReason,
  type OkfGraphEdge,
  type OkfGraphNode
} from "@focowiki/okf";
import { stripGeneratedSections } from "./content-profile.js";
import {
  createCandidateTermFrequency,
  type CandidateTermFrequency
} from "./graph-candidate-frequency.js";
import {
  createSpecificPhraseIndex,
  findSharedSpecificPhrasesFromIndex,
  type SpecificPhraseIndex
} from "./relationship-signals.js";
import {
  normalizePublicPath,
  normalizeSearchText
} from "./graph-utils.js";
import {
  createGraphEdgeNodeProfile,
  createGraphEdgeNormalizationCache,
  intersectGraphEdgeProfileTerms,
  type GraphEdgeNodeProfile,
  type GraphEdgeNormalizationCache
} from "./graph-edge-scoring-profile.js";

type GraphEdgeScoringContext = {
  normalizedBody: string;
  semanticBody: string;
  source: GraphEdgeNodeProfile;
  sourcePhraseIndex: SpecificPhraseIndex;
  candidateTermFrequency: CandidateTermFrequency;
  normalization: GraphEdgeNormalizationCache;
};

export type GraphEdgeBuildInput = {
  source: OkfGraphNode;
  body: string;
  suggestions:
    | {
        related_links?: Array<{ path: string }>;
      }
    | null;
  candidates: OkfGraphNode[];
  acceptedEdgeLimit: number;
  genericPhraseThreshold: number;
};

type GraphEdgeProfileKeys = {
  source: string;
  candidates: readonly string[];
};

export function createGraphEdgeScorer(input: {
  maximumCachedProfiles: number;
}) {
  if (
    !Number.isSafeInteger(input.maximumCachedProfiles)
    || input.maximumCachedProfiles < 1
  ) throw new Error("Graph edge scorer profile cache limit is invalid");
  const profiles = new Map<string, GraphEdgeNodeProfile>();
  return {
    build(request: GraphEdgeBuildInput & { profileKeys: GraphEdgeProfileKeys }) {
      if (request.profileKeys.candidates.length !== request.candidates.length) {
        throw new Error("Graph edge scorer profile keys do not match candidates");
      }
      return scoreGraphEdges(request, {
        maximumProfiles: input.maximumCachedProfiles,
        profiles,
        keys: request.profileKeys
      });
    }
  };
}

export function buildGraphEdges(input: GraphEdgeBuildInput): OkfGraphEdge[] {
  return scoreGraphEdges(input, null);
}

function scoreGraphEdges(
  input: GraphEdgeBuildInput,
  profileCache: {
    maximumProfiles: number;
    profiles: Map<string, GraphEdgeNodeProfile>;
    keys: GraphEdgeProfileKeys;
  } | null
): OkfGraphEdge[] {
  const normalization = createGraphEdgeNormalizationCache();
  const source = loadGraphEdgeNodeProfile(
    input.source,
    profileCache?.keys.source ?? null,
    normalization,
    profileCache
  );
  const candidates = input.candidates.map((candidate, index) =>
    loadGraphEdgeNodeProfile(
      candidate,
      profileCache?.keys.candidates[index] ?? null,
      normalization,
      profileCache
    ));
  const normalizedBody = normalization.searchText(stripGeneratedSections(input.body));
  const context: GraphEdgeScoringContext = {
    normalizedBody,
    semanticBody: removeVersionContext(normalizedBody, source.normalizedVersionHints),
    source,
    sourcePhraseIndex: createSpecificPhraseIndex(source.strongTerms),
    candidateTermFrequency: createCandidateTermFrequency([
      source.compactStrongTerms,
      ...candidates.map((candidate) => candidate.compactStrongTerms)
    ]),
    normalization
  };
  const suggestedPaths = new Set(
    (input.suggestions?.related_links ?? []).map((link) => normalizePublicPath(link.path))
  );

  return candidates
    .map((candidate) =>
      bestEdgeForCandidate({
        context,
        suggestedPaths,
        candidate,
        genericPhraseThreshold: input.genericPhraseThreshold
      })
    )
    .filter((edge): edge is OkfGraphEdge => edge !== null)
    .sort(
      (left, right) =>
        right.weight - left.weight ||
        left.toFileId.localeCompare(right.toFileId) ||
        left.relationType.localeCompare(right.relationType)
    )
    .slice(0, input.acceptedEdgeLimit);
}

function loadGraphEdgeNodeProfile(
  node: OkfGraphNode,
  key: string | null,
  normalization: GraphEdgeNormalizationCache,
  cache: {
    maximumProfiles: number;
    profiles: Map<string, GraphEdgeNodeProfile>;
  } | null
): GraphEdgeNodeProfile {
  if (!key || !cache) return createGraphEdgeNodeProfile(node, normalization);
  const current = cache.profiles.get(key);
  if (current) {
    cache.profiles.delete(key);
    cache.profiles.set(key, current);
    return current;
  }
  const profile = createGraphEdgeNodeProfile(node, normalization);
  cache.profiles.set(key, profile);
  while (cache.profiles.size > cache.maximumProfiles) {
    const oldest = cache.profiles.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    cache.profiles.delete(oldest);
  }
  return profile;
}

export function isSharedPhraseOnlyEdge(edge: OkfGraphEdge): boolean {
  return (
    edge.relationType === "same_specific_subject" &&
    Array.isArray(edge.evidence?.matchedTerms) &&
    edge.source !== "model_confirmed"
  );
}

export function isStrongSharedPhraseOnlyEdge(edge: OkfGraphEdge): boolean {
  if (!isSharedPhraseOnlyEdge(edge)) {
    return true;
  }

  const matchedTerms = Array.isArray(edge.evidence?.matchedTerms)
    ? edge.evidence.matchedTerms.filter((term): term is string => typeof term === "string")
    : [];

  return matchedTerms.some(isStrongConfirmationPhrase);
}

export function isSafeLocalFallbackEdge(edge: OkfGraphEdge): boolean {
  const signal = typeof edge.evidence?.signal === "string" ? edge.evidence.signal : "";

  if (
    (edge.relationType === "direct_reference" && signal === "direct_reference") ||
    (edge.relationType === "version_relation" && signal === "same_document_title")
  ) {
    return true;
  }

  if (
    (edge.relationType === "same_entity" || edge.relationType === "same_specific_subject") &&
    edge.evidence?.titleSupported === true
  ) {
    return true;
  }

  if (edge.relationType === "collection_neighbor" && signal === "shared_update_context") {
    return hasLongExactEvidence(edge.evidence?.versionHints);
  }

  if (edge.relationType === "process_adjacent" && signal === "shared_process_hint") {
    return hasLongExactEvidence(edge.evidence?.processHints);
  }

  if (edge.relationType === "background" && signal === "shared_definition") {
    return hasLongExactEvidence(edge.evidence?.definitions);
  }

  return false;
}

function hasLongExactEvidence(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => {
    if (typeof item !== "string") return false;
    const normalized = normalizeSearchText(item).replace(/\s+/gu, "");
    return /\p{Script=Han}/u.test(normalized) ? normalized.length >= 12 : normalized.length >= 24;
  });
}

export function isConfirmableRelationType(relationType: string): boolean {
  return (
    relationType === "direct_reference" ||
    relationType === "same_specific_subject" ||
    relationType === "same_entity" ||
    relationType === "version_relation" ||
    relationType === "background" ||
    relationType === "process_adjacent" ||
    relationType === "parent_child" ||
    relationType === "collection_neighbor"
  );
}

export function createRejectedEdge(edge: OkfGraphEdge, reason: string): OkfGraphEdge {
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

function bestEdgeForCandidate(input: {
  context: GraphEdgeScoringContext;
  suggestedPaths: Set<string>;
  candidate: GraphEdgeNodeProfile;
  genericPhraseThreshold: number;
}): OkfGraphEdge | null {
  const { context, suggestedPaths, candidate } = input;
  const { source, normalization } = context;
  const signals: OkfGraphEdge[] = [];
  const { normalizedBody, semanticBody } = context;
  const sameDocumentTitle =
    source.normalizedTitle.length > 0 &&
    source.normalizedTitle === candidate.normalizedTitle;
  const hasDistinctVersionEvidence =
    sameDocumentTitle &&
    hasDifferentVersionEvidence(source, candidate);
  const sharedSubjects = intersectGraphEdgeProfileTerms(
    source.subjects,
    candidate.subjects
  ).filter(normalization.specific);
  const sharedEntities = intersectGraphEdgeProfileTerms(
    source.entities,
    candidate.entities
  ).filter(normalization.specific);
  const sharedKeywords = intersectGraphEdgeProfileTerms(
    source.keywords,
    candidate.keywords
  ).filter(normalization.specific);
  const sharedDefinitions = intersectGraphEdgeProfileTerms(
    source.definitions,
    candidate.definitions
  ).filter(normalization.specific);
  const sharedProcessHints = intersectGraphEdgeProfileTerms(
    source.processHints,
    candidate.processHints
  ).filter(normalization.specific);
  const sharedVersionHints = intersectGraphEdgeProfileTerms(
    source.normalizedVersionHints,
    candidate.normalizedVersionHints
  ).filter(normalization.specific);
  const isCorpusSpecific = (term: string) =>
    !context.candidateTermFrequency.isFrequent(term);
  const strongSharedSubjects = sharedSubjects.filter(normalization.strong).filter(isCorpusSpecific);
  const strongSharedEntities = sharedEntities.filter(normalization.strong).filter(isCorpusSpecific);
  const strongSharedKeywords = sharedKeywords.filter(normalization.strong).filter(isCorpusSpecific);
  const strongSharedDefinitions = sharedDefinitions.filter(normalization.strong).filter(isCorpusSpecific);
  const strongSharedProcessHints = sharedProcessHints.filter(normalization.strong).filter(isCorpusSpecific);
  const strongSharedVersionHints = sharedVersionHints.filter(normalization.strong).filter(isCorpusSpecific);
  const titleSupportedSharedSubjects = strongSharedSubjects.filter((term) =>
    isDiscriminativeSharedTitlePhrase(term, source, candidate, input.genericPhraseThreshold,
      normalization)
  );
  const titleSupportedSharedEntities = strongSharedEntities.filter((term) =>
    isDiscriminativeSharedTitlePhrase(term, source, candidate, input.genericPhraseThreshold,
      normalization)
  );
  const sharedKeyPhrases = findSharedSpecificPhrasesFromIndex(
    context.sourcePhraseIndex,
    candidate.strongTerms
  ).filter((term) =>
    normalizedBody.includes(normalization.searchText(term))
  );
  const strongSharedKeyPhrases = compactSharedPhrases(
    sharedKeyPhrases.filter(
      (term) =>
        !isSharedVersionContextTerm(term, source, candidate, normalization) &&
        isStrongSharedKeyPhrase(
          term,
          source,
          candidate,
          context.candidateTermFrequency,
          input.genericPhraseThreshold,
          normalization
        )
    ),
    normalization
  );
  const titleSupportedSharedKeyPhrases = strongSharedKeyPhrases.filter((term) =>
    isDiscriminativeSharedTitlePhrase(term, source, candidate, input.genericPhraseThreshold,
      normalization)
  );
  const hasTitleSupportedSharedKeyPhrase = titleSupportedSharedKeyPhrases.length > 0;
  const distinctSharedContentSignalCount = countDistinctSignals([
    ...strongSharedSubjects,
    ...strongSharedEntities,
    ...strongSharedKeywords,
    ...strongSharedKeyPhrases
  ], normalization);
  const hasSuggestedPath = suggestedPaths.has(candidate.normalizedPath);
  const explicitReferences = matchingExplicitReferences(source, candidate);
  const hasExplicitReference = explicitReferences.length > 0;
  const titleMention = sameDocumentTitle
    ? null
    : candidate.normalizedTitle.length > 0
      && semanticBody.includes(candidate.normalizedTitle)
      ? candidate.node.title
      : candidate.normalizedStem.length > 0
        && semanticBody.includes(candidate.normalizedStem)
        ? candidate.normalizedStem
        : null;
  const hasTitleMention = titleMention !== null;
  const hasContentOverlap =
    strongSharedSubjects.length > 0 ||
    strongSharedEntities.length > 0 ||
    strongSharedKeyPhrases.length > 0 ||
    hasExplicitReference ||
    hasTitleMention;

  if (hasExplicitReference) {
    signals.push(
      createEdge(source.node, candidate.node, "direct_reference", 0.95, "The source explicitly references this file.", {
        references: explicitReferences.slice(0, 16),
        targetPath: candidate.node.path,
        targetTitle: candidate.node.title,
        signal: "direct_reference"
      })
    );
  }

  if (hasDistinctVersionEvidence) {
    signals.push(
      createEdge(
        source.node,
        candidate.node,
        "version_relation",
        0.92,
        "Both files are versions of the same titled document.",
        {
          title: source.node.title,
          versionHints: uniqueStrings([
            ...source.versionHints,
            ...candidate.versionHints
          ]).slice(0, 8),
          signal: "same_document_title"
        }
      )
    );
  }

  if (hasSuggestedPath && hasContentOverlap) {
    signals.push(
      createEdge(
        source.node,
        candidate.node,
        "same_specific_subject",
        0.82,
        "The model selected this existing file path with content evidence.",
        {
          path: candidate.node.path,
          signal: "same_specific_subject"
        },
        "model_suggested"
      )
    );
  }

  if (hasTitleMention) {
    signals.push(
      createEdge(source.node, candidate.node, "direct_reference", 0.7, "The source body mentions the related file title.", {
        title: candidate.node.title,
        mention: titleMention,
        signal: "direct_reference"
      })
    );
  }

  if (
    titleSupportedSharedEntities.length > 0 &&
    distinctSharedContentSignalCount >= 2 &&
    (strongSharedSubjects.length > 0 || strongSharedKeywords.length >= 2)
  ) {
    signals.push(
      createEdge(source.node, candidate.node, "same_entity", 0.68, "Both files share body-derived entities and content terms.", {
        entities: titleSupportedSharedEntities.slice(0, 8),
        subjects: strongSharedSubjects.slice(0, 8),
        keywords: strongSharedKeywords.slice(0, 8),
        titleSupported: true,
        signal: "same_entity"
      })
    );
  }

  if (
    titleSupportedSharedSubjects.length > 0 &&
    (
      distinctSharedContentSignalCount >= 2 ||
      titleSupportedSharedSubjects.some((value) =>
        isStandaloneSpecificSubject(value, normalization))
    )
  ) {
    signals.push(
      createEdge(source.node, candidate.node, "same_specific_subject", 0.64, "Both files share body-derived subjects.", {
        subjects: titleSupportedSharedSubjects.slice(0, 8),
        keywords: strongSharedKeywords.slice(0, 8),
        titleSupported: true,
        signal: "same_specific_subject"
      })
    );
  }

  if (
    strongSharedKeyPhrases.length >= 2 ||
    (hasTitleSupportedSharedKeyPhrase && distinctSharedContentSignalCount >= 2)
  ) {
    signals.push(
      createEdge(
        source.node,
        candidate.node,
        "same_specific_subject",
        0.69,
        "Both files share specific body-derived key phrases.",
        {
          matchedTerms: strongSharedKeyPhrases.slice(0, 8),
          titleSupported: hasTitleSupportedSharedKeyPhrase,
          signal: "same_specific_subject"
        }
      )
    );
  }

  if (strongSharedProcessHints.length > 0) {
    signals.push(
      createEdge(
        source.node,
        candidate.node,
        "process_adjacent",
        0.66,
        "Both files describe adjacent process steps or operational sequences.",
        {
          processHints: strongSharedProcessHints.slice(0, 8),
          signal: "shared_process_hint"
        }
      )
    );
  }

  if (strongSharedVersionHints.length > 0 && !sameDocumentTitle) {
    signals.push(
      createEdge(
        source.node,
        candidate.node,
        "collection_neighbor",
        0.67,
        "Both files share the same publication or update context.",
        {
          versionHints: strongSharedVersionHints.slice(0, 8),
          signal: "shared_update_context"
        }
      )
    );
  }

  if (strongSharedDefinitions.length > 0) {
    signals.push(
      createEdge(source.node, candidate.node, "background", 0.62, "Both files share definitions or background concepts.", {
        definitions: strongSharedDefinitions.slice(0, 8),
        signal: "shared_definition"
      })
    );
  }

  return signals.sort((left, right) => right.weight - left.weight)[0] ?? null;
}

function isStandaloneSpecificSubject(
  value: string,
  normalization: GraphEdgeNormalizationCache
): boolean {
  const normalized = normalization.compactText(value);
  return /\p{Script=Han}/u.test(normalized)
    ? normalized.length >= 4
    : normalized.length >= 8;
}

function hasDifferentVersionEvidence(
  source: GraphEdgeNodeProfile,
  candidate: GraphEdgeNodeProfile
): boolean {
  if (
    (source.normalizedVersionHints.length > 0 || candidate.normalizedVersionHints.length > 0) &&
    [...source.normalizedVersionHints].sort().join("\u0000")
      !== [...candidate.normalizedVersionHints].sort().join("\u0000")
  ) {
    return true;
  }

  return [...source.versionMetadata].some(([key, sourceValue]) => {
    const candidateValue = candidate.versionMetadata.get(key) ?? "";
    return Boolean(sourceValue && candidateValue && sourceValue !== candidateValue);
  });
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
    reason: normalizeDurableGraphReason({
      reason,
      fallbackReason: reason
    }),
    source: sourceKind,
    evidence: boundGraphEvidence(evidence)
  };
}

function isStrongSharedKeyPhrase(
  term: string,
  source: GraphEdgeNodeProfile,
  candidate: GraphEdgeNodeProfile,
  candidateTermFrequency: CandidateTermFrequency,
  genericPhraseThreshold: number,
  normalization: GraphEdgeNormalizationCache
): boolean {
  const normalized = normalization.compactText(term);

  if (
    !normalized ||
    isLowInformationSharedGraphTerm(normalized) ||
    normalized.length < genericPhraseThreshold
  ) {
    return false;
  }

  if (candidateTermFrequency.isFrequent(normalized)) {
    return false;
  }

  if (source.compactTitle.includes(normalized) && candidate.compactTitle.includes(normalized)) {
    return isDiscriminativeSharedTitlePhrase(
      term,
      source,
      candidate,
      genericPhraseThreshold,
      normalization
    );
  }

  return normalized.length > genericPhraseThreshold
    && source.normalizedStrongTerms.has(normalized)
    && candidate.normalizedStrongTerms.has(normalized);
}

function isDiscriminativeSharedTitlePhrase(
  value: string,
  source: GraphEdgeNodeProfile,
  candidate: GraphEdgeNodeProfile,
  genericPhraseThreshold: number,
  normalization: GraphEdgeNormalizationCache
): boolean {
  const phrase = normalization.compactText(value);

  if (
    phrase.length < genericPhraseThreshold ||
    !source.compactTitle.includes(phrase) ||
    !candidate.compactTitle.includes(phrase)
  ) {
    return false;
  }

  const shorterTitleLength = Math.min(
    source.compactTitle.length,
    candidate.compactTitle.length
  );
  const coverage = shorterTitleLength > 0 ? phrase.length / shorterTitleLength : 0;
  return coverage >= 0.65;
}

function compactSharedPhrases(
  values: string[],
  normalization: GraphEdgeNormalizationCache
): string[] {
  const sorted = values
    .map((value) => ({ value, normalized: normalization.compactText(value) }))
    .sort((left, right) =>
      right.normalized.length - left.normalized.length
      || left.value.localeCompare(right.value));
  const kept: Array<{ value: string; normalized: string }> = [];

  for (const value of sorted) {
    if (!kept.some((existing) => existing.normalized.includes(value.normalized))) {
      kept.push(value);
    }
  }

  return kept.map((value) => value.value);
}

function isStrongConfirmationPhrase(value: string): boolean {
  const normalized = normalizeSearchText(value).replace(/\s+/gu, "");

  if (!normalized || isLowInformationSharedGraphTerm(normalized)) {
    return false;
  }

  if (/^(?:当前|相关|参考|文件|文档|资料|内容|信息|本文|本文件|本资料)/u.test(normalized)) {
    return false;
  }

  if (/\p{Script=Han}/u.test(normalized)) {
    return normalized.length >= 4;
  }

  return normalized.length >= 8;
}

function matchingExplicitReferences(
  source: GraphEdgeNodeProfile,
  candidate: GraphEdgeNodeProfile
): string[] {
  const candidatePath = comparableReferencePath(candidate.normalizedPath);
  return source.explicitReferences.filter((reference) => {
    const referencePath = comparableReferencePath(reference.normalizedPath);
    return (
      reference.normalizedPath === candidate.normalizedPath ||
      reference.normalizedPath.endsWith(`/${candidate.normalizedPath}`) ||
      (referencePath.length > 0 && candidatePath.length > 0
        && (referencePath === candidatePath
          || referencePath.endsWith(`/${candidatePath}`)
          || candidatePath.endsWith(`/${referencePath}`))) ||
      (candidate.normalizedTitle.length > 0
        && reference.normalizedText.includes(candidate.normalizedTitle))
    );
  }).map((reference) => reference.value);
}

function comparableReferencePath(value: string): string {
  return value
    .replace(/^(?:\.\.?\/)+/u, "")
    .replace(/^pages\//u, "");
}

function removeVersionContext(body: string, normalizedVersionHints: string[]): string {
  let result = body;

  for (const hint of normalizedVersionHints) {
    if (hint) {
      result = result.replaceAll(hint, " ");
    }
  }

  return result.replace(/\s+/gu, " ").trim();
}

function isSharedVersionContextTerm(
  term: string,
  source: GraphEdgeNodeProfile,
  candidate: GraphEdgeNodeProfile,
  normalization: GraphEdgeNormalizationCache
): boolean {
  const normalizedTerm = normalization.compactText(term);

  if (!normalizedTerm) {
    return false;
  }

  return source.compactVersionHints.some((hint) => hint.includes(normalizedTerm))
    && candidate.compactVersionHints.some((hint) => hint.includes(normalizedTerm));
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function countDistinctSignals(
  values: string[],
  normalization: GraphEdgeNormalizationCache
): number {
  return new Set(values.map(normalization.compactText).filter(Boolean)).size;
}
