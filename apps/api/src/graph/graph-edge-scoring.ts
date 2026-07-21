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
  isSpecificSharedSignal,
  isStrongContentSignal,
  listStrongGraphNodeTerms,
  type SpecificPhraseIndex
} from "./relationship-signals.js";
import {
  intersectUseful,
  normalizePublicPath,
  normalizeSearchText,
  readContentProfileStringArray,
  stripMarkdownExtension
} from "./graph-utils.js";

type GraphEdgeScoringContext = {
  normalizedBody: string;
  semanticBody: string;
  sourceVersionHints: string[];
  sourceTitle: string;
  sourcePhraseIndex: SpecificPhraseIndex;
  sourceNormalizedTerms: Set<string>;
  candidateTermFrequency: CandidateTermFrequency;
};

export function buildGraphEdges(input: {
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
}): OkfGraphEdge[] {
  const sourceStrongTerms = listStrongGraphNodeTerms(input.source);
  const candidateStrongTerms = input.candidates.map(listStrongGraphNodeTerms);
  const sourceVersionHints = readContentProfileStringArray(input.source, "versionHints");
  const normalizedBody = normalizeSearchText(stripGeneratedSections(input.body));
  const context: GraphEdgeScoringContext = {
    normalizedBody,
    semanticBody: removeVersionContext(normalizedBody, sourceVersionHints),
    sourceVersionHints,
    sourceTitle: normalizeSearchText(input.source.title),
    sourcePhraseIndex: createSpecificPhraseIndex(sourceStrongTerms),
    sourceNormalizedTerms: normalizedStrongTerms(sourceStrongTerms),
    candidateTermFrequency: createCandidateTermFrequency([
      new Set(sourceStrongTerms.map(normalizeCompactTerm).filter(Boolean)),
      ...candidateStrongTerms.map(
        (terms) => new Set(terms.map(normalizeCompactTerm).filter(Boolean))
      )
    ])
  };
  const suggestedPaths = new Set(
    (input.suggestions?.related_links ?? []).map((link) => normalizePublicPath(link.path))
  );

  return input.candidates
    .map((candidate, index) =>
      bestEdgeForCandidate({
        source: input.source,
        context,
        suggestedPaths,
        candidate,
        candidateStrongTerms: candidateStrongTerms[index] ?? [],
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
  source: OkfGraphNode;
  context: GraphEdgeScoringContext;
  suggestedPaths: Set<string>;
  candidate: OkfGraphNode;
  candidateStrongTerms: string[];
  genericPhraseThreshold: number;
}): OkfGraphEdge | null {
  const { source, context, suggestedPaths, candidate } = input;
  const signals: OkfGraphEdge[] = [];
  const { normalizedBody, semanticBody, sourceVersionHints } = context;
  const candidateVersionHints = readContentProfileStringArray(candidate, "versionHints");
  const sameDocumentTitle =
    context.sourceTitle.length > 0 &&
    context.sourceTitle === normalizeSearchText(candidate.title);
  const hasDistinctVersionEvidence =
    sameDocumentTitle &&
    hasDifferentVersionEvidence(source, candidate, sourceVersionHints, candidateVersionHints);
  const candidateTitle = normalizeSearchText(candidate.title);
  const candidateStem = normalizeSearchText(
    stripMarkdownExtension(candidate.path.split("/").at(-1) ?? candidate.title)
  );
  const candidateNormalizedTerms = normalizedStrongTerms(input.candidateStrongTerms);
  const sharedSubjects = intersectUseful(source.subjects ?? [], candidate.subjects ?? []).filter(
    isSpecificSharedSignal
  );
  const sharedEntities = intersectUseful(source.entities ?? [], candidate.entities ?? []).filter(
    isSpecificSharedSignal
  );
  const sharedKeywords = intersectUseful(source.keywords ?? [], candidate.keywords ?? []).filter(
    isSpecificSharedSignal
  );
  const sharedDefinitions = intersectUseful(
    readContentProfileStringArray(source, "definitions"),
    readContentProfileStringArray(candidate, "definitions")
  ).filter(isSpecificSharedSignal);
  const sharedProcessHints = intersectUseful(
    readContentProfileStringArray(source, "processHints"),
    readContentProfileStringArray(candidate, "processHints")
  ).filter(isSpecificSharedSignal);
  const sharedVersionHints = intersectUseful(sourceVersionHints, candidateVersionHints).filter(
    isSpecificSharedSignal
  );
  const isCorpusSpecific = (term: string) =>
    !context.candidateTermFrequency.isFrequent(term);
  const strongSharedSubjects = sharedSubjects.filter(isStrongContentSignal).filter(isCorpusSpecific);
  const strongSharedEntities = sharedEntities.filter(isStrongContentSignal).filter(isCorpusSpecific);
  const strongSharedKeywords = sharedKeywords.filter(isStrongContentSignal).filter(isCorpusSpecific);
  const strongSharedDefinitions = sharedDefinitions.filter(isStrongContentSignal).filter(isCorpusSpecific);
  const strongSharedProcessHints = sharedProcessHints.filter(isStrongContentSignal).filter(isCorpusSpecific);
  const strongSharedVersionHints = sharedVersionHints.filter(isStrongContentSignal).filter(isCorpusSpecific);
  const titleSupportedSharedSubjects = strongSharedSubjects.filter((term) =>
    isDiscriminativeSharedTitlePhrase(term, source, candidate, input.genericPhraseThreshold)
  );
  const titleSupportedSharedEntities = strongSharedEntities.filter((term) =>
    isDiscriminativeSharedTitlePhrase(term, source, candidate, input.genericPhraseThreshold)
  );
  const sharedKeyPhrases = findSharedSpecificPhrasesFromIndex(
    context.sourcePhraseIndex,
    input.candidateStrongTerms
  ).filter((term) =>
    normalizedBody.includes(normalizeSearchText(term))
  );
  const strongSharedKeyPhrases = compactSharedPhrases(
    sharedKeyPhrases.filter(
      (term) =>
        !isSharedVersionContextTerm(term, sourceVersionHints, candidateVersionHints) &&
        isStrongSharedKeyPhrase(
          term,
          source,
          candidate,
          context.candidateTermFrequency,
          context.sourceNormalizedTerms,
          candidateNormalizedTerms,
          input.genericPhraseThreshold
        )
    )
  );
  const titleSupportedSharedKeyPhrases = strongSharedKeyPhrases.filter((term) =>
    isDiscriminativeSharedTitlePhrase(term, source, candidate, input.genericPhraseThreshold)
  );
  const hasTitleSupportedSharedKeyPhrase = titleSupportedSharedKeyPhrases.length > 0;
  const distinctSharedContentSignalCount = countDistinctSignals([
    ...strongSharedSubjects,
    ...strongSharedEntities,
    ...strongSharedKeywords,
    ...strongSharedKeyPhrases
  ]);
  const hasSuggestedPath = suggestedPaths.has(normalizePublicPath(candidate.path));
  const hasExplicitReference = matchesExplicitReference(source, candidate);
  const hasTitleMention =
    !sameDocumentTitle &&
    ((candidateTitle.length > 0 && semanticBody.includes(candidateTitle)) ||
      (candidateStem.length > 0 && semanticBody.includes(candidateStem)));
  const hasContentOverlap =
    strongSharedSubjects.length > 0 ||
    strongSharedEntities.length > 0 ||
    strongSharedKeyPhrases.length > 0 ||
    hasExplicitReference ||
    hasTitleMention;

  if (hasExplicitReference) {
    signals.push(
      createEdge(source, candidate, "direct_reference", 0.95, "The source explicitly references this file.", {
        targetPath: candidate.path,
        targetTitle: candidate.title,
        signal: "direct_reference"
      })
    );
  }

  if (hasDistinctVersionEvidence) {
    signals.push(
      createEdge(
        source,
        candidate,
        "version_relation",
        0.92,
        "Both files are versions of the same titled document.",
        {
          title: source.title,
          versionHints: uniqueStrings([...sourceVersionHints, ...candidateVersionHints]).slice(0, 8),
          signal: "same_document_title"
        }
      )
    );
  }

  if (hasSuggestedPath && hasContentOverlap) {
    signals.push(
      createEdge(
        source,
        candidate,
        "same_specific_subject",
        0.82,
        "The model selected this existing file path with content evidence.",
        {
          path: candidate.path,
          signal: "same_specific_subject"
        },
        "model_suggested"
      )
    );
  }

  if (hasTitleMention) {
    signals.push(
      createEdge(source, candidate, "direct_reference", 0.7, "The source body mentions the related file title.", {
        title: candidate.title,
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
      createEdge(source, candidate, "same_entity", 0.68, "Both files share body-derived entities and content terms.", {
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
    distinctSharedContentSignalCount >= 2 &&
    (strongSharedSubjects.length >= 2 || strongSharedKeywords.length >= 2)
  ) {
    signals.push(
      createEdge(source, candidate, "same_specific_subject", 0.64, "Both files share body-derived subjects.", {
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
        source,
        candidate,
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
        source,
        candidate,
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
        source,
        candidate,
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
      createEdge(source, candidate, "background", 0.62, "Both files share definitions or background concepts.", {
        definitions: strongSharedDefinitions.slice(0, 8),
        signal: "shared_definition"
      })
    );
  }

  return signals.sort((left, right) => right.weight - left.weight)[0] ?? null;
}

const VERSION_METADATA_KEYS = [
  "version",
  "timestamp",
  "publishedAt",
  "updatedAt",
  "publicationDate",
  "status"
] as const;

function hasDifferentVersionEvidence(
  source: OkfGraphNode,
  candidate: OkfGraphNode,
  sourceHints: string[],
  candidateHints: string[]
): boolean {
  const normalizedSourceHints = normalizeVersionEvidence(sourceHints);
  const normalizedCandidateHints = normalizeVersionEvidence(candidateHints);

  if (
    (normalizedSourceHints.length > 0 || normalizedCandidateHints.length > 0) &&
    normalizedSourceHints.join("\u0000") !== normalizedCandidateHints.join("\u0000")
  ) {
    return true;
  }

  return VERSION_METADATA_KEYS.some((key) => {
    const sourceValue = readVersionMetadataValue(source.metadata, key);
    const candidateValue = readVersionMetadataValue(candidate.metadata, key);
    return Boolean(sourceValue && candidateValue && sourceValue !== candidateValue);
  });
}

function normalizeVersionEvidence(values: string[]): string[] {
  return Array.from(
    new Set(values.map((value) => normalizeSearchText(value)).filter(Boolean))
  ).sort();
}

function readVersionMetadataValue(
  metadata: Record<string, unknown> | undefined,
  key: string
): string {
  const value = metadata?.[key];
  return typeof value === "string" || typeof value === "number"
    ? normalizeSearchText(String(value))
    : "";
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
  source: OkfGraphNode,
  candidate: OkfGraphNode,
  candidateTermFrequency: CandidateTermFrequency,
  sourceTerms: Set<string>,
  candidateTerms: Set<string>,
  genericPhraseThreshold: number
): boolean {
  const normalized = normalizeSearchText(term).replace(/\s+/gu, "");

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

  const sourceTitle = normalizeSearchText(source.title).replace(/\s+/gu, "");
  const candidateTitle = normalizeSearchText(candidate.title).replace(/\s+/gu, "");

  if (sourceTitle.includes(normalized) && candidateTitle.includes(normalized)) {
    return isDiscriminativeSharedTitlePhrase(term, source, candidate, genericPhraseThreshold);
  }

  return normalized.length > genericPhraseThreshold && sourceTerms.has(normalized) && candidateTerms.has(normalized);
}

function normalizeCompactTerm(value: string): string {
  return normalizeSearchText(value).replace(/\s+/gu, "");
}

function isDiscriminativeSharedTitlePhrase(
  value: string,
  source: OkfGraphNode,
  candidate: OkfGraphNode,
  genericPhraseThreshold: number
): boolean {
  const phrase = normalizeSearchText(value).replace(/\s+/gu, "");
  const sourceTitle = normalizeSearchText(source.title).replace(/\s+/gu, "");
  const candidateTitle = normalizeSearchText(candidate.title).replace(/\s+/gu, "");

  if (
    phrase.length < genericPhraseThreshold ||
    !sourceTitle.includes(phrase) ||
    !candidateTitle.includes(phrase)
  ) {
    return false;
  }

  const shorterTitleLength = Math.min(sourceTitle.length, candidateTitle.length);
  const coverage = shorterTitleLength > 0 ? phrase.length / shorterTitleLength : 0;
  return coverage >= 0.65;
}

function compactSharedPhrases(values: string[]): string[] {
  const sorted = [...values].sort((left, right) => {
    const leftLength = normalizeSearchText(left).replace(/\s+/gu, "").length;
    const rightLength = normalizeSearchText(right).replace(/\s+/gu, "").length;

    return rightLength - leftLength || left.localeCompare(right);
  });
  const kept: string[] = [];

  for (const value of sorted) {
    const normalized = normalizeSearchText(value).replace(/\s+/gu, "");

    if (!kept.some((existing) => normalizeSearchText(existing).replace(/\s+/gu, "").includes(normalized))) {
      kept.push(value);
    }
  }

  return kept;
}

function normalizedStrongTerms(terms: string[]): Set<string> {
  return new Set(
    terms
      .map((term) => normalizeSearchText(term).replace(/\s+/gu, ""))
      .filter((term) => term && isStrongContentSignal(term) && !isLowInformationSharedGraphTerm(term))
  );
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

function removeVersionContext(body: string, versionHints: string[]): string {
  let result = body;

  for (const hint of versionHints) {
    const normalizedHint = normalizeSearchText(hint);

    if (normalizedHint) {
      result = result.replaceAll(normalizedHint, " ");
    }
  }

  return result.replace(/\s+/gu, " ").trim();
}

function isSharedVersionContextTerm(
  term: string,
  sourceVersionHints: string[],
  candidateVersionHints: string[]
): boolean {
  const normalizedTerm = normalizeSearchText(term).replace(/\s+/gu, "");

  if (!normalizedTerm) {
    return false;
  }

  const appearsIn = (hints: string[]) =>
    hints.some((hint) =>
      normalizeSearchText(hint).replace(/\s+/gu, "").includes(normalizedTerm)
    );

  return appearsIn(sourceVersionHints) && appearsIn(candidateVersionHints);
}

function uniqueStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function countDistinctSignals(values: string[]): number {
  return new Set(
    values
      .map((value) => normalizeSearchText(value).replace(/\s+/gu, ""))
      .filter(Boolean)
  ).size;
}
